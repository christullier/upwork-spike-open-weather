import dearbornFixture from './fixtures/dearborn.json';
import malformedFixture from './fixtures/malformed.json';
import { ResponseShapeError, ValidationError } from './errors.ts';
import { toUpserts } from './sql.ts';
import { createStore } from './store.ts';
import { cToF, buildUrl, parseForecast, validateCoords } from './weatherClient.ts';
import type { Location } from './types.ts';

export interface TestCase {
  name: string;
  run: () => void;
}

export interface TestResult {
  name: string;
  passed: boolean;
  error: string | null;
  ms: number;
}

const DEARBORN: Location = {
  name: 'Dearborn, MI',
  latitude: 42.3223,
  longitude: -83.1763,
};

/**
 * The suite is plain data, so the same cases run in the browser runner
 * and under `npm test` with Vitest. No test framework is shipped to users.
 */
export const TEST_CASES: TestCase[] = [
  {
    name: 'validateCoords accepts Dearborn (42.3223, -83.1763)',
    run: () => {
      const coords = validateCoords(42.3223, -83.1763);
      assertEqual(coords.latitude, 42.3223, 'latitude');
      assertEqual(coords.longitude, -83.1763, 'longitude');
    },
  },
  {
    name: 'validateCoords rejects latitude 123 before a request',
    run: () => {
      assertThrows(() => validateCoords(123, 500), 'ValidationError', 'latitude');
    },
  },
  {
    name: 'buildUrl sets current, daily, timezone and forecast_days',
    run: () => {
      const url = new URL(buildUrl(DEARBORN));
      assertEqual(url.origin + url.pathname, 'https://api.open-meteo.com/v1/forecast', 'endpoint');
      assertEqual(url.searchParams.get('latitude'), '42.3223', 'latitude param');
      assertEqual(url.searchParams.get('longitude'), '-83.1763', 'longitude param');
      assertEqual(url.searchParams.get('timezone'), 'auto', 'timezone param');
      assertEqual(url.searchParams.get('forecast_days'), '7', 'forecast_days param');
      assert(url.searchParams.get('current')?.includes('weather_code') === true, 'current fields');
      assert(url.searchParams.get('daily')?.includes('precipitation_probability_max') === true, 'daily fields');
    },
  },
  {
    name: 'parseForecast normalizes the saved Dearborn response',
    run: () => {
      const forecast = parseForecast(dearbornFixture);
      assertEqual(forecast.daily.length, 7, 'daily rows');
      assertEqual(forecast.timezone, 'America/Detroit', 'timezone');
      assert(typeof forecast.current.tempC === 'number', 'current temperature is a number');
      assert(typeof forecast.daily[0]?.tmaxC === 'number', 'daily maximum is a number');
    },
  },
  {
    name: 'parseForecast names the bad field in a malformed response',
    run: () => {
      assertThrows(
        () => parseForecast(malformedFixture),
        'ResponseShapeError',
        'current.temperature_2m',
      );
    },
  },
  {
    name: 'toUpserts builds 9 statements: 1 location, 1 current, 7 daily',
    run: () => {
      const forecast = parseForecast(dearbornFixture);
      const statements = toUpserts({ ...DEARBORN, timezone: forecast.timezone }, forecast);
      assertEqual(statements.length, 9, 'statement count');
      assertEqual(statements.filter((s) => s.table === 'locations').length, 1, 'location writes');
      assertEqual(statements.filter((s) => s.table === 'weather_current').length, 1, 'current writes');
      assertEqual(statements.filter((s) => s.table === 'weather_daily').length, 7, 'daily writes');
      assert(statements.every((s) => s.text.includes('ON CONFLICT')), 'every write is an upsert');
    },
  },
  {
    name: 'applying the same forecast twice keeps 1 location and 7 days',
    run: () => {
      const forecast = parseForecast(dearbornFixture);
      const store = createStore({ persist: false });
      store.apply(DEARBORN, forecast);
      store.apply(DEARBORN, forecast);
      const snapshot = store.snapshot();
      assertEqual(snapshot.locations.length, 1, 'location rows');
      assertEqual(snapshot.current.length, 1, 'current rows');
      assertEqual(snapshot.daily.length, 7, 'daily rows');
      assertEqual(store.totalRows(), 9, 'total rows');
    },
  },
  {
    name: 'cToF converts 0 °C to 32 °F and 21 °C to 69.8 °F',
    run: () => {
      assertEqual(cToF(0), 32, 'freezing point');
      assert(Math.abs(cToF(21) - 69.8) < 0.0001, '21 °C should be 69.8 °F');
    },
  },
];

/** Run every case and capture pass, fail and duration. */
export function runTests(): TestResult[] {
  return TEST_CASES.map((test) => {
    const started = performance.now();
    try {
      test.run();
      return { name: test.name, passed: true, error: null, ms: performance.now() - started };
    } catch (error) {
      return {
        name: test.name,
        passed: false,
        error: error instanceof Error ? error.message : String(error),
        ms: performance.now() - started,
      };
    }
  });
}

export function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

export function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}.`);
  }
}

export function assertThrows(fn: () => unknown, errorName: string, field?: string): void {
  try {
    fn();
  } catch (error) {
    if (!(error instanceof Error)) throw new Error(`Expected ${errorName}, got a non-Error value.`);
    if (error.name !== errorName) {
      throw new Error(`Expected ${errorName}, got ${error.name}: ${error.message}`);
    }
    if (field) {
      if (!(error instanceof ResponseShapeError) && !(error instanceof ValidationError)) {
        throw new Error(`Expected a typed field error, got ${error.name}.`);
      }
      if (error.field !== field) {
        throw new Error(`Expected field "${field}", got "${error.field ?? 'none'}".`);
      }
    }
    return;
  }
  throw new Error(`Expected ${errorName}, but no error was thrown.`);
}
