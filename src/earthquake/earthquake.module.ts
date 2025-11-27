import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { EarthquakeSchema } from './schemas/earthquake.schema';
import { EarthquakeService } from './earthquake.service';
import { EarthquakeController } from './earthquake.controller';
import { EarthquakeGateway } from './gateways/earthquake.gateway';
import { CommonModule } from '../common/common.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: 'Earthquake', schema: EarthquakeSchema },
    ]),
    CommonModule,
  ],
  controllers: [EarthquakeController],
  providers: [EarthquakeService, EarthquakeGateway],
  exports: [EarthquakeService, EarthquakeGateway],
})
export class EarthquakeModule { }
