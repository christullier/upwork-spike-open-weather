/** A place the user can request weather for. */
export interface Location {
  name: string;
  latitude: number;
  longitude: number;
  timezone?: string;
}

/** The minimum input needed to build a forecast request. */
export interface Coords {
  latitude: number;
  longitude: number;
}

/** Current conditions, normalized to metric units. */
export interface CurrentWeather {
  /** Local observation time from Open-Meteo, for example 2026-11-05T10:30. */
  observedAt: string;
  tempC: number;
  apparentC: number;
  humidity: number;
  windKmh: number;
  windDir: number;
  weatherCode: number;
}

/** One day of the forecast, normalized to metric units. */
export interface DailyForecast {
  /** Local calendar date, for example 2026-11-05. */
  date: string;
  weatherCode: number;
  tmaxC: number;
  tminC: number;
  precipMm: number;
  precipProb: number | null;
}

/** The normalized response the rest of the app consumes. */
export interface ForecastResponse {
  latitude: number;
  longitude: number;
  timezone: string;
  utcOffsetSeconds: number;
  elevation: number | null;
  current: CurrentWeather;
  daily: DailyForecast[];
  /** The exact URL used for the request. */
  requestUrl: string;
  /** The original payload, kept for audit and debugging. */
  raw: unknown;
}
