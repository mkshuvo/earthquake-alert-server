import { Injectable, Inject, Logger, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
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
import { DRAGONFLY_CLIENT } from '../common/providers/dragonfly.provider';
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

@Injectable()
export class EarthquakeService implements OnModuleInit {
  private readonly logger = new Logger('EarthquakeService');
  private lastFetchTime: Date = new Date();
  private readonly minMagnitudeAlert: number;
  private readonly maxRecordsInMemory: number;
  private readonly earthquakeDataTtlSeconds: number;
  private readonly searchCacheTtlSeconds: number;

  constructor(
    @InjectModel(Earthquake.name)
    private earthquakeModel: Model<EarthquakeDocument>,
    private configService: ConfigService,
    private earthquakeGateway: EarthquakeGateway,
    private mqttService: MqttService,
    @Inject(DRAGONFLY_CLIENT) private readonly dragonfly: Redis,
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
  }

  async onModuleInit(): Promise<void> {
    this.logger.log('Earthquake service initialized');
  }

  // Public method for Workers to call
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

          // PARALLEL WRITE to MongoDB and Dragonfly using Promise.allSettled
          const [mongoResult, dragonflyResult] = await Promise.allSettled([
            newEarthquake.save(),
            this.saveToDragonfly(earthquakeEvent),
          ]);

          // Check MongoDB result
          if (mongoResult.status === 'rejected') {
            this.logger.error(
              `MongoDB save failed for earthquake ${earthquake.id}:`,
              mongoResult.reason,
            );
            throw mongoResult.reason; // Critical: don't continue if MongoDB fails
          }

          // Check Dragonfly result (non-critical, log but continue)
          if (dragonflyResult.status === 'rejected') {
            this.logger.warn(
              `Dragonfly save failed for earthquake ${earthquake.id} (MongoDB succeeded):`,
              dragonflyResult.reason,
            );
          } else {
            this.logger.debug(
              `Successfully saved earthquake ${earthquake.id} to both MongoDB and Dragonfly`,
            );
          }

          newEarthquakes.push(earthquakeEvent);
        } else {
          // Check for updates based on 'updated' timestamp from USGS
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

            // PARALLEL UPDATE to MongoDB and Dragonfly
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
              this.logger.warn(
                `Dragonfly update failed for earthquake ${earthquake.id}:`,
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

    // Broadcast new earthquakes via WebSocket
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

    // Broadcast updated earthquakes
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

  /**
   * Save earthquake to Dragonfly with per-key TTL and sorted set trimming.
   * Uses individual keys (eq:data:{id}) instead of a hash so each entry
   * can have its own TTL for automatic RAM cleanup.
   */
  private async saveToDragonfly(earthquake: EarthquakeEvent): Promise<void> {
    const pipeline = this.dragonfly.pipeline();
    const dataKey = `eq:data:${earthquake.id}`;

    // 1. Store full data with TTL (auto-expires after configured duration)
    pipeline.set(
      dataKey,
      JSON.stringify(earthquake),
      'EX',
      this.earthquakeDataTtlSeconds,
    );

    // 2. Add ID to sorted set with timestamp as score
    pipeline.zadd(
      'eq:ids:bytime',
      earthquake.timestamp.getTime(),
      earthquake.id,
    );

    // 3. Trim sorted set to max records (remove oldest beyond limit)
    pipeline.zremrangebyrank(
      'eq:ids:bytime',
      0,
      -(this.maxRecordsInMemory + 1),
    );

    await pipeline.exec();
  }

  /**
   * Periodic cleanup of stale sorted set entries whose data keys have expired.
   * Runs every 10 minutes to keep the sorted set in sync with actual data.
   */
  @Cron('*/10 * * * *')
  async cleanupStaleData(): Promise<void> {
    try {
      const cutoff = Date.now() - this.earthquakeDataTtlSeconds * 1000;
      const removed = await this.dragonfly.zremrangebyscore(
        'eq:ids:bytime',
        '-inf',
        cutoff,
      );
      if (removed > 0) {
        this.logger.log(
          `Cleanup: removed ${removed} expired entries from sorted set`,
        );
      }
    } catch (error) {
      this.logger.warn('Cleanup cron failed:', error);
    }
  }

  // Modified findAll to use Dragonfly first with per-key data structure
  async findAll(query: EarthquakeQueryDto): Promise<EarthquakeResponseDto[]> {
    // Optimization: If query is simple (latest 100, no complex filters), use Dragonfly
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

        // Get IDs from sorted set (newest first)
        const ids = await this.dragonfly.zrevrange(
          'eq:ids:bytime',
          offset,
          offset + limit - 1,
        );

        if (ids && ids.length > 0) {
          // Fetch full data from individual keys using MGET
          const dataKeys = ids.map((id) => `eq:data:${id}`);
          const dataResults = await this.dragonfly.mget(...dataKeys);
          const validData = dataResults
            .filter((item): item is string => item !== null)
            .map((item) => JSON.parse(item));

          if (validData.length === ids.length) {
            return validData;
          }
          this.logger.warn(
            `Dragonfly data incomplete: ${validData.length}/${ids.length} records found, falling back to MongoDB`,
          );
        }
        this.logger.debug(
          'Dragonfly empty or incomplete, falling back to MongoDB',
        );
      } catch (e) {
        this.logger.warn('Dragonfly read failed, falling back to MongoDB', e);
      }
    }

    // Fallback to MongoDB (existing logic)
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

    // Generate Cache Key
    const cacheKey = `search:${JSON.stringify(query)}`;

    // Try Dragonfly Cache
    try {
      const cachedResult = await this.dragonfly.get(cacheKey);
      if (cachedResult) {
        this.logger.debug(`Cache hit for search: ${cacheKey}`);
        return JSON.parse(cachedResult);
      }
    } catch (e) {
      this.logger.warn('Dragonfly cache read failed', e);
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

    // Sorting
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
      sort['properties.time'] = -1; // Default to newest
    }

    // Execute Query
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

    // Cache Result with configurable TTL
    try {
      await this.dragonfly.set(
        cacheKey,
        JSON.stringify(result),
        'EX',
        this.searchCacheTtlSeconds,
      );
    } catch (e) {
      this.logger.warn('Dragonfly cache write failed', e);
    }

    return result;
  }

  async processEarthquakeAlert(earthquake: EarthquakeEvent): Promise<void> {
    try {
      // Publish to MQTT for mobile devices
      await this.mqttService.publishEarthquakeAlert(earthquake);

      // Mark as notification sent in MongoDB
      await this.earthquakeModel.updateOne(
        { id: earthquake.id },
        { notificationSent: true },
      );

      // Update Dragonfly - use individual key with TTL refresh
      earthquake.notificationSent = true;
      const dataKey = `eq:data:${earthquake.id}`;
      await this.dragonfly.set(
        dataKey,
        JSON.stringify(earthquake),
        'EX',
        this.earthquakeDataTtlSeconds,
      );

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
    };
  }

  async getHealthCheck(): Promise<{ status: string; details: any }> {
    const details = {
      database: 'connected', // Mongoose maintains connection
      dragonfly:
        this.dragonfly.status === 'ready' ? 'connected' : 'disconnected',
      mqtt: this.mqttService.isConnected() ? 'connected' : 'disconnected',
      lastFetch: this.lastFetchTime,
      connectedClients: this.earthquakeGateway.getConnectedClientsCount(),
    };

    const status = Object.values(details).every(
      (val) =>
        val === 'connected' || typeof val === 'number' || val instanceof Date,
    )
      ? 'healthy'
      : 'unhealthy';

    return { status, details };
  }
}
