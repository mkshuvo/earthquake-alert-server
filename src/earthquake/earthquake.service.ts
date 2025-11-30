import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';
import { Model } from 'mongoose';
import axios, { AxiosResponse } from 'axios';
import Redis from 'ioredis';
import { Earthquake, EarthquakeDocument, EarthquakeEvent } from './schemas/earthquake.schema';
import { EarthquakeGateway } from './gateways/earthquake.gateway';
import { MqttService } from '../common/services/mqtt.service';
import { EarthquakeQueryDto, EarthquakeResponseDto } from './dto/earthquake.dto';

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
  private redis: Redis;
  private readonly logger = new Logger('EarthquakeService');
  private lastFetchTime: Date = new Date();
  private readonly minMagnitudeAlert: number;

  constructor(
    @InjectModel(Earthquake.name)
    private earthquakeModel: Model<EarthquakeDocument>,
    private configService: ConfigService,
    private earthquakeGateway: EarthquakeGateway,
    private mqttService: MqttService,
  ) {
    this.minMagnitudeAlert = this.configService.get<number>('app.earthquake.minMagnitudeAlert', 4.0);
    
    // Initialize Redis
    this.redis = new Redis({
      host: this.configService.get<string>('app.redis.host', 'localhost'),
      port: this.configService.get<number>('app.redis.port', 6379),
    });
  }

  async onModuleInit(): Promise<void> {
    this.logger.log('Earthquake service initialized');
  }

  // Public method for Workers to call
  async fetchAndProcess(feedType: string = 'all_hour'): Promise<EarthquakeEvent[]> {
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
          this.logger.debug(`Processed ${earthquakeData.length} earthquake records. New: ${newEarthquakes.length}`);
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

  private async saveEarthquakeData(data: USGSFeature[]): Promise<EarthquakeEvent[]> {
    const newEarthquakes: EarthquakeEvent[] = [];
    const updatedEarthquakes: EarthquakeEvent[] = [];

    for (const earthquake of data) {
      try {
        const existingRecord = await this.earthquakeModel.findOne({
          id: earthquake.id,
        });

        if (!existingRecord) {
          this.logger.log(`New earthquake found: ${earthquake.id} (${earthquake.properties.mag}M at ${earthquake.properties.place})`);
          
          const newEarthquake = new this.earthquakeModel({
            ...earthquake,
            processed: false,
            notificationSent: false,
          });
          
          await newEarthquake.save();
          
          // Transform and Cache in Redis
          const earthquakeEvent: EarthquakeEvent = this.transformToEarthquakeEvent(earthquake);
          
          // 1. Add to Sorted Set (Time based)
          await this.redis.zadd('earthquakes:recent', earthquakeEvent.timestamp.getTime(), JSON.stringify(earthquakeEvent));
          
          // 2. Add to Hash (ID based detail) - Optional, but good for lookup
          await this.redis.set(`earthquakes:detail:${earthquakeEvent.id}`, JSON.stringify(earthquakeEvent), 'EX', 86400); // 24h expiry
          
          // Trim Redis Sorted Set to keep only last 1000
          await this.redis.zremrangebyrank('earthquakes:recent', 0, -1001);

          newEarthquakes.push(earthquakeEvent);
        } else {
          // Check for updates based on 'updated' timestamp from USGS
          // Use optional chaining or default to 0 if undefined
          const lastUpdate = existingRecord.properties.updated || 0;
          const currentUpdate = earthquake.properties.updated || 0;

          if (currentUpdate > lastUpdate) {
             this.logger.log(`Updating earthquake: ${earthquake.id} (Mag: ${existingRecord.properties.mag} -> ${earthquake.properties.mag})`);
             
             existingRecord.properties = earthquake.properties;
             existingRecord.geometry = earthquake.geometry;
             await existingRecord.save();

             const earthquakeEvent: EarthquakeEvent = this.transformToEarthquakeEvent(earthquake);
             
             // Update Redis
             await this.redis.zadd('earthquakes:recent', earthquakeEvent.timestamp.getTime(), JSON.stringify(earthquakeEvent));
             await this.redis.set(`earthquakes:detail:${earthquakeEvent.id}`, JSON.stringify(earthquakeEvent), 'EX', 86400);
             
             updatedEarthquakes.push(earthquakeEvent);
          }
        }
      } catch (error) {
        this.logger.error(`Error saving/updating earthquake ${earthquake.id}:`, error);
      }
    }

    // Broadcast new earthquakes via WebSocket
    for (const earthquake of newEarthquakes) {
      this.earthquakeGateway.broadcastNewEarthquake(earthquake);
    }

    // Broadcast updated earthquakes
    for (const earthquake of updatedEarthquakes) {
      this.earthquakeGateway.broadcastNewEarthquake(earthquake);
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

  // Modified findAll to use Redis first
  async findAll(query: EarthquakeQueryDto): Promise<EarthquakeResponseDto[]> {
    // Optimization: If query is simple (latest 100, no complex filters), use Redis
    const isSimpleQuery = !query.location && !query.minMagnitude && !query.startDate && !query.endDate && (!query.limit || query.limit <= 100);

    if (isSimpleQuery) {
      try {
        const limit = query.limit || 100;
        const offset = query.offset || 0;
        // ZREVRANGE is index based (0 is highest score/latest time)
        const rawData = await this.redis.zrevrange('earthquakes:recent', offset, offset + limit - 1);
        
        if (rawData.length > 0) {
            return rawData.map(item => JSON.parse(item));
        }
      } catch (e) {
        this.logger.warn('Redis read failed, falling back to MongoDB', e);
      }
    }

    // Fallback to MongoDB (existing logic)
    const filter: any = {};
    
    if (query.minMagnitude !== undefined) {
      filter['properties.mag'] = { ...filter['properties.mag'], $gte: query.minMagnitude };
    }
    
    if (query.maxMagnitude !== undefined) {
      filter['properties.mag'] = { ...filter['properties.mag'], $lte: query.maxMagnitude };
    }
    
    if (query.location) {
      filter['properties.place'] = { $regex: query.location, $options: 'i' };
    }
    
    if (query.startDate) {
      filter['properties.time'] = { ...filter['properties.time'], $gte: new Date(query.startDate).getTime() };
    }
    
    if (query.endDate) {
      filter['properties.time'] = { ...filter['properties.time'], $lte: new Date(query.endDate).getTime() };
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

    return earthquakes.map(earthquake => ({
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

  async processEarthquakeAlert(earthquake: EarthquakeEvent): Promise<void> {
     try {
        // Publish to MQTT for mobile devices
        await this.mqttService.publishEarthquakeAlert(earthquake);
        
        // Mark as notification sent in MongoDB
        await this.earthquakeModel.updateOne(
            { id: earthquake.id },
            { notificationSent: true }
        );
        
        // Update Redis if necessary (optional, but keeps consistency)
        earthquake.notificationSent = true;
        // Update in detail hash
        await this.redis.set(`earthquakes:detail:${earthquake.id}`, JSON.stringify(earthquake), 'EX', 86400);
        // Updating sorted set is harder because it's a string value. 
        // We might skip updating sorted set for this flag as list view might not strictly need it real-time 
        // or we can remove and add again.
        // For performance, let's skip ZSET update for now unless critical.

        this.logger.log(`Alert sent for earthquake ${earthquake.id} (${earthquake.magnitude}M)`);
     } catch (error) {
         this.logger.error(`Failed to process alert for ${earthquake.id}`, error);
         throw error;
     }
  }

  async getStatistics(): Promise<any> {
    const total = await this.earthquakeModel.countDocuments();
    const last24Hours = await this.earthquakeModel.countDocuments({
      'properties.time': { $gte: Date.now() - 24 * 60 * 60 * 1000 }
    });
    const significantEarthquakes = await this.earthquakeModel.countDocuments({
      'properties.mag': { $gte: this.minMagnitudeAlert }
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
      redis: this.redis.status === 'ready' ? 'connected' : 'disconnected',
      mqtt: this.mqttService.isConnected() ? 'connected' : 'disconnected',
      lastFetch: this.lastFetchTime,
      connectedClients: this.earthquakeGateway.getConnectedClientsCount(),
    };

    const status = Object.values(details).every(val => 
      val === 'connected' || typeof val === 'number' || val instanceof Date
    ) ? 'healthy' : 'unhealthy';

    return { status, details };
  }
}
