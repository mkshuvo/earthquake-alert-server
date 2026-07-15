import { registerAs } from '@nestjs/config';

const parseCors = (input?: string) => {
  if (!input) {
    return [
      'http://localhost:3000',
      'http://localhost:8085',
      'http://localhost:3001',
      'http://127.0.0.1:8085',
      'http://127.0.0.1:3001',
    ];
  }
  const trimmed = input.trim();
  if (trimmed.startsWith('[')) {
    try {
      const arr = JSON.parse(trimmed);
      return Array.isArray(arr) ? arr : [trimmed];
    } catch {
      return [trimmed];
    }
  }
  return trimmed.split(',').map(s => s.trim()).filter(Boolean);
};

export default registerAs('app', () => ({
  port: parseInt(process.env.PORT || '6000', 10),
  corsOrigin: parseCors(process.env.CORS_ORIGIN),

  // Database
  mongoUri:
    process.env.MONGODB_URI || 'mongodb://localhost:27017/earthquake-db',

  // Dragonfly (Redis-compatible in-memory store)
  dragonfly: {
    host: process.env.DRAGONFLY_HOST || process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.DRAGONFLY_PORT || process.env.REDIS_PORT || '6379', 10),
    // App-data client knobs (BullMQ side keeps `maxRetriesPerRequest: null`
    // and is not affected by these).
    commandTimeoutMs: parseInt(process.env.DRAGONFLY_COMMAND_TIMEOUT_MS || '500', 10),
    connectTimeoutMs: parseInt(process.env.DRAGONFLY_CONNECT_TIMEOUT_MS || '1000', 10),
    maxRetriesPerRequest: parseInt(process.env.DRAGONFLY_MAX_RETRIES || '2', 10),
  },

  // Data Retention (RAM cleanup)
  dataRetention: {
    maxRecordsInMemory: parseInt(process.env.MAX_RECORDS_IN_MEMORY || '5000', 10),
    earthquakeDataTtlSeconds: parseInt(process.env.EARTHQUAKE_DATA_TTL || '86400', 10),
    searchCacheTtlSeconds: parseInt(process.env.SEARCH_CACHE_TTL || '300', 10),
    cleanupIntervalMs: parseInt(process.env.CLEANUP_INTERVAL_MS || '600000', 10),
    warmerLookbackMs: parseInt(process.env.WARMER_LOOKBACK_MS || '86400000', 10),
    warmerIntervalMs: parseInt(process.env.WARMER_INTERVAL_MS || '300000', 10),
  },

  // MQTT
  mqtt: {
    brokerUrl: process.env.MQTT_BROKER_URL || 'mqtt://localhost:1883',
    topic: process.env.MQTT_TOPIC || 'earthquakes/alerts',
  },

  // API Configuration
  api: {
    usgsUrl:
      process.env.USGS_API_URL ||
      'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson',
    rateLimitMs: parseInt(process.env.API_RATE_LIMIT_MS || '30000', 10),
  },

  // Logging
  logging: {
    level: process.env.LOG_LEVEL || 'info',
    dir: process.env.LOG_DIR || './logs',
  },

  // Application Settings
  earthquake: {
    fetchInterval: parseInt(
      process.env.EARTHQUAKE_FETCH_INTERVAL || '30000',
      10,
    ),
    minMagnitudeAlert: parseFloat(process.env.MIN_MAGNITUDE_ALERT || '4.0'),
    maxEarthquakesPerFetch: parseInt(
      process.env.MAX_EARTHQUAKES_PER_FETCH || '10',
      10,
    ),
  },
}));
