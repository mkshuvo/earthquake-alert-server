import { Module, OnModuleInit, MiddlewareConsumer, RequestMethod } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { EarthquakeModule } from './earthquake/earthquake.module';
import * as amqp from 'amqplib';
import axios from 'axios';

@Module({
  imports: [
    MongooseModule.forRoot('mongodb://localhost:27017/earthquake_db'),
    EarthquakeModule,
  ],
  exports:[MongooseModule]
})
export class AppModule implements OnModuleInit {
  async onModuleInit() {
    try {
      const connection = await amqp.connect('amqp://localhost:5672');
      const channel = await connection.createChannel();
      // Perform other initialization tasks with RabbitMQ as needed
    } catch (error) {
      console.error('Error setting up RabbitMQ:', error.message);
      // Handle the error appropriately
    }
  }

  // Implement the middleware setup
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(corsMiddleware).forRoutes({ path: '*', method: RequestMethod.ALL });
  }
}

// Define your CORS middleware function
function corsMiddleware(req, res, next) {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
}
