import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { EarthquakeService } from '../earthquake/earthquake.service';
import { EarthquakeEvent } from '../earthquake/schemas/earthquake.schema';

@Processor('earthquake-alert')
export class AlertConsumer extends WorkerHost {
  private readonly logger = new Logger(AlertConsumer.name);

  constructor(private earthquakeService: EarthquakeService) {
    super();
  }

  async process(job: Job<EarthquakeEvent, any, string>): Promise<any> {
    this.logger.debug(`Processing alert job for earthquake: ${job.data.id}`);
    
    try {
      await this.earthquakeService.processEarthquakeAlert(job.data);
      return { sent: true };
    } catch (error) {
      this.logger.error(`Alert job for ${job.data.id} failed:`, error);
      throw error;
    }
  }
}
