import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { ScheduleModule } from '@nestjs/schedule';
import { BullModule } from '@nestjs/bullmq';
import { EarthquakeModule } from './earthquake/earthquake.module';
import { CommonModule } from './common/common.module';
import { JobsModule } from './jobs/jobs.module';
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
    BullModule.forRootAsync({
      useFactory: async (configService: ConfigService) => ({
        connection: {
          host: configService.get<string>('app.redis.host'),
          port: configService.get<number>('app.redis.port'),
        },
      }),
      inject: [ConfigService],
    }),
    ScheduleModule.forRoot(),
    EarthquakeModule,
    CommonModule,
    JobsModule,
  ],
  providers: [],
  exports: [MongooseModule],
})
export class AppModule { }
