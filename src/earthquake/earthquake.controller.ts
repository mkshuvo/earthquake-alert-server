import { Controller, Get, Query, ValidationPipe, HttpCode, HttpStatus } from '@nestjs/common';
import { EarthquakeService } from './earthquake.service';
import { EarthquakeQueryDto } from './dto/earthquake.dto';

@Controller('api/earthquakes')
export class EarthquakeController {
  constructor(private readonly earthquakeService: EarthquakeService) {}

  @Get()
  async getEarthquakes(@Query(ValidationPipe) query: EarthquakeQueryDto) {
    return await this.earthquakeService.findAll(query);
  }

  @Get('statistics')
  async getStatistics() {
    return await this.earthquakeService.getStatistics();
  }

  @Get('health')
  @HttpCode(HttpStatus.OK)
  async getHealthCheck() {
    const health = await this.earthquakeService.getHealthCheck();
    return health;
  }

  @Get('fetch')
  @HttpCode(HttpStatus.OK)
  async triggerManualFetch() {
    await this.earthquakeService.fetchEarthquakeData();
    return { message: 'Manual fetch triggered successfully' };
  }
}
