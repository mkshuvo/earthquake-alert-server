import { Injectable } from '@nestjs/common';
import {
  ClientProxy,
  ClientProxyFactory,
  Transport,
} from '@nestjs/microservices';
import * as process from 'process';

@Injectable()
export class RabbitmqService {
  private readonly client: ClientProxy;

  constructor() {
    this.client = ClientProxyFactory.create({
      transport: Transport.RMQ,
      options: {
        urls: [process.env.RABBITMQ_URL],
        queue: 'earthquake_queue',
      },
    });
  }

  // Send a message to RabbitMQ queue
  async sendMessage(pattern: string, data: any): Promise<void> {
    await this.client.emit(pattern, data).toPromise();
  }

  // Receive messages from RabbitMQ queue
  async handleMessage(data: any): Promise<void> {
    // Handle the received message
    console.log('Received message:', data);
  }
}
