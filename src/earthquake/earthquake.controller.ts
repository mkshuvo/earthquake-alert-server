import { Controller, Get } from '@nestjs/common';
import { EarthquakeService } from './earthquake.service';

@Controller('earthquake')
export class EarthquakeController {
  constructor(private readonly earthquakeService: EarthquakeService) {}

  @Get()
  async getEarthquakeData() {
    return await this.earthquakeService.fetchEarthquakeData();
  }
}
