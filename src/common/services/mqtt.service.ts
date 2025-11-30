import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as mqtt from 'mqtt';
import { EarthquakeEvent } from '../../earthquake/schemas/earthquake.schema';

@Injectable()
export class MqttService implements OnModuleInit, OnModuleDestroy {
  private client: mqtt.MqttClient | null = null;
  private readonly logger = new Logger('MqttService');
  private readonly brokerUrl: string;
  private readonly topic: string;

  constructor(private configService: ConfigService) {
    this.brokerUrl = this.configService.get<string>('app.mqtt.brokerUrl', 'mqtt://172.26.0.5:1883');
    this.topic = this.configService.get<string>('app.mqtt.topic', 'earthquakes/alerts');
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.connect();
    } catch (error) {
      this.logger.error('Failed to initialize MQTT connection', error);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.disconnect();
  }

  private async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.client = mqtt.connect(this.brokerUrl, {
        clientId: `earthquake-server-${Math.random().toString(16).substr(2, 8)}`,
        clean: true,
        connectTimeout: 4000,
        username: process.env.MQTT_USERNAME,
        password: process.env.MQTT_PASSWORD,
        reconnectPeriod: 1000,
      });

      this.client.on('connect', () => {
        this.logger.log(`Connected to MQTT broker at ${this.brokerUrl}`);
        resolve();
      });

      this.client.on('error', (error) => {
        this.logger.error('MQTT connection error:', error);
        reject(error);
      });

      this.client.on('reconnect', () => {
        this.logger.log('Reconnecting to MQTT broker...');
      });

      this.client.on('offline', () => {
        this.logger.warn('MQTT client is offline');
      });
    });
  }

  private async disconnect(): Promise<void> {
    if (this.client) {
      await new Promise<void>((resolve) => {
        this.client!.end(false, {}, () => {
          this.logger.log('Disconnected from MQTT broker');
          resolve();
        });
      });
    }
  }

  async publishEarthquakeAlert(earthquake: EarthquakeEvent): Promise<void> {
    if (!this.client || !this.client.connected) {
      this.logger.warn('MQTT client is not connected, unable to publish alert');
      return;
    }

    try {
      const payload = {
        id: earthquake.id,
        magnitude: earthquake.magnitude,
        location: earthquake.location,
        depth: earthquake.depth,
        timestamp: earthquake.timestamp,
        alert: earthquake.alert,
        tsunami: earthquake.tsunami,
        publishedAt: new Date(),
      };

      await new Promise<void>((resolve, reject) => {
        this.client!.publish(
          this.topic,
          JSON.stringify(payload),
          { qos: 1, retain: false },
          (error) => {
            if (error) {
              reject(error);
            } else {
              resolve();
            }
          }
        );
      });

      this.logger.log(`Published earthquake alert to MQTT: ${earthquake.id}`);
    } catch (error) {
      this.logger.error('Failed to publish earthquake alert to MQTT:', error);
      throw error;
    }
  }

  async publishHeartbeat(): Promise<void> {
    if (!this.client || !this.client.connected) {
      return;
    }

    try {
      const heartbeat = {
        timestamp: new Date(),
        status: 'online',
        clientId: this.client.options.clientId,
      };

      await new Promise<void>((resolve, reject) => {
        this.client!.publish(
          `${this.topic}/heartbeat`,
          JSON.stringify(heartbeat),
          { qos: 0, retain: true },
          (error) => {
            if (error) {
              reject(error);
            } else {
              resolve();
            }
          }
        );
      });
    } catch (error) {
      this.logger.error('Failed to publish heartbeat:', error);
    }
  }

  isConnected(): boolean {
    return this.client ? this.client.connected : false;
  }
}
