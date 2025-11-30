import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import { Logger } from '@nestjs/common';
import { EarthquakeService } from '../earthquake/earthquake.service';
import { ConfigService } from '@nestjs/config';

@Processor('earthquake-fetch', { concurrency: 4 })
export class FetchConsumer extends WorkerHost {
  private readonly logger = new Logger(FetchConsumer.name);
  private readonly minMagnitudeAlert: number;

  constructor(
    private earthquakeService: EarthquakeService,
    private configService: ConfigService,
    @InjectQueue('earthquake-alert') private alertQueue: Queue,
  ) {
    super();
    this.minMagnitudeAlert = this.configService.get<number>('app.earthquake.minMagnitudeAlert', 4.0);
  }

  async process(job: Job<any, any, string>): Promise<any> {
    this.logger.debug(`Processing fetch job: ${job.name}`);
    const feedType = job.data.type || 'all_hour';

    try {
      const newEarthquakes = await this.earthquakeService.fetchAndProcess(feedType);

      // Check for alerts
      for (const earthquake of newEarthquakes) {
        if (earthquake.magnitude >= this.minMagnitudeAlert) {
           this.logger.log(`Significant earthquake detected: ${earthquake.id} (${earthquake.magnitude}M). Scheduling alert.`);
           await this.alertQueue.add('send-alert', earthquake, {
               removeOnComplete: true,
               attempts: 3,
               backoff: {
                   type: 'exponential',
                   delay: 1000,
               }
           });
        }
      }
      return { processed: newEarthquakes.length };
    } catch (error) {
      this.logger.error(`Job ${job.name} failed:`, error);
      throw error;
    }
  }
}
