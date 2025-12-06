import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from './../src/app.module';
import { EarthquakeService } from './../src/earthquake/earthquake.service';
import { AlertConsumer } from './../src/jobs/alert.consumer';

describe('EarthquakeController (e2e)', () => {
  let app: INestApplication;
  let earthquakeService: EarthquakeService;

  const mockEarthquakeData = {
    data: [
      {
        id: 'test-id-1',
        properties: {
          place: 'Test Location',
          mag: 5.5,
          time: new Date().getTime(),
        },
        geometry: {
          coordinates: [0, 0, 10],
        },
      },
    ],
    meta: {
      total: 1,
      page: 1,
      limit: 20,
      totalPages: 1,
    },
  };

  const mockEarthquakeService = {
    search: jest.fn().mockResolvedValue(mockEarthquakeData),
    fetchAndProcess: jest.fn().mockResolvedValue([]),
    processEarthquakeAlert: jest.fn(),
  };

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(EarthquakeService)
      .useValue(mockEarthquakeService)
      .overrideProvider(AlertConsumer)
      .useValue({ process: jest.fn() })
      .compile();

    app = moduleFixture.createNestApplication();
    await app.init();
    earthquakeService = moduleFixture.get<EarthquakeService>(EarthquakeService);
  });

  afterAll(async () => {
    await app.close();
  });

  it('/earthquakes/search (GET)', () => {
    return request
      .default(app.getHttpServer())
      .get('/earthquakes/search')
      .query({ q: 'test' })
      .expect(200)
      .expect((res: request.Response) => {
        expect(res.body).toEqual(mockEarthquakeData);
        expect(earthquakeService.search).toHaveBeenCalledWith(
          expect.objectContaining({
            q: 'test',
          }),
        );
      });
  });

  it('/earthquakes/search (GET) with filters', () => {
    const filters = {
      minMag: '5',
      maxMag: '7',
      sortBy: 'magnitude',
    };

    return request
      .default(app.getHttpServer())
      .get('/earthquakes/search')
      .query(filters)
      .expect(200)
      .expect((res: request.Response) => {
        expect(res.body).toEqual(mockEarthquakeData);
        expect(earthquakeService.search).toHaveBeenCalledWith(
          expect.objectContaining({
            minMag: '5',
            maxMag: '7',
            sortBy: 'magnitude',
          }),
        );
      });
  });

  it('/earthquakes/search (GET) with pagination', () => {
    const pagination = {
      page: '2',
      limit: '10',
    };

    return request
      .default(app.getHttpServer())
      .get('/earthquakes/search')
      .query(pagination)
      .expect(200)
      .expect((res: request.Response) => {
        expect(res.body).toEqual(mockEarthquakeData);
        expect(earthquakeService.search).toHaveBeenCalledWith(
          expect.objectContaining({
            page: '2',
            limit: '10',
          }),
        );
      });
  });
});
