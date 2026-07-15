import { Injectable, Inject, Logger, OnModuleInit, OnApplicationBootstrap } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Model } from 'mongoose';
import axios, { AxiosResponse } from 'axios';
import Redis from 'ioredis';
import {
  Earthquake,
  EarthquakeDocument,
  EarthquakeEvent,
} from './schemas/earthquake.schema';
import { EarthquakeGateway } from './gateways/earthquake.gateway';
import { MqttService } from '../common/services/mqtt.service';
import { DRAGONFLY_APP_CLIENT } from '../common/providers/dragonfly-app-data.provider';
import {
  EarthquakeQueryDto,
  EarthquakeResponseDto,
  PaginatedEarthquakeResponseDto,
} from './dto/earthquake.dto';

interface USGSFeature {
  type: string;
  properties: {
    mag: number;
    place: string;
    time: number;
    updated: number;
    tz: number;
    url: string;
    detail: string;
    felt: number | null;
    cdi: number | null;
    mmi: number | null;
    alert: string | null;
    status: string;
    tsunami: number;
    sig: number;
    net: string;
    code: string;
    ids: string;
    sources: string;
    types: string;
    nst: number | null;
    dmin: number | null;
    rms: number;
    gap: number | null;
    magType: string;
    type: string;
    title: string;
  };
  geometry: {
    type: string;
    coordinates: [number, number, number];
  };
  id: string;
}

interface USGSResponse {
  type: string;
  metadata: any;
  features: USGSFeature[];
  bbox: number[];
}

interface CacheStats {
  hits: number;
  misses: number;
  errors: number;
  lastErrorAt: number | null;
  lastSuccessAt: number | null;
}

@Injectable()
export class EarthquakeService implements OnModuleInit, OnApplicationBootstrap {
  private readonly logger = new Logger(EarthquakeService.name);
  private lastFetchTime: Date = new Date();
  private readonly minMagnitudeAlert: number;
  private readonly maxRecordsInMemory: number;
  private readonly earthquakeDataTtlSeconds: number;
  private readonly searchCacheTtlSeconds: number;
  private readonly warmerIntervalMs: number;
  private readonly warmerLookbackMs: number;

  // ZSET key now stores WRITTEN-at timestamps (not earthquake time) so
  // that a `zremrangebyscore` cleanup based on age is correct and
  // doesn't accidentally evict entries that simply happened in the
  // past (e.g. from the significant_month feed).
  private readonly ZSET_KEY = 'eq:ids:bytime';
  private readonly DATA_KEY_PREFIX = 'eq:data:';

  // Bounded cache stats so we can see in /health whether Dragonfly is
  // actually serving traffic or silently bypassed every call.
  private readonly stats: CacheStats = {
    hits: 0,
    misses: 0,
    errors: 0,
    lastErrorAt: null,
    lastSuccessAt: null,
  };
  // Coalesce concurrent warmer runs to avoid dog-piling when a fetch
  // job lands on top of a still-running warm.
  private warmerInFlight = false;

  constructor(
    @InjectModel(Earthquake.name)
    private earthquakeModel: Model<EarthquakeDocument>,
    private configService: ConfigService,
    private earthquakeGateway: EarthquakeGateway,
    private mqttService: MqttService,
    @Inject(DRAGONFLY_APP_CLIENT) private readonly dragonfly: Redis,
  ) {
    this.minMagnitudeAlert = this.configService.get<number>(
      'app.earthquake.minMagnitudeAlert',
      4.0,
    );
    this.maxRecordsInMemory = this.configService.get<number>(
      'app.dataRetention.maxRecordsInMemory',
      5000,
    );
    this.earthquakeDataTtlSeconds = this.configService.get<number>(
      'app.dataRetention.earthquakeDataTtlSeconds',
      86400,
    );
    this.searchCacheTtlSeconds = this.configService.get<number>(
      'app.dataRetention.searchCacheTtlSeconds',
      300,
    );
    this.warmerIntervalMs = this.configService.get<number>(
      'app.dataRetention.warmerIntervalMs',
      5 * 60 * 1000,
    );
    this.warmerLookbackMs = this.configService.get<number>(
      'app.dataRetention.warmerLookbackMs',
      24 * 60 * 60 * 1000,
    );
  }

  async onModuleInit(): Promise<void> {
    this.logger.log('Earthquake service initialized');
  }

  /**
   * On boot: warm Dragonfly from MongoDB (last 24h). Best-effort; never
   * throws. If Dragonfly is unreachable we just continue — every read
   * path falls back to MongoDB anyway.
   */
  async onApplicationBootstrap(): Promise<void> {
    // Give the rest of the app a moment to settle so we don't compete
    // with the first scheduled fetch.
    setTimeout(() => {
      this.warmCacheFromMongo().catch((e) =>
        this.logger.warn(`Initial cache warm failed: ${e?.message ?? e}`),
      );
    }, 3000);
  }

  // -------- Cache observability --------

  getCacheStats(): CacheStats & { hitRatio: number } {
    const total = this.stats.hits + this.stats.misses;
    return {
      ...this.stats,
      hitRatio: total > 0 ? this.stats.hits / total : 0,
    };
  }

  private recordHit() {
    this.stats.hits++;
    this.stats.lastSuccessAt = Date.now();
  }
  private recordMiss(reason: 'empty' | 'incomplete' | 'filtered') {
    this.stats.misses++;
    this.stats.lastSuccessAt = Date.now();
    if (reason === 'incomplete') {
      this.logger.debug(
        'Dragonfly cache incomplete (ZSET has IDs whose data keys are gone); falling back to MongoDB',
      );
    }
  }
  private recordError(op: string, e: any) {
    this.stats.errors++;
    this.stats.lastErrorAt = Date.now();
    this.logger.warn(`Dragonfly ${op} failed (fail-fast fallback): ${e?.message ?? e}`);
  }

  // -------- Dragonfly ops (all bounded by the safe client) --------

  private async saveToDragonfly(earthquake: EarthquakeEvent): Promise<void> {
    const pipeline = this.dragonfly.pipeline();
    const dataKey = `${this.DATA_KEY_PREFIX}${earthquake.id}`;
    const writeScore = Date.now(); // <-- changed: score = write time
    pipeline.set(
      dataKey,
      JSON.stringify(earthquake),
      'EX',
      this.earthquakeDataTtlSeconds,
    );
    pipeline.zadd(this.ZSET_KEY, writeScore, earthquake.id);
    // Hard cap on the ZSET size so a long-running instance can never
    // let the index grow unbounded (defense in depth; the periodic
    // cleanup also enforces a cap).
    pipeline.zremrangebyrank(
      this.ZSET_KEY,
      0,
      -(this.maxRecordsInMemory + 1),
    );
    await pipeline.exec();
  }

  /**
   * Cleanup of stale ZSET entries — only ones whose data key has actually
   * expired (lazy, exact) and ones whose write-time is older than 2x
   * the data TTL (defensive cap in case a data key was lost on
   * snapshot-restore, etc.). This never deletes entries based on the
   * earthquake's own timestamp, so a 30-day-old quake from the
   * `significant_month` feed stays in the cache for its full TTL.
   */
  @Cron(CronExpression.EVERY_10_MINUTES)
  async cleanupStaleData(): Promise<void> {
    if (this.dragonfly.status !== 'ready') {
      this.logger.debug('Skipping ZSET cleanup — Dragonfly not ready');
      return;
    }
    try {
      // 1. Hard cap: anything written more than 2x TTL ago is fair game.
      const writeCutoff = Date.now() - 2 * this.earthquakeDataTtlSeconds * 1000;
      const capped = await this.dragonfly.zremrangebyscore(
        this.ZSET_KEY,
        '-inf',
        writeCutoff,
      );
      if (capped > 0) {
        this.logger.log(
          `Cleanup: removed ${capped} ZSET entries older than 2x TTL`,
        );
      }

      // 2. Lazy: drop any ZSET entry whose data key is missing. This is
      // the safe cleanup — it never deletes "fresh-looking" data.
      const allIds = await this.dragonfly.zrange(this.ZSET_KEY, 0, -1);
      if (allIds.length > 0) {
        const keys = allIds.map((id) => `${this.DATA_KEY_PREFIX}${id}`);
        // Chunk the EXISTS to avoid building a single huge command.
        const CHUNK = 200;
        let lazyRemoved = 0;
        for (let i = 0; i < keys.length; i += CHUNK) {
          const slice = keys.slice(i, i + CHUNK);
          const flags = await this.dragonfly.exists(...slice);
          // ioredis returns a number (count of existing keys) for a
          // single key, or an array (per-key 0/1) for multiple keys.
          // Normalize to a number[] of per-key existence.
          const arr: number[] = Array.isArray(flags)
            ? (flags as number[])
            : [Number(flags)];
          for (let j = 0; j < arr.length; j++) {
            if (arr[j] === 0) {
              const id = allIds[i + j];
              if (id) {
                await this.dragonfly.zrem(this.ZSET_KEY, id);
                lazyRemoved++;
              }
            }
          }
        }
        if (lazyRemoved > 0) {
          this.logger.log(
            `Cleanup: lazy-removed ${lazyRemoved} ZSET entries with no data key`,
          );
        }
      }
    } catch (error) {
      this.recordError('cleanupStaleData', error);
    }
  }

  // -------- Periodic warmer: re-sync MongoDB → Dragonfly --------
  // This is the safety net that fixes "after a while no data": even if
  // every fetch miss writes failed (e.g. Dragonfly was down for an
  // hour, or the cleanup removed the wrong rows under the old logic),
  // this cron refills the cache from the source of truth.

  @Cron(CronExpression.EVERY_5_MINUTES)
  async scheduledWarm(): Promise<void> {
    await this.warmCacheFromMongo().catch((e) =>
      this.logger.warn(`Scheduled warm failed: ${e?.message ?? e}`),
    );
  }

  async warmCacheFromMongo(): Promise<void> {
    if (this.warmerInFlight) {
      this.logger.debug('Warmer already running, skipping');
      return;
    }
    if (this.dragonfly.status !== 'ready') {
      this.logger.debug('Skipping warm — Dragonfly not ready');
      return;
    }
    this.warmerInFlight = true;
    const start = Date.now();
    try {
      const since = new Date(Date.now() - this.warmerLookbackMs);
      const cursor = this.earthquakeModel
        .find({ 'properties.time': { $gte: since.getTime() } })
        .sort({ 'properties.time': -1 })
        .limit(this.maxRecordsInMemory)
        .lean();

      let written = 0;
      let skipped = 0;
      const batch: Promise<unknown>[] = [];
      let batchCount = 0;
      const BATCH = 200;

      for await (const doc of cursor) {
        const event = this.docToEvent(doc);
        // Pipeline: SET with TTL + ZADD with write-time score
        const pipeline = this.dragonfly.pipeline();
        pipeline.set(
          `${this.DATA_KEY_PREFIX}${event.id}`,
          JSON.stringify(event),
          'EX',
          this.earthquakeDataTtlSeconds,
        );
        pipeline.zadd(this.ZSET_KEY, Date.now(), event.id);
        batch.push(pipeline.exec());
        batchCount++;
        written++;
        if (batch.length >= BATCH) {
          await Promise.allSettled(batch.splice(0, batch.length));
        }
      }
      if (batch.length) {
        await Promise.allSettled(batch);
      }
      // Re-cap the ZSET to the configured size.
      await this.dragonfly.zremrangebyrank(
        this.ZSET_KEY,
        0,
        -(this.maxRecordsInMemory + 1),
      );
      this.logger.log(
        `Warmer: ${written} written, ${skipped} skipped, took ${Date.now() - start}ms`,
      );
    } catch (e) {
      this.recordError('warmCacheFromMongo', e);
    } finally {
      this.warmerInFlight = false;
    }
  }

  // -------- USAGE --------

  async fetchAndProcess(
    feedType: string = 'all_hour',
  ): Promise<EarthquakeEvent[]> {
    try {
      const url = `https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/${feedType}.geojson`;
      this.logger.debug(`Fetching earthquake data from USGS API: ${url}`);

      const response: AxiosResponse<USGSResponse> = await axios.get(url, {
        timeout: 10000,
        headers: { 'User-Agent': 'EarthquakeAlertSystem/1.0' },
      });

      if (response.status !== 200) {
        throw new Error(`API returned status ${response.status}`);
      }

      const earthquakeData = response.data.features;
      const newEarthquakes = await this.saveEarthquakeData(earthquakeData);

      this.lastFetchTime = new Date();
      if (newEarthquakes.length > 0) {
        this.logger.debug(
          `Processed ${earthquakeData.length} earthquake records. New: ${newEarthquakes.length}`,
        );
      }

      this.earthquakeGateway.broadcastServerStatus({
        isConnected: true,
        lastUpdate: this.lastFetchTime,
      });

      return newEarthquakes;
    } catch (error) {
      this.logger.error('Error fetching earthquake data:', error);
      this.earthquakeGateway.broadcastServerStatus({
        isConnected: false,
        lastUpdate: this.lastFetchTime,
      });
      throw error;
    }
  }

  private async saveEarthquakeData(
    data: USGSFeature[],
  ): Promise<EarthquakeEvent[]> {
    const newEarthquakes: EarthquakeEvent[] = [];
    const updatedEarthquakes: EarthquakeEvent[] = [];

    for (const earthquake of data) {
      try {
        const existingRecord = await this.earthquakeModel.findOne({
          id: earthquake.id,
        });

        if (!existingRecord) {
          this.logger.log(
            `New earthquake found: ${earthquake.id} (${earthquake.properties.mag}M at ${earthquake.properties.place})`,
          );

          const newEarthquake = new this.earthquakeModel({
            ...earthquake,
            processed: false,
            notificationSent: false,
          });

          const earthquakeEvent: EarthquakeEvent =
            this.transformToEarthquakeEvent(earthquake);

          const [mongoResult, dragonflyResult] = await Promise.allSettled([
            newEarthquake.save(),
            this.saveToDragonfly(earthquakeEvent),
          ]);

          if (mongoResult.status === 'rejected') {
            this.logger.error(
              `MongoDB save failed for earthquake ${earthquake.id}:`,
              mongoResult.reason,
            );
            throw mongoResult.reason;
          }

          if (dragonflyResult.status === 'rejected') {
            this.recordError(
              `saveToDragonfly(new) ${earthquake.id}`,
              dragonflyResult.reason,
            );
          }

          newEarthquakes.push(earthquakeEvent);
        } else {
          const lastUpdate = existingRecord.properties.updated || 0;
          const currentUpdate = earthquake.properties.updated || 0;

          if (currentUpdate > lastUpdate) {
            this.logger.log(
              `Updating earthquake: ${earthquake.id} (Mag: ${existingRecord.properties.mag} -> ${earthquake.properties.mag})`,
            );

            existingRecord.properties = earthquake.properties;
            existingRecord.geometry = earthquake.geometry;

            const earthquakeEvent: EarthquakeEvent =
              this.transformToEarthquakeEvent(earthquake);

            const [mongoResult, dragonflyResult] = await Promise.allSettled([
              existingRecord.save(),
              this.saveToDragonfly(earthquakeEvent),
            ]);

            if (mongoResult.status === 'rejected') {
              this.logger.error(
                `MongoDB update failed for earthquake ${earthquake.id}:`,
                mongoResult.reason,
              );
              throw mongoResult.reason;
            }

            if (dragonflyResult.status === 'rejected') {
              this.recordError(
                `saveToDragonfly(update) ${earthquake.id}`,
                dragonflyResult.reason,
              );
            }

            updatedEarthquakes.push(earthquakeEvent);
          }
        }
      } catch (error) {
        this.logger.error(
          `Error saving/updating earthquake ${earthquake.id}:`,
          error,
        );
      }
    }

    for (const earthquake of newEarthquakes) {
      this.earthquakeGateway.broadcastNewEarthquake(earthquake);
      this.mqttService
        .publishEarthquakeAlert(earthquake)
        .catch((err) =>
          this.logger.error(
            `Failed to publish new earthquake ${earthquake.id} to MQTT`,
            err,
          ),
        );
    }

    for (const earthquake of updatedEarthquakes) {
      this.earthquakeGateway.broadcastNewEarthquake(earthquake);
      this.mqttService
        .publishEarthquakeAlert(earthquake)
        .catch((err) =>
          this.logger.error(
            `Failed to publish updated earthquake ${earthquake.id} to MQTT`,
            err,
          ),
        );
    }

    return [...newEarthquakes, ...updatedEarthquakes];
  }

  private transformToEarthquakeEvent(feature: USGSFeature): EarthquakeEvent {
    return {
      id: feature.id,
      magnitude: feature.properties.mag,
      location: {
        latitude: feature.geometry.coordinates[1],
        longitude: feature.geometry.coordinates[0],
        place: feature.properties.place,
      },
      depth: feature.geometry.coordinates[2],
      timestamp: new Date(feature.properties.time),
      url: feature.properties.url,
      alert: feature.properties.alert,
      tsunami: feature.properties.tsunami,
      processed: false,
      notificationSent: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  private docToEvent(doc: any): EarthquakeEvent {
    return {
      id: doc.id,
      magnitude: doc.properties?.mag ?? 0,
      location: {
        latitude: doc.geometry?.coordinates?.[1] ?? 0,
        longitude: doc.geometry?.coordinates?.[0] ?? 0,
        place: doc.properties?.place ?? '',
      },
      depth: doc.geometry?.coordinates?.[2] ?? 0,
      timestamp: new Date(doc.properties?.time ?? Date.now()),
      url: doc.properties?.url ?? '',
      alert: doc.properties?.alert ?? null,
      tsunami: doc.properties?.tsunami ?? 0,
      processed: !!doc.processed,
      notificationSent: !!doc.notificationSent,
      createdAt: doc.createdAt ? new Date(doc.createdAt) : new Date(),
      updatedAt: doc.updatedAt ? new Date(doc.updatedAt) : new Date(),
    };
  }

  // -------- Read paths --------

  async findAll(query: EarthquakeQueryDto): Promise<EarthquakeResponseDto[]> {
    const isSimpleQuery =
      !query.location &&
      !query.minMagnitude &&
      !query.startDate &&
      !query.endDate &&
      (!query.limit || query.limit <= 100);

    if (isSimpleQuery) {
      try {
        const limit = query.limit || 100;
        const offset = query.offset || 0;

        const ids = await this.dragonfly.zrevrange(
          this.ZSET_KEY,
          offset,
          offset + limit - 1,
        );

        if (ids && ids.length > 0) {
          const dataKeys = ids.map((id) => `${this.DATA_KEY_PREFIX}${id}`);
          const dataResults = await this.dragonfly.mget(...dataKeys);
          const validData = (dataResults ?? [])
            .filter((item): item is string => !!item)
            .map((item) => JSON.parse(item));

          if (validData.length === ids.length) {
            this.recordHit();
            return validData;
          }
          this.recordMiss('incomplete');
        } else {
          this.recordMiss('empty');
        }
      } catch (e) {
        this.recordError('findAll', e);
      }
    } else {
      this.recordMiss('filtered');
    }

    // Fallback to MongoDB
    return this.findAllFromMongo(query);
  }

  private async findAllFromMongo(
    query: EarthquakeQueryDto,
  ): Promise<EarthquakeResponseDto[]> {
    const filter: any = {};

    if (query.minMagnitude !== undefined) {
      filter['properties.mag'] = {
        ...filter['properties.mag'],
        $gte: query.minMagnitude,
      };
    }

    if (query.maxMagnitude !== undefined) {
      filter['properties.mag'] = {
        ...filter['properties.mag'],
        $lte: query.maxMagnitude,
      };
    }

    if (query.location) {
      filter['properties.place'] = { $regex: query.location, $options: 'i' };
    }

    if (query.startDate) {
      filter['properties.time'] = {
        ...filter['properties.time'],
        $gte: new Date(query.startDate).getTime(),
      };
    }

    if (query.endDate) {
      filter['properties.time'] = {
        ...filter['properties.time'],
        $lte: new Date(query.endDate).getTime(),
      };
    }

    if (query.processed !== undefined) {
      filter.processed = query.processed;
    }

    if (query.notificationSent !== undefined) {
      filter.notificationSent = query.notificationSent;
    }

    const limit = query.limit || 100;
    const offset = query.offset || 0;

    const earthquakes = await this.earthquakeModel
      .find(filter)
      .sort({ 'properties.time': -1 })
      .limit(limit)
      .skip(offset);

    return earthquakes.map((earthquake) => ({
      id: earthquake.id,
      magnitude: earthquake.properties.mag,
      location: {
        latitude: earthquake.geometry.coordinates[1],
        longitude: earthquake.geometry.coordinates[0],
        place: earthquake.properties.place,
      },
      depth: earthquake.geometry.coordinates[2],
      timestamp: new Date(earthquake.properties.time),
      url: earthquake.properties.url,
      alert: earthquake.properties.alert,
      tsunami: earthquake.properties.tsunami,
      processed: earthquake.processed,
      notificationSent: earthquake.notificationSent,
      createdAt: (earthquake as any).createdAt || new Date(),
      updatedAt: (earthquake as any).updatedAt || new Date(),
    }));
  }

  async search(
    query: EarthquakeQueryDto,
  ): Promise<PaginatedEarthquakeResponseDto> {
    const page = query.offset
      ? Math.floor(query.offset / (query.limit || 20)) + 1
      : query.page || 1;
    const limit = query.limit || 20;
    const skip = (page - 1) * limit;

    // Stable cache key: sort keys so {a:1,b:2} and {b:2,a:1} hit the
    // same cache entry. Skip undefined values to keep keys short.
    const cacheKey = this.buildSearchCacheKey(query);

    try {
      const cached = await this.dragonfly.get(cacheKey);
      if (cached) {
        this.recordHit();
        return JSON.parse(cached);
      }
      this.recordMiss('filtered');
    } catch (e) {
      this.recordError('search.get', e);
    }

    // Build MongoDB Query
    const filter: any = {};

    if (query.q) {
      filter['properties.place'] = { $regex: query.q, $options: 'i' };
    }

    if (query.location) {
      filter['properties.place'] = { $regex: query.location, $options: 'i' };
    }

    if (query.minMagnitude !== undefined) {
      filter['properties.mag'] = {
        ...filter['properties.mag'],
        $gte: query.minMagnitude,
      };
    }

    if (query.maxMagnitude !== undefined) {
      filter['properties.mag'] = {
        ...filter['properties.mag'],
        $lte: query.maxMagnitude,
      };
    }

    if (query.minDepth !== undefined) {
      filter['geometry.coordinates.2'] = {
        ...filter['geometry.coordinates.2'],
        $gte: query.minDepth,
      };
    }

    if (query.maxDepth !== undefined) {
      filter['geometry.coordinates.2'] = {
        ...filter['geometry.coordinates.2'],
        $lte: query.maxDepth,
      };
    }

    if (query.startDate) {
      filter['properties.time'] = {
        ...filter['properties.time'],
        $gte: new Date(query.startDate).getTime(),
      };
    }

    if (query.endDate) {
      filter['properties.time'] = {
        ...filter['properties.time'],
        $lte: new Date(query.endDate).getTime(),
      };
    }

    const sort: any = {};
    if (query.sortBy) {
      const direction = query.order === 'asc' ? 1 : -1;
      switch (query.sortBy) {
        case 'magnitude':
          sort['properties.mag'] = direction;
          break;
        case 'depth':
          sort['geometry.coordinates.2'] = direction;
          break;
        case 'time':
        default:
          sort['properties.time'] = direction;
      }
    } else {
      sort['properties.time'] = -1;
    }

    const [earthquakes, total] = await Promise.all([
      this.earthquakeModel.find(filter).sort(sort).skip(skip).limit(limit),
      this.earthquakeModel.countDocuments(filter),
    ]);

    const result: PaginatedEarthquakeResponseDto = {
      data: earthquakes.map((earthquake) => ({
        id: earthquake.id,
        magnitude: earthquake.properties.mag,
        location: {
          latitude: earthquake.geometry.coordinates[1],
          longitude: earthquake.geometry.coordinates[0],
          place: earthquake.properties.place,
        },
        depth: earthquake.geometry.coordinates[2],
        timestamp: new Date(earthquake.properties.time),
        url: earthquake.properties.url,
        alert: earthquake.properties.alert,
        tsunami: earthquake.properties.tsunami,
        processed: earthquake.processed,
        notificationSent: earthquake.notificationSent,
        createdAt: (earthquake as any).createdAt || new Date(),
        updatedAt: (earthquake as any).updatedAt || new Date(),
      })),
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };

    try {
      await this.dragonfly.set(
        cacheKey,
        JSON.stringify(result),
        'EX',
        this.searchCacheTtlSeconds,
      );
    } catch (e) {
      this.recordError('search.set', e);
    }

    return result;
  }

  private buildSearchCacheKey(query: EarthquakeQueryDto): string {
    const keys = Object.keys(query)
      .filter((k) => query[k as keyof EarthquakeQueryDto] !== undefined)
      .sort();
    const norm: Record<string, unknown> = {};
    for (const k of keys) {
      norm[k] = query[k as keyof EarthquakeQueryDto];
    }
    return `search:${JSON.stringify(norm)}`;
  }

  async processEarthquakeAlert(earthquake: EarthquakeEvent): Promise<void> {
    try {
      await this.mqttService.publishEarthquakeAlert(earthquake);
      await this.earthquakeModel.updateOne(
        { id: earthquake.id },
        { notificationSent: true },
      );
      earthquake.notificationSent = true;
      try {
        await this.dragonfly.set(
          `${this.DATA_KEY_PREFIX}${earthquake.id}`,
          JSON.stringify(earthquake),
          'EX',
          this.earthquakeDataTtlSeconds,
        );
      } catch (e) {
        this.recordError('processEarthquakeAlert.set', e);
      }
      this.logger.log(
        `Alert sent for earthquake ${earthquake.id} (${earthquake.magnitude}M)`,
      );
    } catch (error) {
      this.logger.error(`Failed to process alert for ${earthquake.id}`, error);
      throw error;
    }
  }

  async getStatistics(): Promise<any> {
    const total = await this.earthquakeModel.countDocuments();
    const last24Hours = await this.earthquakeModel.countDocuments({
      'properties.time': { $gte: Date.now() - 24 * 60 * 60 * 1000 },
    });
    const significantEarthquakes = await this.earthquakeModel.countDocuments({
      'properties.mag': { $gte: this.minMagnitudeAlert },
    });

    return {
      total,
      last24Hours,
      significantEarthquakes,
      lastFetchTime: this.lastFetchTime,
      connectedClients: this.earthquakeGateway.getConnectedClientsCount(),
      mqttConnected: this.mqttService.isConnected(),
      cache: this.getCacheStats(),
    };
  }

  /**
   * Health check that ACTUALLY exercises Dragonfly with a PING (with
   * timeout) instead of just trusting the cached `status === 'ready'`
   * flag. The old version could report "connected" while the server
   * was down — the worker would then try to write and hang.
   */
  async getHealthCheck(): Promise<{ status: string; details: any }> {
    const details: any = {
      database: 'connected',
      dragonfly: 'disconnected',
      dragonflyLatencyMs: null as number | null,
      mqtt: this.mqttService.isConnected() ? 'connected' : 'disconnected',
      lastFetch: this.lastFetchTime,
      connectedClients: this.earthquakeGateway.getConnectedClientsCount(),
      cache: this.getCacheStats(),
    };

    // Real PING with timeout — can't be longer than commandTimeout.
    try {
      const t0 = Date.now();
      const pong = await this.dragonfly.ping();
      const dt = Date.now() - t0;
      if (pong === 'PONG' || pong === 'PONG ' || pong === 'PONG\r' || /PONG/i.test(String(pong))) {
        details.dragonfly = 'connected';
        details.dragonflyLatencyMs = dt;
      } else {
        details.dragonfly = 'unexpected-reply:' + pong;
      }
    } catch (e) {
      details.dragonfly = 'unreachable';
      details.dragonflyError = (e as Error)?.message ?? String(e);
    }

    const status =
      details.dragonfly === 'connected' && details.mqtt === 'connected'
        ? 'healthy'
        : 'degraded';
    return { status, details };
  }
}
