import { Provider, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

export const DRAGONFLY_CLIENT = 'DRAGONFLY_CLIENT';

export const DragonflyProvider: Provider = {
  provide: DRAGONFLY_CLIENT,
  useFactory: (configService: ConfigService): Redis => {
    const logger = new Logger('DragonflyProvider');
    const host = configService.get<string>('app.dragonfly.host', 'localhost');
    const port = configService.get<number>('app.dragonfly.port', 6379);

    logger.log(`Connecting to Dragonfly at ${host}:${port}`);

    const client = new Redis({
      host,
      port,
      maxRetriesPerRequest: null, // Required for BullMQ compatibility
      retryStrategy: (times: number) => Math.min(times * 200, 5000),
      lazyConnect: false,
    });

    client.on('connect', () => {
      logger.log('Dragonfly connection established');
    });

    client.on('error', (err: Error) => {
      logger.error(`Dragonfly connection error: ${err.message}`);
    });

    return client;
  },
  inject: [ConfigService],
};
