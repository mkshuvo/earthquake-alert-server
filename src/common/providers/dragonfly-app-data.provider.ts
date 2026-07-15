import { Provider, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

/**
 * Application-data ioredis client (NOT for BullMQ).
 *
 * Why a second client: BullMQ requires `maxRetriesPerRequest: null` for
 * blocking commands (BLPOP) to retry forever. That setting is a footgun
 * for everything else — if Dragonfly goes down for 30s, every GET/SET/
 * ZADD/MGET call here hangs for 30s, every request stalls, every cron
 * tick that touches the cache stalls, and the UI eventually times out.
 *
 * This client:
 *   - fails fast on outage (bounded retries + short commandTimeout)
 *   - does not buffer commands while disconnected (caller decides)
 *   - still reconnects automatically in the background
 *
 * The BullMQ side keeps the original `DRAGONFLY_CLIENT` with
 * `maxRetriesPerRequest: null` because BullMQ needs that to work.
 */
export const DRAGONFLY_APP_CLIENT = 'DRAGONFLY_APP_CLIENT';

export const DragonflyAppDataProvider: Provider = {
  provide: DRAGONFLY_APP_CLIENT,
  useFactory: (configService: ConfigService): Redis => {
    const logger = new Logger('DragonflyAppDataProvider');
    const host = configService.get<string>('app.dragonfly.host', 'localhost');
    const port = configService.get<number>('app.dragonfly.port', 6379);

    // Timeouts (ms) are configurable so prod can tune. Defaults are tight
    // enough to never make a single HTTP request wait longer than ~1s
    // for the cache layer.
    const commandTimeout = configService.get<number>(
      'app.dragonfly.commandTimeoutMs',
      500,
    );
    const connectTimeout = configService.get<number>(
      'app.dragonfly.connectTimeoutMs',
      1000,
    );
    const maxRetriesPerRequest = configService.get<number>(
      'app.dragonfly.maxRetriesPerRequest',
      2,
    );

    logger.log(
      `Connecting to Dragonfly (app data) at ${host}:${port} (cmdTimeout=${commandTimeout}ms, maxRetries=${maxRetriesPerRequest})`,
    );

    const client = new Redis({
      host,
      port,
      commandTimeout,
      connectTimeout,
      maxRetriesPerRequest,
      // FAIL FAST: do not buffer commands while disconnected; throw
      // immediately so the caller can fall back to MongoDB.
      enableOfflineQueue: false,
      retryStrategy: (times: number) => Math.min(times * 200, 5000),
      lazyConnect: false,
    });

    client.on('connect', () => logger.log('Dragonfly (app data) connected'));
    client.on('ready', () => logger.log('Dragonfly (app data) ready'));
    client.on('error', (err: Error) =>
      logger.error(`Dragonfly (app data) error: ${err.message}`),
    );
    client.on('end', () =>
      logger.warn('Dragonfly (app data) connection closed (will retry)'),
    );

    return client;
  },
  inject: [ConfigService],
};
