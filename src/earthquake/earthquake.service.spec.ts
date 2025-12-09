import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { EarthquakeService } from './earthquake.service';
import { Earthquake } from './schemas/earthquake.schema';
import { EarthquakeGateway } from './gateways/earthquake.gateway';
import { ConfigService } from '@nestjs/config';
import { MqttService } from '../common/services/mqtt.service';

// Mock Redis class from ioredis
const mockRedisInstance = {
  get: jest.fn(),
  set: jest.fn(),
};

jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => mockRedisInstance);
});

describe('EarthquakeService', () => {
  let service: EarthquakeService;
  let model: any;

  const mockEarthquake = {
    properties: {
      place: 'Test Location',
      mag: 5.5,
      time: new Date().getTime(),
    },
    geometry: {
      coordinates: [0, 0, 10],
    },
  };

  const mockEarthquakeModel = {
    find: jest.fn().mockReturnThis(),
    sort: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    countDocuments: jest.fn(),
  };

  const mockConfigService = {
    get: jest.fn((key, defaultValue) => defaultValue),
  };

  const mockGateway = {
    server: {
      emit: jest.fn(),
    },
  };

  const mockMqttService = {
    publish: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EarthquakeService,
        {
          provide: getModelToken(Earthquake.name),
          useValue: mockEarthquakeModel,
        },
        {
          provide: ConfigService,
          useValue: mockConfigService,
        },
        {
          provide: EarthquakeGateway,
          useValue: mockGateway,
        },
        {
          provide: MqttService,
          useValue: mockMqttService,
        },
      ],
    }).compile();

    service = module.get<EarthquakeService>(EarthquakeService);
    model = module.get(getModelToken(Earthquake.name));
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('search', () => {
    it('should return cached results if available', async () => {
      const query = { q: 'test' };
      const cachedResult = {
        data: [mockEarthquake],
        meta: { total: 1, page: 1, limit: 20, totalPages: 1 },
      };
      mockRedisInstance.get.mockResolvedValue(JSON.stringify(cachedResult));

      const result = await service.search(query);

      expect(result).toEqual(cachedResult);
      expect(mockRedisInstance.get).toHaveBeenCalled();
      expect(model.find).not.toHaveBeenCalled();
    });

    it('should fetch from db if cache miss', async () => {
      const query = { q: 'test', page: 1, limit: 10 };
      mockRedisInstance.get.mockResolvedValue(null);

      model.find.mockReturnThis();
      model.sort.mockReturnThis();
      model.skip.mockReturnThis();
      model.limit.mockResolvedValue([mockEarthquake]);
      model.countDocuments.mockResolvedValue(1);

      const result = await service.search(query);

      expect(result.data[0]?.magnitude).toBe(mockEarthquake.properties.mag);
      expect(result.data[0]?.location.place).toBe(
        mockEarthquake.properties.place,
      );
      expect(result.data[0]?.depth).toBe(
        mockEarthquake.geometry.coordinates[2],
      );
      expect(result.meta.total).toBe(1);
      expect(model.find).toHaveBeenCalled();
      expect(mockRedisInstance.set).toHaveBeenCalled();
    });

    it('should apply filters correctly', async () => {
      const query = {
        q: 'Japan',
        minDepth: 10,
        maxDepth: 50,
        minMagnitude: 5,
        maxMagnitude: 7,
        sortBy: 'magnitude' as const,
        order: 'desc' as const,
      };

      mockRedisInstance.get.mockResolvedValue(null);
      model.limit.mockResolvedValue([]);
      model.countDocuments.mockResolvedValue(0);

      await service.search(query);

      const filterArg = model.find.mock.calls[0][0];
      expect(filterArg['properties.place']).toBeDefined();
      expect(filterArg['geometry.coordinates.2']).toEqual({
        $gte: 10,
        $lte: 50,
      });
      expect(filterArg['properties.mag']).toEqual({ $gte: 5, $lte: 7 });

      const sortArg = model.sort.mock.calls[0][0];
      expect(sortArg['properties.mag']).toBe(-1);
    });
  });
});
