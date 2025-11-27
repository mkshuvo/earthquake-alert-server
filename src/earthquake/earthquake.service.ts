import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';
import { Model } from 'mongoose';
import { Cron } from '@nestjs/schedule';
import * as amqp from 'amqplib';
import axios, { AxiosResponse } from 'axios';
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
    tz: string | null;
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
  metadata: {
    generated: number;
    url: string;
    title: string;
    status: number;
    api: string;
    count: number;
  };
  features: USGSFeature[];
}

@Injectable()
export class EarthquakeService implements OnModuleInit {
  private channel: amqp.Channel | null = null;
  private readonly logger = new Logger('EarthquakeService');
  private lastFetchTime: Date = new Date();
  private readonly apiUrl: string;
  private readonly fetchInterval: number;
  private readonly minMagnitudeAlert: number;
  private readonly maxEarthquakesPerFetch: number;

  constructor(
    @InjectModel(Earthquake.name)
    private earthquakeModel: Model<EarthquakeDocument>,
    private configService: ConfigService,
    private earthquakeGateway: EarthquakeGateway,
    private mqttService: MqttService,
  ) {
    this.apiUrl = this.configService.get<string>('app.api.usgsUrl', '');
    this.fetchInterval = this.configService.get<number>('app.earthquake.fetchInterval', 30000);
    this.minMagnitudeAlert = this.configService.get<number>('app.earthquake.minMagnitudeAlert', 4.0);
    this.maxEarthquakesPerFetch = this.configService.get<number>('app.earthquake.maxEarthquakesPerFetch', 10);
  }

  async onModuleInit(): Promise<void> {
    await this.initRabbitMQ();
    this.logger.log('Earthquake service initialized');
  }

  private async initRabbitMQ(): Promise<void> {
    try {
      const rabbitmqUrl = this.configService.get<string>('app.rabbitmq.url', '');
      const exchange = this.configService.get<string>('app.rabbitmq.exchange', '');
      const queue = this.configService.get<string>('app.rabbitmq.queue', '');

      const connection = await amqp.connect(rabbitmqUrl);
      this.channel = await connection.createChannel();
      
      await this.channel.assertExchange(exchange, 'topic', { durable: true });
      await this.channel.assertQueue(queue, { durable: true });
      await this.channel.bindQueue(queue, exchange, 'earthquake.*');

      this.logger.log('RabbitMQ connection established');
    } catch (error) {
      this.logger.error('Failed to initialize RabbitMQ:', error);
    }
  }

  @Cron('*/30 * * * * *') // Every 30 seconds
  async fetchEarthquakeData(): Promise<void> {
    try {
      this.logger.debug('Fetching earthquake data from USGS API');
      
      const response: AxiosResponse<USGSResponse> = await axios.get(this.apiUrl, {
        timeout: 10000,
        headers: {
          'User-Agent': 'EarthquakeAlertSystem/1.0',
        },
      });

      if (response.status !== 200) {
        throw new Error(`API returned status ${response.status}`);
      }

      const earthquakeData = response.data.features.slice(0, this.maxEarthquakesPerFetch);
      await this.saveEarthquakeData(earthquakeData);
      
      this.lastFetchTime = new Date();
      this.logger.debug(`Processed ${earthquakeData.length} earthquake records`);
      
      // Broadcast server status
      this.earthquakeGateway.broadcastServerStatus({
        isConnected: true,
        lastUpdate: this.lastFetchTime,
      });
      
    } catch (error) {
      this.logger.error('Error fetching earthquake data:', error);
      
      // Broadcast server status with error
      this.earthquakeGateway.broadcastServerStatus({
        isConnected: false,
        lastUpdate: this.lastFetchTime,
      });
    }
  }

  private async saveEarthquakeData(data: USGSFeature[]): Promise<void> {
    const newEarthquakes: EarthquakeEvent[] = [];

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
          
          // Transform to EarthquakeEvent for broadcasting
          const earthquakeEvent: EarthquakeEvent = this.transformToEarthquakeEvent(earthquake);
          newEarthquakes.push(earthquakeEvent);
          
          // Check if this earthquake needs immediate alert
          if (earthquake.properties.mag >= this.minMagnitudeAlert) {
            await this.processEarthquakeAlert(earthquakeEvent);
          }
        }
      } catch (error) {
        this.logger.error(`Error saving earthquake ${earthquake.id}:`, error);
      }
    }

    // Broadcast new earthquakes via WebSocket
    for (const earthquake of newEarthquakes) {
      this.earthquakeGateway.broadcastNewEarthquake(earthquake);
    }

    // Broadcast to RabbitMQ if there are new earthquakes
    if (newEarthquakes.length > 0) {
      await this.broadcastToRabbitMQ(newEarthquakes);
    }
  }

  private transformToEarthquakeEvent(usgsData: USGSFeature): EarthquakeEvent {
    return {
      id: usgsData.id,
      magnitude: usgsData.properties.mag,
      location: {
        latitude: usgsData.geometry.coordinates[1],
        longitude: usgsData.geometry.coordinates[0],
        place: usgsData.properties.place,
      },
      depth: usgsData.geometry.coordinates[2],
      timestamp: new Date(usgsData.properties.time),
      url: usgsData.properties.url,
      alert: usgsData.properties.alert,
      tsunami: usgsData.properties.tsunami,
      processed: false,
      notificationSent: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  private async processEarthquakeAlert(earthquake: EarthquakeEvent): Promise<void> {
    try {
      // Publish to MQTT for mobile devices
      await this.mqttService.publishEarthquakeAlert(earthquake);
      
      // Mark as notification sent
      await this.earthquakeModel.updateOne(
        { id: earthquake.id },
        { notificationSent: true }
      );
      
      this.logger.log(`Alert sent for earthquake ${earthquake.id} (${earthquake.magnitude}M)`);
    } catch (error) {
      this.logger.error(`Failed to send alert for earthquake ${earthquake.id}:`, error);
    }
  }

  private async broadcastToRabbitMQ(earthquakes: EarthquakeEvent[]): Promise<void> {
    if (!this.channel) {
      this.logger.warn('RabbitMQ channel not available');
      return;
    }

    try {
      const exchange = this.configService.get<string>('app.rabbitmq.exchange', '');
      const message = {
        type: 'new_earthquakes',
        data: earthquakes,
        timestamp: new Date(),
      };

      this.channel.publish(
        exchange,
        'earthquake.new',
        Buffer.from(JSON.stringify(message)),
        { persistent: true }
      );

      this.logger.debug(`Broadcasted ${earthquakes.length} earthquakes to RabbitMQ`);
    } catch (error) {
      this.logger.error('Error broadcasting to RabbitMQ:', error);
    }
  }

  async findAll(query: EarthquakeQueryDto): Promise<EarthquakeResponseDto[]> {
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
      database: 'connected',
      rabbitmq: this.channel ? 'connected' : 'disconnected',
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
