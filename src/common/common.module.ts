import { Module, Global } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MqttService } from './services/mqtt.service';
import { CustomLoggerService } from './services/logger.service';
import {
  DragonflyProvider,
  DRAGONFLY_CLIENT,
} from './providers/dragonfly.provider';
import {
  DragonflyAppDataProvider,
  DRAGONFLY_APP_CLIENT,
} from './providers/dragonfly-app-data.provider';

@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    MqttService,
    CustomLoggerService,
    DragonflyProvider,
    DragonflyAppDataProvider,
  ],
  exports: [
    MqttService,
    CustomLoggerService,
    DRAGONFLY_CLIENT, // BullMQ (maxRetriesPerRequest: null — required)
    DRAGONFLY_APP_CLIENT, // App data (bounded retries + commandTimeout)
  ],
})
export class CommonModule {}
