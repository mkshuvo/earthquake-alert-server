// earthquake/earthquake.module.ts

import { Module } from '@nestjs/common';
import { EarthquakeService } from './earthquake.service';
import { EarthquakeController } from './earthquake.controller';
import { MongooseModule } from '@nestjs/mongoose';
import { EarthquakeSchema } from './schemas/earthquake.schema';
import { ScheduleModule } from '@nestjs/schedule';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    MongooseModule.forFeature([
      { name: 'Earthquake', schema: EarthquakeSchema },
    ]),
  ],
  controllers: [EarthquakeController],
  providers: [EarthquakeService],
})
export class EarthquakeModule {}
