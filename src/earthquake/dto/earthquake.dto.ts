import {
  IsString,
  IsNumber,
  IsOptional,
  IsBoolean,
  IsDateString,
} from 'class-validator';
import { Transform } from 'class-transformer';

export class EarthquakeQueryDto {
  @IsOptional()
  @IsNumber()
  @Transform(({ value }) => parseFloat(value))
  minMagnitude?: number;

  @IsOptional()
  @IsNumber()
  @Transform(({ value }) => parseFloat(value))
  maxMagnitude?: number;

  @IsOptional()
  @IsString()
  location?: string;

  @IsOptional()
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @IsDateString()
  endDate?: string;

  @IsOptional()
  @IsNumber()
  @Transform(({ value }) => parseInt(value))
  limit?: number;

  @IsOptional()
  @IsNumber()
  @Transform(({ value }) => parseInt(value))
  offset?: number;

  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === 'true')
  processed?: boolean;

  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === 'true')
  notificationSent?: boolean;
}

export class EarthquakeResponseDto {
  id!: string;
  magnitude!: number;
  location!: {
    latitude: number;
    longitude: number;
    place: string;
  };
  depth!: number;
  timestamp!: Date;
  url!: string;
  alert!: string | null;
  tsunami!: number;
  processed!: boolean;
  notificationSent!: boolean;
  createdAt!: Date;
  updatedAt!: Date;
}
