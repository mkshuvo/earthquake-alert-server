import { Test, TestingModule } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { EarthquakeService } from './earthquake.service';
import { Earthquake } from './schemas/earthquake.schema';
import { EarthquakeGateway } from './gateways/earthquake.gateway';
import { ConfigService } from '@nestjs/config';
import { MqttService } from '../common/services/mqtt.service';
import { DRAGONFLY_APP_CLIENT } from '../common/providers/dragonfly-app-data.provider';

const mockPipeline = {
  set: jest.fn().mockReturnThis(),
  zadd: jest.fn().mockReturnThis(),
  zremrangebyrank: jest.fn().mockReturnThis(),
  exec: jest.fn().mockResolvedValue([]),
};

const mockDragonflyInstance = {
  get: jest.fn(),
  set: jest.fn(),
  mget: jest.fn(),
  zrevrange: jest.fn(),
  zrange: jest.fn(),
  zremrangebyscore: jest.fn().mockResolvedValue(0),
  zrem: jest.fn(),
  exists: jest.fn().mockResolvedValue(0),
  ping: jest.fn().mockResolvedValue('PONG'),
  pipeline: jest.fn().mockReturnValue(mockPipeline),
  status: 'ready',
};

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
    getConnectedClientsCount: jest.fn().mockReturnValue(0),
  };

  const mockMqttService = {
    publish: jest.fn(),
    isConnected: jest.fn().mockReturnValue(true),
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
        {
          provide: DRAGONFLY_APP_CLIENT,
          useValue: mockDragonflyInstance,
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
      mockDragonflyInstance.get.mockResolvedValue(JSON.stringify(cachedResult));

      const result = await service.search(query);

      expect(result).toEqual(cachedResult);
      expect(mockDragonflyInstance.get).toHaveBeenCalled();
      expect(model.find).not.toHaveBeenCalled();
    });

    it('should fetch from db if cache miss', async () => {
      const query = { q: 'test', page: 1, limit: 10 };
      mockDragonflyInstance.get.mockResolvedValue(null);

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
      expect(mockDragonflyInstance.set).toHaveBeenCalled();
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

      mockDragonflyInstance.get.mockResolvedValue(null);
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

  describe('getHealthCheck', () => {
    it('should report dragonfly as connected when ping returns PONG', async () => {
      const result = await service.getHealthCheck();
      expect(result.details.dragonfly).toBe('connected');
      expect(result.details.dragonflyLatencyMs).toBeGreaterThanOrEqual(0);
    });
  });
});
