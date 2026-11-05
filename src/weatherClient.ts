import { ResponseShapeError, TimeoutError, UpstreamError, ValidationError, WeatherError } from './errors.ts';
import type { Coords, ForecastResponse, Location } from './types.ts';

export const API_BASE = 'https://api.open-meteo.com/v1/forecast';

const CURRENT_FIELDS = [
  'temperature_2m',
  'apparent_temperature',
  'relative_humidity_2m',
  'wind_speed_10m',
  'wind_direction_10m',
  'weather_code',
].join(',');

const DAILY_FIELDS = [
  'weather_code',
  'temperature_2m_max',
  'temperature_2m_min',
  'precipitation_sum',
  'precipitation_probability_max',
].join(',');

export interface BuildUrlOptions {
  forecastDays?: number;
  timezone?: string;
}

export interface FetchOptions extends BuildUrlOptions {
  /** Abort the request after this many milliseconds. Default 8000. */
  timeoutMs?: number;
  /** Inject a fetch implementation in tests. Default global fetch. */
  fetchImpl?: typeof fetch;
}

/** Check coordinates before any request is built. Returns rounded metric values. */
export function validateCoords(latitude: unknown, longitude: unknown): Coords {
  if (typeof latitude !== 'number' || !Number.isFinite(latitude)) {
    throw new ValidationError('Latitude must be a finite number.', 'latitude');
  }
  if (typeof longitude !== 'number' || !Number.isFinite(longitude)) {
    throw new ValidationError('Longitude must be a finite number.', 'longitude');
  }
  if (latitude < -90 || latitude > 90) {
    throw new ValidationError(`Latitude must be between -90 and 90 (got ${latitude}).`, 'latitude');
  }
  if (longitude < -180 || longitude > 180) {
    throw new ValidationError(`Longitude must be between -180 and 180 (got ${longitude}).`, 'longitude');
  }
  return {
    latitude: Number(latitude.toFixed(4)),
    longitude: Number(longitude.toFixed(4)),
  };
}

/** Build the exact Open-Meteo request URL. */
export function buildUrl(coords: Coords, options: BuildUrlOptions = {}): string {
  const url = new URL(API_BASE);
  url.searchParams.set('latitude', coords.latitude.toFixed(4));
  url.searchParams.set('longitude', coords.longitude.toFixed(4));
  url.searchParams.set('current', CURRENT_FIELDS);
  url.searchParams.set('daily', DAILY_FIELDS);
  url.searchParams.set('timezone', options.timezone ?? 'auto');
  url.searchParams.set('forecast_days', String(options.forecastDays ?? 7));
  return url.toString();
}

/**
 * Fetch and validate a forecast. This is the function the Node backend would call.
 * It never returns partially valid data: every field is checked first.
 */
export async function fetchForecast(
  location: Location | Coords,
  options: FetchOptions = {},
): Promise<ForecastResponse> {
  const coords = validateCoords(location.latitude, location.longitude);
  const requestUrl = buildUrl(coords, options);
  const timeoutMs = options.timeoutMs ?? 8000;
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let status = 0;
    let payload: unknown;

    try {
      const response = await fetchImpl(requestUrl, {
        signal: controller.signal,
        headers: { accept: 'application/json' },
        cache: 'no-store',
      });
      status = response.status;
      const text = await response.text();

      try {
        payload = JSON.parse(text);
      } catch {
        throw new ResponseShapeError('response', 'is not valid JSON.');
      }

      if (!response.ok) {
        const reason = isRecord(payload) && typeof payload.reason === 'string' ? payload.reason : null;
        throw new UpstreamError(
          `Open-Meteo returned HTTP ${status}${reason ? `: ${reason}` : '.'}`,
          status,
          reason,
        );
      }
    } catch (cause) {
      if (cause instanceof WeatherError) throw cause;
      if (controller.signal.aborted) throw new TimeoutError(timeoutMs);
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw new UpstreamError(`Could not reach Open-Meteo: ${detail}`, status);
    }

    if (isRecord(payload) && payload.error === true) {
      const reason = typeof payload.reason === 'string' ? payload.reason : 'Unknown upstream error.';
      throw new UpstreamError(`Open-Meteo returned an error: ${reason}`, status || 400, reason);
    }

    return parseForecast(payload, requestUrl);
  } finally {
    clearTimeout(timer);
  }
}

/** Convert Celsius to Fahrenheit. */
export function cToF(celsius: number): number {
  return (celsius * 9) / 5 + 32;
}

/**
 * Runtime validation and normalization. A hand-written guard is used on purpose:
 * it names the exact field that broke, which is more useful than a schema error.
 */
export function parseForecast(json: unknown, requestUrl = ''): ForecastResponse {
  if (!isRecord(json)) throw new ResponseShapeError('response', 'must be a JSON object.');

  const current = json.current;
  if (!isRecord(current)) {
    throw new ResponseShapeError('current', 'must be an object with current conditions.');
  }

  const currentTemp = readNumber(current, 'temperature_2m', 'current.temperature_2m');
  const apparent = readNumber(current, 'apparent_temperature', 'current.apparent_temperature');
  const humidity = readNumber(current, 'relative_humidity_2m', 'current.relative_humidity_2m');
  const windKmh = readNumber(current, 'wind_speed_10m', 'current.wind_speed_10m');
  const windDir = readNumber(current, 'wind_direction_10m', 'current.wind_direction_10m');
  const weatherCode = readNumber(current, 'weather_code', 'current.weather_code');
  const observedAt = readString(current, 'time', 'current.time');

  const daily = json.daily;
  if (!isRecord(daily)) {
    throw new ResponseShapeError('daily', 'must be an object with forecast arrays.');
  }

  const dates = readStringArray(daily, 'time', 'daily.time');
  if (dates.length === 0) throw new ResponseShapeError('daily.time', 'must hold at least one date.');

  const codes = readNumberArray(daily, 'weather_code', 'daily.weather_code', dates.length);
  const maxima = readNumberArray(daily, 'temperature_2m_max', 'daily.temperature_2m_max', dates.length);
  const minima = readNumberArray(daily, 'temperature_2m_min', 'daily.temperature_2m_min', dates.length);
  const precipitation = readNumberArray(daily, 'precipitation_sum', 'daily.precipitation_sum', dates.length);
  const probability = readNullableNumberArray(
    daily,
    'precipitation_probability_max',
    'daily.precipitation_probability_max',
    dates.length,
  );

  return {
    latitude: readNumber(json, 'latitude', 'latitude'),
    longitude: readNumber(json, 'longitude', 'longitude'),
    timezone: readString(json, 'timezone', 'timezone'),
    utcOffsetSeconds: readNumber(json, 'utc_offset_seconds', 'utc_offset_seconds'),
    elevation: readNullableNumber(json, 'elevation', 'elevation'),
    current: {
      observedAt,
      tempC: currentTemp,
      apparentC: apparent,
      humidity,
      windKmh,
      windDir,
      weatherCode,
    },
    daily: dates.map((date, index) => ({
      date,
      weatherCode: codes[index] as number,
      tmaxC: maxima[index] as number,
      tminC: minima[index] as number,
      precipMm: precipitation[index] as number,
      precipProb: probability[index] as number | null,
    })),
    requestUrl,
    raw: json,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return `a string (${JSON.stringify(value)})`;
  return `a ${typeof value}`;
}

function readNumber(record: Record<string, unknown>, key: string, path: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ResponseShapeError(path, `must be a number, got ${describeValue(value)}.`);
  }
  return value;
}

function readNullableNumber(record: Record<string, unknown>, key: string, path: string): number | null {
  if (record[key] === null) return null;
  return readNumber(record, key, path);
}

function readString(record: Record<string, unknown>, key: string, path: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new ResponseShapeError(path, `must be a non-empty string, got ${describeValue(value)}.`);
  }
  return value;
}

function readStringArray(record: Record<string, unknown>, key: string, path: string): string[] {
  const value = record[key];
  if (!Array.isArray(value)) {
    throw new ResponseShapeError(path, `must be an array, got ${describeValue(value)}.`);
  }
  return value.map((item, index) => {
    if (typeof item !== 'string' || item.length === 0) {
      throw new ResponseShapeError(`${path}[${index}]`, `must be a non-empty string, got ${describeValue(item)}.`);
    }
    return item;
  });
}

function readNumberArray(
  record: Record<string, unknown>,
  key: string,
  path: string,
  expectedLength: number,
): number[] {
  const value = record[key];
  if (!Array.isArray(value)) {
    throw new ResponseShapeError(path, `must be an array, got ${describeValue(value)}.`);
  }
  if (value.length !== expectedLength) {
    throw new ResponseShapeError(
      path,
      `must have ${expectedLength} values to match daily.time (got ${value.length}).`,
    );
  }
  return value.map((item, index) => readArrayNumber(item, `${path}[${index}]`));
}

function readNullableNumberArray(
  record: Record<string, unknown>,
  key: string,
  path: string,
  expectedLength: number,
): Array<number | null> {
  const value = record[key];
  if (!Array.isArray(value)) {
    throw new ResponseShapeError(path, `must be an array, got ${describeValue(value)}.`);
  }
  if (value.length !== expectedLength) {
    throw new ResponseShapeError(
      path,
      `must have ${expectedLength} values to match daily.time (got ${value.length}).`,
    );
  }
  return value.map((item, index) =>
    item === null ? null : readArrayNumber(item, `${path}[${index}]`),
  );
}

function readArrayNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ResponseShapeError(path, `must be a number, got ${describeValue(value)}.`);
  }
  return value;
}
