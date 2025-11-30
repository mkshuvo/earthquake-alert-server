import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { FetchProducer } from './fetch.producer';
import { FetchConsumer } from './fetch.consumer';
import { AlertConsumer } from './alert.consumer';
import { EarthquakeModule } from '../earthquake/earthquake.module';
import { CommonModule } from '../common/common.module';

@Module({
  imports: [
    BullModule.registerQueue(
      { name: 'earthquake-fetch' },
      { name: 'earthquake-alert' },
    ),
    EarthquakeModule,
    CommonModule,
  ],
  providers: [FetchProducer, FetchConsumer, AlertConsumer],
  exports: [FetchProducer],
})
export class JobsModule {}
