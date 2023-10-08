import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import * as amqp from 'amqplib';
import axios from 'axios';
import { Earthquake, EarthquakeDocument } from './schemas/earthquake.schema';
import { Cron, CronExpression } from '@nestjs/schedule';

@Injectable()
export class EarthquakeService {
  private channel: amqp.Channel;

  constructor(
    @InjectModel(Earthquake.name)
    private earthquakeModel: Model<EarthquakeDocument>,
  ) {
    this.initRabbitMQ().then((r) => console.log(r));
  }

  private async initRabbitMQ() {
    const connection = await amqp.connect(process.env.RABBITMQ_URL);
    this.channel = await connection.createChannel();
    await this.channel.assertQueue('earthquake_queue');
  }

  @Cron(CronExpression.EVERY_SECOND)
  async fetchEarthquakeData() {
    try {
      const response = await axios.get(
        'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson',
      );
      const earthquakeData = response.data.features.slice(0, 10);
      await this.saveEarthquakeData(earthquakeData);
    } catch (error) {
      console.error('Error fetching earthquake data:', error.message);
    }
  }

  async saveEarthquakeData(data: any[]) {
    for (const earthquake of data) {
      const existingRecord = await this.earthquakeModel.findOne({
        id: earthquake.id,
      });
      if (!existingRecord) {
        console.log(`New Earthquake Found: ${earthquake.id}`);
        const newEarthquake = new this.earthquakeModel(earthquake);
        await newEarthquake.save();
        await this.broadcastEarthquakeData(earthquake);
      }
    }
  }

  async broadcastEarthquakeData(data: any[]) {
    console.log(`Broadcasting data: ${JSON.stringify(data)}`);
    this.channel.sendToQueue(
      'earthquake_queue',
      Buffer.from(JSON.stringify({ type: 'EarthquakeData', data })),
    );
  }
}
