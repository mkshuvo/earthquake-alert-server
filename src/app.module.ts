import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { EarthquakeModule } from './earthquake/earthquake.module';
import * as process from 'process';
import { RabbitmqModule } from './rabbitmq/rabbitmq.module';

@Module({
  imports: [
    MongooseModule.forRoot(process.env.MONGO_CLOUD_URL),
    EarthquakeModule,
    RabbitmqModule,
  ],
  exports: [MongooseModule],
})
export class AppModule {}
