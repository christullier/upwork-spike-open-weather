# Open-Meteo Integration Demo

A small static demo of a typed Open-Meteo integration. It shows the parts of the integration that are easy to get wrong: response validation, typed errors, timeouts, PostgreSQL upserts, and tests.

The page calls the live Open-Meteo API from the browser. It needs no API key, no backend, and no login.

## What the demo shows

- **Live weather.** Choose one of five cities or use browser geolocation. The page shows current conditions and a 7-day forecast.
- **A typed client.** `src/weatherClient.ts` validates coordinates, builds the request URL, applies a timeout, checks every response field, and names the exact field that is bad.
- **Typed errors.** `src/errors.ts` defines `ValidationError`, `TimeoutError`, `UpstreamError`, and `ResponseShapeError`. Each error has a log message and a user-facing message.
- **PostgreSQL mapping.** `src/sql.ts` holds the schema and builds parameterized `INSERT ... ON CONFLICT DO UPDATE` statements from the live response. The Database tab shows the SQL, the parameter arrays, and the rows.
- **An in-browser store.** `src/store.ts` mirrors the three tables in memory and in `localStorage`. A second fetch of the same city updates the rows and does not add duplicates.
- **Error scenarios.** Four buttons run the real client with bad input, malformed JSON, a 1 ms deadline, and an invalid API parameter.
- **Tests.** Eight cases run in the browser and also with Vitest.

## Run locally

```bash
npm install
npm run dev
```

Build the static site:

```bash
npm run build
npm run preview
```

The build writes `dist/`.

## Tests

```bash
npm test
```

The same cases run in the "Tests & code" tab. The in-browser runner needs no test framework.

## The integration layer

`fetchForecast(location, options)` does five steps:

1. Validate latitude and longitude.
2. Build the Open-Meteo request with `current`, `daily`, `timezone=auto`, and `forecast_days=7`.
3. Fetch with an `AbortController` deadline. The default is 8000 ms.
4. Reject a non-2xx response or an `{"error": true}` payload as `UpstreamError`.
5. Check every field in `parseForecast` before it returns data.

`parseForecast` returns a normalized object with metric units, the request URL, and the raw payload.

## Schema

```sql
CREATE TABLE locations (
  id       serial PRIMARY KEY,
  name     text NOT NULL,
  lat      numeric(8,4) NOT NULL,
  lon      numeric(8,4) NOT NULL,
  timezone text NOT NULL,
  UNIQUE (lat, lon)
);

CREATE TABLE weather_current (
  location_id  integer REFERENCES locations(id) ON DELETE CASCADE,
  observed_at  timestamptz NOT NULL,
  temp_c       real NOT NULL,
  apparent_c   real NOT NULL,
  humidity     integer NOT NULL,
  wind_kmh     real NOT NULL,
  wind_dir     integer NOT NULL,
  weather_code integer NOT NULL,
  PRIMARY KEY (location_id, observed_at)
);

CREATE TABLE weather_daily (
  location_id  integer REFERENCES locations(id) ON DELETE CASCADE,
  date         date NOT NULL,
  tmax_c       real NOT NULL,
  tmin_c       real NOT NULL,
  precip_mm    real NOT NULL,
  precip_prob  integer,
  weather_code integer NOT NULL,
  fetched_at   timestamptz NOT NULL,
  PRIMARY KEY (location_id, date)
);
```

The unique coordinate pair makes a city stable. The primary keys make each write an upsert, so a retry or a repeated fetch does not create duplicate rows.

Open-Meteo returns local time without a UTC offset. `toIsoWithOffset` adds the offset from `utc_offset_seconds`, so the value is correct for `timestamptz`.

## Use the code in a Node service

Copy `src/weatherClient.ts`, `src/errors.ts`, `src/types.ts`, and `src/sql.ts` into the backend. Install `pg`. Then use this route:

```ts
import { Pool } from 'pg';
import {
  fetchForecast,
  toUpserts,
  ValidationError,
  WeatherError,
} from './weather/index.js';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export async function getWeather(req, res) {
  const location = {
    name: String(req.query.name ?? 'User location'),
    latitude: Number(req.query.lat),
    longitude: Number(req.query.lon),
  };

  try {
    const forecast = await fetchForecast(location);
    const stored = { ...location, timezone: forecast.timezone };

    for (const statement of toUpserts(stored, forecast)) {
      await pool.query(statement.text, statement.values);
    }

    res.json(forecast);
  } catch (error) {
    if (error instanceof ValidationError) {
      res.status(400).json({
        error: error.name,
        message: error.message,
        userMessage: error.userMessage,
      });
      return;
    }
    if (error instanceof WeatherError) {
      res.status(502).json({
        error: error.name,
        message: error.message,
        userMessage: error.userMessage,
      });
      return;
    }
    throw error;
  }
}
```

Run the schema from `src/sql.ts` once. Store the database URL in `DATABASE_URL`. The Open-Meteo API needs no key.

## Deploy to Cloudflare Pages

The output is static. Use these settings:

| Setting | Value |
| --- | --- |
| Build command | `npm run build` |
| Output directory | `dist` |
| Framework preset | None or Vite |
| Environment variables | None |

## Notes

- The client fetches metric units. The page converts temperature and wind for display.
- The page sends requests only to `api.open-meteo.com`.
- Weather data is from [Open-Meteo](https://open-meteo.com/) and is licensed under CC BY 4.0.
- The demo stores rows in `localStorage`. The "Clear store" button removes them.
