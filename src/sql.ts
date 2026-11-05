import type { ForecastResponse, Location } from './types.ts';

export type SqlValue = string | number | null;

export interface SqlStatement {
  table: 'locations' | 'weather_current' | 'weather_daily';
  text: string;
  values: SqlValue[];
}

/** The schema the integration expects. Tested against the generated statements. */
export const SCHEMA_SQL = `-- One row per unique coordinate pair.
CREATE TABLE IF NOT EXISTS locations (
  id        serial PRIMARY KEY,
  name      text NOT NULL,
  lat       numeric(8,4) NOT NULL,
  lon       numeric(8,4) NOT NULL,
  timezone  text NOT NULL,
  UNIQUE (lat, lon)
);

-- One row per location and observation time.
CREATE TABLE IF NOT EXISTS weather_current (
  location_id  integer NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  observed_at  timestamptz NOT NULL,
  temp_c       real NOT NULL,
  apparent_c   real NOT NULL,
  humidity     integer NOT NULL,
  wind_kmh     real NOT NULL,
  wind_dir     integer NOT NULL,
  weather_code integer NOT NULL,
  PRIMARY KEY (location_id, observed_at)
);

-- One row per location and calendar day.
CREATE TABLE IF NOT EXISTS weather_daily (
  location_id  integer NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  date         date NOT NULL,
  tmax_c       real NOT NULL,
  tmin_c       real NOT NULL,
  precip_mm    real NOT NULL,
  precip_prob  integer,
  weather_code integer NOT NULL,
  fetched_at   timestamptz NOT NULL,
  PRIMARY KEY (location_id, date)
);`;

const LOCATION_INSERT = `INSERT INTO locations (name, lat, lon, timezone)
VALUES ($1, $2, $3, $4)
ON CONFLICT (lat, lon) DO UPDATE SET
  name = EXCLUDED.name,
  timezone = EXCLUDED.timezone
RETURNING id;`;

const CURRENT_INSERT = `INSERT INTO weather_current
  (location_id, observed_at, temp_c, apparent_c, humidity, wind_kmh, wind_dir, weather_code)
VALUES
  ((SELECT id FROM locations WHERE lat = $1 AND lon = $2), $3, $4, $5, $6, $7, $8, $9)
ON CONFLICT (location_id, observed_at) DO UPDATE SET
  temp_c       = EXCLUDED.temp_c,
  apparent_c   = EXCLUDED.apparent_c,
  humidity     = EXCLUDED.humidity,
  wind_kmh     = EXCLUDED.wind_kmh,
  wind_dir     = EXCLUDED.wind_dir,
  weather_code = EXCLUDED.weather_code;`;

const DAILY_INSERT = `INSERT INTO weather_daily
  (location_id, date, tmax_c, tmin_c, precip_mm, precip_prob, weather_code, fetched_at)
VALUES
  ((SELECT id FROM locations WHERE lat = $1 AND lon = $2), $3, $4, $5, $6, $7, $8, $9)
ON CONFLICT (location_id, date) DO UPDATE SET
  tmax_c       = EXCLUDED.tmax_c,
  tmin_c       = EXCLUDED.tmin_c,
  precip_mm    = EXCLUDED.precip_mm,
  precip_prob  = EXCLUDED.precip_prob,
  weather_code = EXCLUDED.weather_code,
  fetched_at   = EXCLUDED.fetched_at;`;

/**
 * Build the exact writes for one fetch: one location upsert, one current
 * upsert, and one daily upsert per forecast day. Values are parameterized;
 * nothing is interpolated into the SQL text.
 */
export function toUpserts(location: Location, forecast: ForecastResponse): SqlStatement[] {
  const lat = Number(location.latitude.toFixed(4));
  const lon = Number(location.longitude.toFixed(4));
  const fetchedAt = new Date().toISOString();
  const statements: SqlStatement[] = [
    {
      table: 'locations',
      text: LOCATION_INSERT,
      values: [location.name, lat, lon, forecast.timezone],
    },
    {
      table: 'weather_current',
      text: CURRENT_INSERT,
      values: [
        lat,
        lon,
        toIsoWithOffset(forecast.current.observedAt, forecast.utcOffsetSeconds),
        forecast.current.tempC,
        forecast.current.apparentC,
        Math.round(forecast.current.humidity),
        forecast.current.windKmh,
        Math.round(forecast.current.windDir),
        forecast.current.weatherCode,
      ],
    },
  ];

  for (const day of forecast.daily) {
    statements.push({
      table: 'weather_daily',
      text: DAILY_INSERT,
      values: [
        lat,
        lon,
        day.date,
        day.tmaxC,
        day.tminC,
        day.precipMm,
        day.precipProb === null ? null : Math.round(day.precipProb),
        day.weatherCode,
        fetchedAt,
      ],
    });
  }

  return statements;
}

/**
 * Open-Meteo returns local wall-clock time without an offset. PostgreSQL
 * `timestamptz` needs the offset, which the API provides in utc_offset_seconds.
 */
export function toIsoWithOffset(localTime: string, offsetSeconds: number): string {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::(\d{2}))?$/.exec(localTime);
  if (!match) return localTime;
  const sign = offsetSeconds < 0 ? '-' : '+';
  const absolute = Math.abs(offsetSeconds);
  const hours = String(Math.floor(absolute / 3600)).padStart(2, '0');
  const minutes = String(Math.floor((absolute % 3600) / 60)).padStart(2, '0');
  return `${match[1]}T${match[2]}:${match[3] ?? '00'}${sign}${hours}:${minutes}`;
}
