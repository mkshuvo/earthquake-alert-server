import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EarthquakeEvent } from '../schemas/earthquake.schema';

@WebSocketGateway({
  cors: {
    origin: (requestOrigin, callback) => {
      const allowedOrigins = (process.env.CORS_ORIGIN || 'http://localhost:3000')
        .split(',')
        .map((s) => s.trim());
      
      if (!requestOrigin || allowedOrigins.includes(requestOrigin)) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    },
    credentials: true,
  },
})
export class EarthquakeGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server!: Server;

  private logger = new Logger('EarthquakeGateway');

  constructor(private configService: ConfigService) {}

  afterInit(server: Server): void {
    const corsOrigin = this.configService.get('app.corsOrigin');
    this.logger.log(`WebSocket Gateway initialized with CORS origins: ${JSON.stringify(corsOrigin)}`);
  }

  handleConnection(client: Socket): void {
    this.logger.log(`Client connected: ${client.id}`);
    client.emit('connection', 'Successfully connected to earthquake server');
  }

  handleDisconnect(client: Socket): void {
    this.logger.log(`Client disconnected: ${client.id}`);
  }

  @SubscribeMessage('subscribe-earthquakes')
  handleSubscribeEarthquakes(
    @MessageBody() data: any,
    @ConnectedSocket() client: Socket,
  ): void {
    this.logger.log(`Client ${client.id} subscribed to earthquake updates`);
    client.join('earthquake-updates');
    client.emit('subscribed', 'Subscribed to earthquake updates');
  }

  @SubscribeMessage('unsubscribe-earthquakes')
  handleUnsubscribeEarthquakes(
    @MessageBody() data: any,
    @ConnectedSocket() client: Socket,
  ): void {
    this.logger.log(`Client ${client.id} unsubscribed from earthquake updates`);
    client.leave('earthquake-updates');
    client.emit('unsubscribed', 'Unsubscribed from earthquake updates');
  }

  broadcastNewEarthquake(earthquake: EarthquakeEvent): void {
    this.logger.log(`Broadcasting new earthquake: ${earthquake.id}`);
    this.server.to('earthquake-updates').emit('new-earthquake', earthquake);
  }

  broadcastServerStatus(status: {
    isConnected: boolean;
    lastUpdate: Date;
  }): void {
    this.server.emit('server-status', status);
  }

  getConnectedClientsCount(): number {
    return this.server.engine.clientsCount;
  }
}
