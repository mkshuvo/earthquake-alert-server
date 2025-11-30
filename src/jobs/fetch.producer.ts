import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

@Injectable()
export class FetchProducer implements OnModuleInit {
  private readonly logger = new Logger(FetchProducer.name);

  constructor(@InjectQueue('earthquake-fetch') private fetchQueue: Queue) {}

  async onModuleInit() {
    await this.setupRepeatableJobs();
  }

  private async setupRepeatableJobs() {
    // Clean up old jobs to avoid duplicates during dev restarts
    const repeatableJobs = await this.fetchQueue.getRepeatableJobs();
    for (const job of repeatableJobs) {
      await this.fetchQueue.removeRepeatableByKey(job.key);
    }

    this.logger.log('Scheduling background fetch jobs...');

    // 1. Frequent fetch for latest earthquakes (every 30s)
    await this.fetchQueue.add(
      'fetch-latest',
      { type: 'all_hour' },
      {
        repeat: {
          every: 30000, // 30 seconds
        },
        removeOnComplete: true,
      },
    );

    // 2. Fetch significant earthquakes (every 5m)
    await this.fetchQueue.add(
      'fetch-significant',
      { type: 'significant_month' },
      {
        repeat: {
          every: 5 * 60 * 1000,
        },
        removeOnComplete: true,
      },
    );

    // 3. Catch-up fetch (every 15m)
    await this.fetchQueue.add(
      'fetch-history',
      { type: 'all_day' },
      {
        repeat: {
          every: 15 * 60 * 1000,
        },
        removeOnComplete: true,
      },
    );
  }
}