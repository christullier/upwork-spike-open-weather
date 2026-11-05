import type { ForecastResponse, Location } from './types.ts';

export interface StoredLocation {
  id: number;
  name: string;
  lat: number;
  lon: number;
  timezone: string;
}

export interface StoredCurrent {
  locationId: number;
  observedAt: string;
  tempC: number;
  apparentC: number;
  humidity: number;
  windKmh: number;
  windDir: number;
  weatherCode: number;
}

export interface StoredDaily {
  locationId: number;
  date: string;
  tmaxC: number;
  tminC: number;
  precipMm: number;
  precipProb: number | null;
  weatherCode: number;
  fetchedAt: string;
}

export interface StoreSnapshot {
  locations: StoredLocation[];
  current: StoredCurrent[];
  daily: StoredDaily[];
}

export interface ApplyResult {
  locationId: number;
  addedCurrent: boolean;
  addedDays: number;
  updatedDays: number;
}

export interface StoreOptions {
  /** Persist to localStorage. Off by default when localStorage is missing. */
  persist?: boolean;
  storageKey?: string;
}

/**
 * A small in-memory mirror of the three tables. It applies the same
 * upsert rules as the generated SQL: a second fetch of the same city
 * updates rows and never duplicates them.
 */
export function createStore(options: StoreOptions = {}) {
  const persist = options.persist ?? typeof localStorage !== 'undefined';
  const storageKey = options.storageKey ?? 'open-meteo-demo-store-v1';

  const locations = new Map<string, StoredLocation>();
  const current = new Map<string, StoredCurrent>();
  const daily = new Map<string, StoredDaily>();

  hydrate();

  function coordinateKey(lat: number, lon: number): string {
    return `${lat.toFixed(4)}|${lon.toFixed(4)}`;
  }

  function apply(location: Location, forecast: ForecastResponse): ApplyResult {
    const lat = Number(location.latitude.toFixed(4));
    const lon = Number(location.longitude.toFixed(4));
    const locationKey = coordinateKey(lat, lon);
    const existing = locations.get(locationKey);
    const id = existing?.id ?? nextLocationId();

    locations.set(locationKey, {
      id,
      name: location.name,
      lat,
      lon,
      timezone: forecast.timezone,
    });

    const currentKey = `${id}|${forecast.current.observedAt}`;
    const addedCurrent = !current.has(currentKey);
    current.set(currentKey, {
      locationId: id,
      observedAt: forecast.current.observedAt,
      tempC: forecast.current.tempC,
      apparentC: forecast.current.apparentC,
      humidity: Math.round(forecast.current.humidity),
      windKmh: forecast.current.windKmh,
      windDir: Math.round(forecast.current.windDir),
      weatherCode: forecast.current.weatherCode,
    });

    const fetchedAt = new Date().toISOString();
    let addedDays = 0;
    let updatedDays = 0;
    for (const day of forecast.daily) {
      const dayKey = `${id}|${day.date}`;
      if (daily.has(dayKey)) updatedDays += 1;
      else addedDays += 1;
      daily.set(dayKey, {
        locationId: id,
        date: day.date,
        tmaxC: day.tmaxC,
        tminC: day.tminC,
        precipMm: day.precipMm,
        precipProb: day.precipProb === null ? null : Math.round(day.precipProb),
        weatherCode: day.weatherCode,
        fetchedAt,
      });
    }

    save();
    return { locationId: id, addedCurrent, addedDays, updatedDays };
  }

  function clear(): void {
    locations.clear();
    current.clear();
    daily.clear();
    if (persist) {
      try {
        localStorage.removeItem(storageKey);
      } catch {
        // Storage can be unavailable in private mode. The in-memory clear still holds.
      }
    }
  }

  function snapshot(): StoreSnapshot {
    return {
      locations: [...locations.values()].sort((a, b) => a.id - b.id),
      current: [...current.values()].sort(
        (a, b) => a.locationId - b.locationId || a.observedAt.localeCompare(b.observedAt),
      ),
      daily: [...daily.values()].sort(
        (a, b) => a.locationId - b.locationId || a.date.localeCompare(b.date),
      ),
    };
  }

  function totalRows(): number {
    return locations.size + current.size + daily.size;
  }

  function nextLocationId(): number {
    let max = 0;
    for (const location of locations.values()) if (location.id > max) max = location.id;
    return max + 1;
  }

  function save(): void {
    if (!persist) return;
    try {
      localStorage.setItem(storageKey, JSON.stringify(snapshot()));
    } catch {
      // A full or blocked storage must not break the demo.
    }
  }

  function hydrate(): void {
    if (!persist) return;
    let parsed: unknown;
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) return;
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof parsed !== 'object' || parsed === null) return;
    const data = parsed as Partial<StoreSnapshot>;

    if (Array.isArray(data.locations)) {
      for (const item of data.locations) {
        if (isLocation(item)) locations.set(coordinateKey(item.lat, item.lon), item);
      }
    }
    if (Array.isArray(data.current)) {
      for (const item of data.current) {
        if (isCurrent(item)) current.set(`${item.locationId}|${item.observedAt}`, item);
      }
    }
    if (Array.isArray(data.daily)) {
      for (const item of data.daily) {
        if (isDaily(item)) daily.set(`${item.locationId}|${item.date}`, item);
      }
    }
  }

  return { apply, clear, snapshot, totalRows };
}

function isLocation(value: unknown): value is StoredLocation {
  const item = value as Partial<StoredLocation> | null;
  return (
    !!item &&
    typeof item.id === 'number' &&
    typeof item.name === 'string' &&
    typeof item.lat === 'number' &&
    typeof item.lon === 'number' &&
    typeof item.timezone === 'string'
  );
}

function isCurrent(value: unknown): value is StoredCurrent {
  const item = value as Partial<StoredCurrent> | null;
  return (
    !!item &&
    typeof item.locationId === 'number' &&
    typeof item.observedAt === 'string' &&
    typeof item.tempC === 'number' &&
    typeof item.apparentC === 'number' &&
    typeof item.humidity === 'number' &&
    typeof item.windKmh === 'number' &&
    typeof item.windDir === 'number' &&
    typeof item.weatherCode === 'number'
  );
}

function isDaily(value: unknown): value is StoredDaily {
  const item = value as Partial<StoredDaily> | null;
  return (
    !!item &&
    typeof item.locationId === 'number' &&
    typeof item.date === 'string' &&
    typeof item.tmaxC === 'number' &&
    typeof item.tminC === 'number' &&
    typeof item.precipMm === 'number' &&
    (item.precipProb === null || typeof item.precipProb === 'number') &&
    typeof item.weatherCode === 'number' &&
    typeof item.fetchedAt === 'string'
  );
}
