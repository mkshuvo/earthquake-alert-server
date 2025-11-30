import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

interface Properties {
  mag: number;
  place: string;
  time: number;
  updated: number;
  tz: number | null;
  url: string;
  detail: string;
  felt: number | null;
  cdi: number | null;
  mmi: number | null;
  alert: string | null;
  status: string;
  tsunami: number;
  sig: number;
  net: string;
  code: string;
  ids: string;
  sources: string;
  types: string;
  nst: number | null;
  dmin: number | null;
  rms: number;
  gap: number | null;
  magType: string;
  type: string;
  title: string;
}

interface Geometry {
  type: string;
  coordinates: [number, number, number]; // [longitude, latitude, depth]
}

export interface EarthquakeEvent {
  id: string;
  magnitude: number;
  location: {
    latitude: number;
    longitude: number;
    place: string;
  };
  depth: number;
  timestamp: Date;
  url: string;
  alert: string | null;
  tsunami: number;
  processed: boolean;
  notificationSent: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export type EarthquakeDocument = Earthquake & Document;

@Schema({ timestamps: true })
export class Earthquake {
  @Prop({ required: true, type: Object })
  properties!: Properties;

  @Prop({ required: true, type: Object })
  geometry!: Geometry;

  @Prop({ required: true, unique: true })
  id!: string;

  @Prop({ default: false })
  processed!: boolean;

  @Prop({ default: false })
  notificationSent!: boolean;
}

export const EarthquakeSchema = SchemaFactory.createForClass(Earthquake);

// Create indexes for better performance
EarthquakeSchema.index({ id: 1 }, { unique: true });
EarthquakeSchema.index({ 'properties.time': -1 });
EarthquakeSchema.index({ 'properties.mag': -1 });
EarthquakeSchema.index({ processed: 1 });
EarthquakeSchema.index({ notificationSent: 1 });
