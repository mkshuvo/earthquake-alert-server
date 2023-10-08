import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

interface Properties {
  mag: number;
  place: string;
  time: number;
  updated: number;
  tz: string | null;
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
  coordinates: [number, number, number];
}

export interface Earthquake {
  properties: Properties;
  geometry: Geometry;
  id: string;
}

export type EarthquakeDocument = Earthquake & Document;

@Schema()
export class Earthquake {
  @Prop({ required: true, type: Object })
  properties: Properties;

  @Prop({ required: true, type: Object })
  geometry: Geometry;

  @Prop({ required: true, unique: true })
  id: string;
}

export const EarthquakeSchema = SchemaFactory.createForClass(Earthquake);
