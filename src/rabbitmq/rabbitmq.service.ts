import { Injectable, Inject, Logger } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class RabbitmqService {
  private readonly logger = new Logger('RabbitmqService');

  constructor(
    @Inject('RABBITMQ_SERVICE') private readonly client: ClientProxy,
    private configService: ConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.client.connect();
    this.logger.log('RabbitMQ service initialized');
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.close();
    this.logger.log('RabbitMQ service destroyed');
  }

  // Send a message to RabbitMQ queue
  async sendMessage(pattern: string, data: any): Promise<void> {
    try {
      await this.client.emit(pattern, data).toPromise();
      this.logger.debug(`Message sent with pattern: ${pattern}`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Failed to send message: ${errorMessage}`, error);
      throw error;
    }
  }

  // Send earthquake data specifically
  async sendEarthquakeData(earthquakes: any[]): Promise<void> {
    await this.sendMessage('earthquake.new', { earthquakes, timestamp: new Date() });
  }

  // Handle received messages
  async handleMessage(data: any): Promise<void> {
    this.logger.log('Received message:', JSON.stringify(data));
    // Additional message processing logic can be added here
  }

  // Check if client is connected
  isConnected(): boolean {
    return this.client && (this.client as any).connected;
  }
}
