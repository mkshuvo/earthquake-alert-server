import { Module, Global } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MqttService } from './services/mqtt.service';
import { CustomLoggerService } from './services/logger.service';
import {
  DragonflyProvider,
  DRAGONFLY_CLIENT,
} from './providers/dragonfly.provider';

@Global()
@Module({
  imports: [ConfigModule],
  providers: [MqttService, CustomLoggerService, DragonflyProvider],
  exports: [MqttService, CustomLoggerService, DRAGONFLY_CLIENT],
})
export class CommonModule {}
