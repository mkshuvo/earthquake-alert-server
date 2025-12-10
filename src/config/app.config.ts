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

  // Redis
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
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
