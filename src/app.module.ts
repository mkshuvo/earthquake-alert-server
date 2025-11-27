import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { ScheduleModule } from '@nestjs/schedule';
import { EarthquakeModule } from './earthquake/earthquake.module';
import { RabbitmqModule } from './rabbitmq/rabbitmq.module';
import { CommonModule } from './common/common.module';
import appConfig from './config/app.config';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig],
      envFilePath: ['.env.local', '.env'],
    }),
    MongooseModule.forRootAsync({
      useFactory: async (configService: ConfigService) => ({
        uri: configService.get<string>('app.mongoUri'),
      }),
      inject: [ConfigService],
    }),
    ScheduleModule.forRoot(),
    EarthquakeModule,
    RabbitmqModule,
    CommonModule,
  ],
  providers: [],
  exports: [MongooseModule],
})
export class AppModule { }
