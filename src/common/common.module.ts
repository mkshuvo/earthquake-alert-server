import { Module, Global } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MqttService } from './services/mqtt.service';
import { CustomLoggerService } from './services/logger.service';

@Global()
@Module({
  imports: [ConfigModule],
  providers: [MqttService, CustomLoggerService],
  exports: [MqttService, CustomLoggerService],
})
export class CommonModule {}
