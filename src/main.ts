import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { ValidationPipe, Logger } from '@nestjs/common';
import { AppModule } from './app.module';
import { CustomLoggerService } from './common/services/logger.service';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Get configuration service
  const configService = app.get(ConfigService);
  const logger = new Logger('Bootstrap');

  // Use custom logger
  const customLogger = app.get(CustomLoggerService);
  app.useLogger(customLogger);

  // Enable CORS
  app.enableCors({
    origin: configService.get<string>('app.corsOrigin'),
    credentials: true,
  });

  // Global validation pipe
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  );

  // Global prefix for API routes
  app.setGlobalPrefix('api');

  const port = configService.get<number>('app.port', 6000);
  await app.listen(port, '0.0.0.0');

  logger.log(`🚀 Earthquake Alert Server is running on port ${port}`);
  logger.log(`🌐 WebSocket server is ready for connections`);
  logger.log(
    `📊 Health check available at http://localhost:${port}/api/earthquakes/health`,
  );
}

bootstrap().catch((error) => {
  console.error('Failed to start application:', error);
  process.exit(1);
});
