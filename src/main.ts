import './style.css';
import { buildUrl, cToF, fetchForecast, parseForecast, validateCoords } from './weatherClient.ts';
import { describeWeather } from './weatherCodes.ts';
import { SCHEMA_SQL, toUpserts } from './sql.ts';
import type { SqlStatement, SqlValue } from './sql.ts';
import { createStore } from './store.ts';
import type { StoreSnapshot } from './store.ts';
import { runTests } from './tests.ts';
import type { TestResult } from './tests.ts';
import {
  ResponseShapeError,
  TimeoutError,
  UpstreamError,
  ValidationError,
  WeatherError,
} from './errors.ts';
import type { ForecastResponse, Location } from './types.ts';
import dearbornFixture from './fixtures/dearborn.json';
import malformedFixture from './fixtures/malformed.json';
import weatherClientSource from './weatherClient.ts?raw';
import sqlSource from './sql.ts?raw';

interface Preset {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
}

type Tab = 'weather' | 'database' | 'errors' | 'tests';
type Unit = 'f' | 'c';
type ScenarioId = 'invalid' | 'malformed' | 'timeout' | 'api';

interface ScenarioResult {
  id: ScenarioId;
  title: string;
  expected: string;
  errorName: string;
  message: string;
  userMessage: string;
  detail: string;
  matched: boolean;
  ms: number;
}

interface State {
  tab: Tab;
  unit: Unit;
  location: Preset;
  geoLocation: Preset | null;
  forecast: ForecastResponse | null;
  statements: SqlStatement[];
  loading: boolean;
  cached: boolean;
  loadError: string | null;
  fetchMs: number | null;
  updatedAt: string | null;
  notice: string | null;
  scenario: ScenarioResult | null;
  scenarioRunning: ScenarioId | null;
  tests: TestResult[] | null;
  testsRunning: boolean;
}

const PRESETS: Preset[] = [
  { id: 'dearborn', name: 'Dearborn, MI', latitude: 42.3223, longitude: -83.1763 },
  { id: 'detroit', name: 'Detroit, MI', latitude: 42.3314, longitude: -83.0458 },
  { id: 'chicago', name: 'Chicago, IL', latitude: 41.8781, longitude: -87.6298 },
  { id: 'new-york', name: 'New York, NY', latitude: 40.7128, longitude: -74.006 },
  { id: 'phoenix', name: 'Phoenix, AZ', latitude: 33.4484, longitude: -112.074 },
];

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'weather', label: 'Weather' },
  { id: 'database', label: 'Database' },
  { id: 'errors', label: 'Error scenarios' },
  { id: 'tests', label: 'Tests & code' },
];

const SCENARIOS: Array<{
  id: ScenarioId;
  tag: string;
  title: string;
  description: string;
  expected: string;
}> = [
  {
    id: 'invalid',
    tag: 'Validation',
    title: 'Invalid coordinates',
    description: 'lat 123, lon 500. Rejected before any request is sent.',
    expected: 'ValidationError',
  },
  {
    id: 'malformed',
    tag: 'Response shape',
    title: 'Malformed JSON',
    description: 'A payload with temperature_2m set to "hot" goes to the parser.',
    expected: 'ResponseShapeError',
  },
  {
    id: 'timeout',
    tag: 'Deadline',
    title: 'Network timeout',
    description: 'A real request with a 1 ms AbortController deadline.',
    expected: 'TimeoutError',
  },
  {
    id: 'api',
    tag: 'Upstream',
    title: 'API error',
    description: 'A real request with forecast_days=99, outside the allowed range.',
    expected: 'UpstreamError',
  },
];

const store = createStore();
const state: State = {
  tab: 'weather',
  unit: 'f',
  location: PRESETS[0] as Preset,
  geoLocation: null,
  forecast: null,
  statements: [],
  loading: true,
  cached: false,
  loadError: null,
  fetchMs: null,
  updatedAt: null,
  notice: null,
  scenario: null,
  scenarioRunning: null,
  tests: null,
  testsRunning: false,
};

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('Missing #app root.');

let requestSequence = 0;

/* ------------------------------------------------------------------ */
/* Data loading                                                        */
/* ------------------------------------------------------------------ */

async function loadWeather(location: Preset): Promise<void> {
  const sequence = ++requestSequence;
  state.loading = true;
  render();

  try {
    const started = performance.now();
    const forecast = await fetchForecast(location, { timeoutMs: 8000 });
    if (sequence !== requestSequence) return;
    state.forecast = forecast;
    state.cached = false;
    state.loadError = null;
    state.fetchMs = performance.now() - started;
    state.updatedAt = new Date().toISOString();
    storeForecast(location, forecast);
  } catch (error) {
    if (sequence !== requestSequence) return;
    const fallbackLocation = PRESETS[0] as Preset;
    try {
      const forecast = parseForecast(dearbornFixture, buildUrl(fallbackLocation));
      state.location = fallbackLocation;
      state.forecast = forecast;
      state.cached = true;
      state.loadError = errorMessage(error);
      state.fetchMs = null;
      state.updatedAt = null;
      storeForecast(fallbackLocation, forecast);
    } catch {
      state.forecast = null;
      state.loadError = errorMessage(error);
      state.notice = 'The live request failed and the cached sample could not be read.';
      state.loading = false;
      render();
      return;
    }
  }

  state.loading = false;
  render();
}

function storeForecast(location: Location, forecast: ForecastResponse): void {
  const stored: Location = {
    name: location.name,
    latitude: location.latitude,
    longitude: location.longitude,
    timezone: forecast.timezone,
  };
  state.statements = toUpserts(stored, forecast);
  store.apply(stored, forecast);
}

function selectLocation(location: Preset): void {
  state.location = location;
  state.forecast = null;
  state.statements = [];
  state.cached = false;
  state.loadError = null;
  state.fetchMs = null;
  state.updatedAt = null;
  state.notice = null;
  void loadWeather(location);
}

/* ------------------------------------------------------------------ */
/* Actions                                                             */
/* ------------------------------------------------------------------ */

async function useMyLocation(): Promise<void> {
  if (!('geolocation' in navigator)) {
    state.notice = 'This browser does not support location access. Choose a city from the list.';
    render();
    return;
  }

  state.notice = 'Requesting your location…';
  render();

  navigator.geolocation.getCurrentPosition(
    (position) => {
      const location: Preset = {
        id: 'my-location',
        name: 'My location',
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
      };
      state.geoLocation = location;
      selectLocation(location);
    },
    (error) => {
      state.notice =
        error.code === error.PERMISSION_DENIED
          ? 'Location permission was denied. Choose a city from the list.'
          : 'Could not get your location. Choose a city from the list.';
      render();
    },
    { enableHighAccuracy: false, timeout: 10_000, maximumAge: 300_000 },
  );
}

async function copyRequestUrl(button: HTMLButtonElement): Promise<void> {
  const url = state.forecast?.requestUrl;
  if (!url) return;

  let copied = false;
  try {
    await navigator.clipboard.writeText(url);
    copied = true;
  } catch {
    copied = legacyCopy(url);
  }

  if (!copied) {
    state.notice = 'The browser blocked the copy. Select the URL text and copy it by hand.';
    render();
    return;
  }

  button.textContent = 'Copied';
  button.classList.add('is-copied');
  setTimeout(() => {
    button.textContent = 'Copy URL';
    button.classList.remove('is-copied');
  }, 1600);
}

function legacyCopy(text: string): boolean {
  const field = document.createElement('textarea');
  field.value = text;
  field.setAttribute('readonly', '');
  field.style.position = 'fixed';
  field.style.opacity = '0';
  document.body.appendChild(field);
  field.select();
  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  }
  field.remove();
  return copied;
}

async function runScenario(id: ScenarioId): Promise<void> {
  if (state.scenarioRunning) return;
  const definition = SCENARIOS.find((item) => item.id === id);
  if (!definition) return;

  state.scenarioRunning = id;
  state.scenario = null;
  render();

  const started = performance.now();
  let errorName = 'NoError';
  let message = 'No error was thrown.';
  let userMessage = 'The scenario completed without the expected error.';
  let detail = 'Check the client or the live API and run the scenario again.';

  try {
    if (id === 'invalid') validateCoords(123, 500);
    if (id === 'malformed') parseForecast(malformedFixture);
    if (id === 'timeout') await fetchForecast(PRESETS[0] as Preset, { timeoutMs: 1 });
    if (id === 'api') await fetchForecast(PRESETS[0] as Preset, { forecastDays: 99 });
  } catch (error) {
    if (error instanceof WeatherError) {
      errorName = error.name;
      message = error.message;
      userMessage = error.userMessage;
      detail = describeError(error);
    } else if (error instanceof Error) {
      errorName = error.name;
      message = error.message;
      userMessage = 'This error was not typed. The integration should map it to a WeatherError.';
      detail = error.stack ?? 'No stack available.';
    } else {
      errorName = 'UnknownError';
      message = String(error);
      userMessage = 'This error was not typed.';
    }
  }

  state.scenario = {
    id,
    title: definition.title,
    expected: definition.expected,
    errorName,
    message,
    userMessage,
    detail,
    matched: errorName === definition.expected,
    ms: performance.now() - started,
  };
  state.scenarioRunning = null;
  render();
}

function describeError(error: WeatherError): string {
  if (error instanceof ValidationError) {
    return `Field "${error.field ?? 'unknown'}" failed validation. No HTTP request was sent.`;
  }
  if (error instanceof ResponseShapeError) {
    return `The validator stopped at "${error.field}". No partial data was returned.`;
  }
  if (error instanceof TimeoutError) {
    return `AbortController fired after ${error.timeoutMs} ms. The fetch was cancelled.`;
  }
  if (error instanceof UpstreamError) {
    const reason = error.reason?.replace(/[.!?]+$/, '');
    return `HTTP ${error.status || 'n/a'}${reason ? ` — ${reason}` : ''}. The response was not stored.`;
  }
  return 'Typed integration error.';
}

async function runTestSuite(): Promise<void> {
  if (state.testsRunning) return;
  state.testsRunning = true;
  state.tests = null;
  render();
  await new Promise((resolve) => setTimeout(resolve, 180));
  state.tests = runTests();
  state.testsRunning = false;
  render();
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

function render(): void {
  app!.innerHTML = `
    <div class="shell">
      ${renderMasthead()}
      ${renderToolbar()}
      ${renderNotices()}
      ${renderTabs()}
      <main class="main" id="panel" role="tabpanel">
        ${state.tab === 'weather' ? renderWeather() : ''}
        ${state.tab === 'database' ? renderDatabase() : ''}
        ${state.tab === 'errors' ? renderErrors() : ''}
        ${state.tab === 'tests' ? renderTests() : ''}
      </main>
      ${renderFooter()}
    </div>
  `;
}

function renderMasthead(): string {
  return `
    <header class="masthead">
      <div class="brand">
        <span class="brand-mark" aria-hidden="true">⛅</span>
        <div>
          <p class="kicker">TypeScript · REST · PostgreSQL</p>
          <h1>Open-Meteo Integration Demo</h1>
          <p class="brand-sub">A typed client that fetches, validates and maps live weather data to PostgreSQL.</p>
        </div>
      </div>
      <div class="masthead-pills" aria-label="Demo properties">
        <span class="pill">No API key</span>
        <span class="pill">No backend</span>
        <span class="pill">8 tests</span>
      </div>
    </header>
  `;
}

function renderToolbar(): string {
  const options = [...PRESETS, ...(state.geoLocation ? [state.geoLocation] : [])]
    .map(
      (preset) =>
        `<option value="${esc(preset.id)}" ${preset.id === state.location.id ? 'selected' : ''}>${esc(preset.name)}</option>`,
    )
    .join('');

  return `
    <section class="toolbar" aria-label="Weather controls">
      <label class="field">
        <span class="field-label">Location</span>
        <select id="city-select" class="select">${options}</select>
      </label>
      <button type="button" class="btn" data-action="geo">◎ Use my location</button>
      <button type="button" class="btn" data-action="refresh" ${state.loading ? 'disabled' : ''}>↻ Refresh</button>
      <div class="segmented" role="group" aria-label="Temperature unit">
        <button type="button" data-action="unit" data-unit="f" class="${state.unit === 'f' ? 'is-active' : ''}" aria-pressed="${state.unit === 'f'}">°F</button>
        <button type="button" data-action="unit" data-unit="c" class="${state.unit === 'c' ? 'is-active' : ''}" aria-pressed="${state.unit === 'c'}">°C</button>
      </div>
      <p class="status-line">
        <span class="status-dot ${state.loading ? 'is-loading' : state.cached ? 'is-warn' : 'is-live'}"></span>
        ${esc(statusText())}
      </p>
    </section>
  `;
}

function renderNotices(): string {
  const parts: string[] = [];
  if (state.notice) {
    parts.push(`<div class="banner banner-info" role="status">${esc(state.notice)}</div>`);
  }
  if (state.cached) {
    parts.push(`
      <div class="banner banner-warn" role="status">
        <span><strong>Showing cached sample.</strong> The live request failed: ${esc(state.loadError ?? 'unknown error')}. All panels use the saved Dearborn response.</span>
        <button type="button" class="btn btn-small" data-action="refresh">Try again</button>
      </div>
    `);
  }
  return parts.join('');
}

function renderTabs(): string {
  return `
    <nav class="tabs" role="tablist" aria-label="Demo sections">
      ${TABS.map(
        (tab) => `
          <button
            type="button"
            role="tab"
            aria-selected="${state.tab === tab.id}"
            aria-controls="panel"
            class="tab ${state.tab === tab.id ? 'is-active' : ''}"
            data-action="tab"
            data-tab="${tab.id}"
          >${tab.label}</button>
        `,
      ).join('')}
    </nav>
  `;
}

function renderWeather(): string {
  if (!state.forecast) return renderLoading();
  const forecast = state.forecast;

  return `
    <div class="weather-top">
      ${renderCurrentCard(forecast)}
      ${renderRequestCard(forecast)}
    </div>
    ${renderForecast(forecast)}
    ${renderRawJson(forecast)}
  `;
}

function renderLoading(): string {
  return `
    <div class="weather-top">
      <article class="current-card loading-hero" aria-busy="true">
        <div class="loading-head">
          <span class="spinner" aria-hidden="true"></span>
          <div>
            <p class="eyebrow">Current conditions</p>
            <h2>Fetching ${esc(state.location.name)}</h2>
            <p>One typed request to api.open-meteo.com.</p>
          </div>
        </div>
        <div class="skeleton skeleton-temp"></div>
        <div class="skeleton skeleton-line"></div>
        <div class="skeleton skeleton-line short"></div>
      </article>
      <article class="card loading-side" aria-hidden="true">
        <div class="skeleton skeleton-line short"></div>
        <div class="skeleton skeleton-box"></div>
        <div class="skeleton skeleton-line"></div>
        <div class="skeleton skeleton-line short"></div>
      </article>
    </div>
  `;
}

function renderCurrentCard(forecast: ForecastResponse): string {
  const weather = describeWeather(forecast.current.weatherCode);
  const liveLabel = state.cached ? 'Cached sample' : 'Live response';
  const duration = state.fetchMs !== null ? ` · ${Math.round(state.fetchMs)} ms` : '';

  return `
    <article class="current-card">
      <div class="current-head">
        <div>
          <p class="eyebrow">${liveLabel}</p>
          <h2>${esc(state.location.name)}</h2>
          <p class="current-meta">${esc(forecast.timezone)} · observed ${esc(formatObserved(forecast.current.observedAt))}</p>
        </div>
        <span class="weather-badge" title="${esc(weather.label)}" aria-label="${esc(weather.label)}">${weather.icon}</span>
      </div>

      <div class="current-body">
        <div class="temp-block">
          <span class="temp">${formatTemp(forecast.current.tempC)}</span>
          <span class="unit">°${unitLetter()}</span>
        </div>
        <div class="condition-block">
          <p class="condition">${esc(weather.label)}</p>
          <p class="feels">Feels like ${formatTemp(forecast.current.apparentC)}°${unitLetter()}</p>
        </div>
      </div>

      <dl class="metrics">
        <div>
          <dt>Humidity</dt>
          <dd>${Math.round(forecast.current.humidity)}%</dd>
        </div>
        <div>
          <dt>Wind</dt>
          <dd>${formatWind(forecast.current.windKmh)}</dd>
          <small>${compass(forecast.current.windDir)} · ${Math.round(forecast.current.windDir)}°</small>
        </div>
        <div>
          <dt>Weather code</dt>
          <dd>${forecast.current.weatherCode}</dd>
          <small>WMO interpretation</small>
        </div>
      </dl>

      <p class="card-foot">Source: api.open-meteo.com${duration} · ${forecast.daily.length} forecast days</p>
    </article>
  `;
}

function renderRequestCard(forecast: ForecastResponse): string {
  return `
    <article class="card request-card">
      <div class="card-head">
        <div>
          <p class="eyebrow">Request</p>
          <h3>One GET, no key</h3>
        </div>
        <button type="button" class="btn btn-small" data-action="copy-url">Copy URL</button>
      </div>
      <p class="muted">The API resolves the timezone and returns metric units. The client converts for display only.</p>
      <pre class="url-box">${esc(forecast.requestUrl)}</pre>
      <dl class="request-facts">
        <div><dt>Response</dt><dd>${jsonSize(forecast.raw)}</dd></div>
        <div><dt>Elevation</dt><dd>${forecast.elevation === null ? '—' : `${Math.round(forecast.elevation)} m`}</dd></div>
        <div><dt>Offset</dt><dd>UTC${formatOffset(forecast.utcOffsetSeconds)}</dd></div>
      </dl>
    </article>
  `;
}

function renderForecast(forecast: ForecastResponse): string {
  return `
    <section class="forecast-section">
      <div class="section-head compact">
        <div>
          <p class="kicker">Daily rollup</p>
          <h2>7-day forecast</h2>
        </div>
        <p class="muted">Max / min · precipitation · WMO code</p>
      </div>
      <div class="forecast-grid">
        ${forecast.daily
          .map((day, index) => {
            const weather = describeWeather(day.weatherCode);
            const date = dayParts(day.date);
            return `
              <article class="day-card ${index === 0 ? 'is-today' : ''}">
                <div class="day-top">
                  <span class="day-name">${date.weekday}</span>
                  ${index === 0 ? '<span class="today-pill">Today</span>' : `<span class="day-date">${date.month} ${date.day}</span>`}
                </div>
                <span class="day-icon" aria-hidden="true">${weather.icon}</span>
                <p class="day-label">${esc(weather.label)}</p>
                <p class="day-temps"><strong>${formatTemp(day.tmaxC)}°</strong><span>${formatTemp(day.tminC)}°</span></p>
                <p class="day-meta"><span>${formatMm(day.precipMm)}</span><span>${day.precipProb === null ? '—' : `${Math.round(day.precipProb)}%`}</span></p>
              </article>
            `;
          })
          .join('')}
      </div>
    </section>
  `;
}

function renderRawJson(forecast: ForecastResponse): string {
  return `
    <details class="card raw-card">
      <summary>
        <span>Raw JSON response</span>
        <span class="muted">Kept beside the normalized model for audit</span>
      </summary>
      <pre class="code raw-json">${esc(JSON.stringify(forecast.raw, null, 2))}</pre>
    </details>
  `;
}

function renderDatabase(): string {
  const snapshot = store.snapshot();
  const total = store.totalRows();

  return `
    <div class="section-head">
      <div>
        <p class="kicker">Persistence</p>
        <h2>PostgreSQL mapping</h2>
        <p class="muted">The browser mirrors three tables in localStorage. The SQL is the text a Node service would send to <code>pg</code>.</p>
      </div>
      <button type="button" class="btn btn-ghost" data-action="clear-store" ${total === 0 ? 'disabled' : ''}>Clear store</button>
    </div>

    <div class="stat-grid">
      <div class="stat"><span>locations</span><strong>${snapshot.locations.length}</strong><small>unique coordinates</small></div>
      <div class="stat"><span>weather_current</span><strong>${snapshot.current.length}</strong><small>observations</small></div>
      <div class="stat"><span>weather_daily</span><strong>${snapshot.daily.length}</strong><small>daily rows</small></div>
      <div class="stat stat-accent"><span>total rows</span><strong>${total}</strong><small>upserted, not duplicated</small></div>
    </div>

    <section class="card">
      <div class="card-head">
        <div>
          <p class="eyebrow">Step 1</p>
          <h3>Schema</h3>
        </div>
        <span class="pill">3 tables</span>
      </div>
      <p class="muted">Primary keys make a repeated fetch an update. Coordinates are unique, so a city keeps its id.</p>
      <pre class="code schema-code">${esc(SCHEMA_SQL)}</pre>
    </section>

    <section class="card">
      <div class="card-head">
        <div>
          <p class="eyebrow">Step 2</p>
          <h3>Generated writes</h3>
        </div>
        <span class="pill">${state.statements.length} statements</span>
      </div>
      <p class="muted">Every value is a bound parameter. The first statement creates the location; the rest use a lookup on its unique coordinates.</p>
      ${
        state.statements.length === 0
          ? '<p class="empty">Load a city in the Weather tab to generate the statements.</p>'
          : `<div class="sql-list">${state.statements.map(renderStatement).join('')}</div>`
      }
    </section>

    <section class="card">
      <div class="card-head">
        <div>
          <p class="eyebrow">Step 3</p>
          <h3>Stored rows</h3>
        </div>
        <span class="pill">${total} rows</span>
      </div>
      <p class="muted">Fetch the same city again: the row count stays the same. Pick a new city: nine new rows appear. Rows survive a reload.</p>
      ${renderStoredTables(snapshot)}
    </section>
  `;
}

function renderStatement(statement: SqlStatement, index: number): string {
  const label =
    statement.table === 'locations'
      ? 'Location upsert'
      : statement.table === 'weather_current'
        ? 'Current conditions upsert'
        : `Forecast day ${index - 1}`;

  return `
    <article class="sql-item">
      <div class="sql-head">
        <span class="pill">${statement.table}</span>
        <span class="sql-title">${label}</span>
        <span class="muted">${statement.values.length} parameters</span>
      </div>
      <pre class="code sql-code">${esc(statement.text)}</pre>
      <div class="params">
        ${statement.values.map((value, i) => `<span class="param"><b>$${i + 1}</b>${esc(formatParam(value))}</span>`).join('')}
      </div>
    </article>
  `;
}

function renderStoredTables(snapshot: StoreSnapshot): string {
  if (store.totalRows() === 0) {
    return '<p class="empty">No rows yet. Load a city in the Weather tab.</p>';
  }

  return `
    <h4 class="table-title">locations</h4>
    <div class="table-scroll">
      <table class="data-table">
        <thead><tr><th>id</th><th>name</th><th>lat</th><th>lon</th><th>timezone</th></tr></thead>
        <tbody>
          ${snapshot.locations
            .map(
              (row) =>
                `<tr><td>${row.id}</td><td>${esc(row.name)}</td><td>${row.lat.toFixed(4)}</td><td>${row.lon.toFixed(4)}</td><td>${esc(row.timezone)}</td></tr>`,
            )
            .join('')}
        </tbody>
      </table>
    </div>

    <h4 class="table-title">weather_current</h4>
    <div class="table-scroll">
      <table class="data-table">
        <thead><tr><th>loc</th><th>observed_at</th><th>temp_c</th><th>apparent_c</th><th>humidity</th><th>wind_kmh</th><th>wind_dir</th><th>code</th></tr></thead>
        <tbody>
          ${snapshot.current
            .map(
              (row) =>
                `<tr><td>${row.locationId}</td><td>${esc(row.observedAt)}</td><td>${metric(row.tempC)}</td><td>${metric(row.apparentC)}</td><td>${row.humidity}</td><td>${metric(row.windKmh)}</td><td>${row.windDir}°</td><td>${row.weatherCode}</td></tr>`,
            )
            .join('')}
        </tbody>
      </table>
    </div>

    <h4 class="table-title">weather_daily</h4>
    <div class="table-scroll">
      <table class="data-table">
        <thead><tr><th>loc</th><th>date</th><th>tmax_c</th><th>tmin_c</th><th>precip_mm</th><th>prob</th><th>code</th><th>fetched_at</th></tr></thead>
        <tbody>
          ${snapshot.daily
            .map(
              (row) =>
                `<tr><td>${row.locationId}</td><td>${esc(row.date)}</td><td>${metric(row.tmaxC)}</td><td>${metric(row.tminC)}</td><td>${metric(row.precipMm)}</td><td>${row.precipProb === null ? '—' : row.precipProb}</td><td>${row.weatherCode}</td><td>${esc(formatStoredTime(row.fetchedAt))}</td></tr>`,
            )
            .join('')}
        </tbody>
      </table>
    </div>
  `;
}

function renderErrors(): string {
  return `
    <div class="section-head">
      <div>
        <p class="kicker">Failure paths</p>
        <h2>Error scenarios</h2>
        <p class="muted">Each button calls the real client. The panel shows the class, the log message and the message a user would see.</p>
      </div>
    </div>

    <div class="scenario-grid">
      ${SCENARIOS.map(
        (scenario) => `
          <button
            type="button"
            class="scenario-card ${state.scenario?.id === scenario.id ? 'is-selected' : ''}"
            data-action="scenario"
            data-scenario="${scenario.id}"
            ${state.scenarioRunning ? 'disabled' : ''}
          >
            <span class="scenario-tag">${esc(scenario.tag)}</span>
            <strong>${esc(scenario.title)}</strong>
            <span class="scenario-desc">${esc(scenario.description)}</span>
            <span class="scenario-run">${state.scenarioRunning === scenario.id ? 'Running…' : 'Run scenario →'}</span>
          </button>
        `,
      ).join('')}
    </div>

    ${renderScenarioResult()}
  `;
}

function renderScenarioResult(): string {
  const result = state.scenario;
  if (!result) {
    return `
      <div class="result-placeholder">
        <span class="result-dot"></span>
        <p>Run a scenario to see the typed error and its user-facing message.</p>
      </div>
    `;
  }

  return `
    <article class="result-card ${result.matched ? 'is-match' : 'is-miss'}">
      <div class="result-head">
        <span class="result-mark">${result.matched ? '✓' : '✕'}</span>
        <div>
          <p class="eyebrow">${esc(result.title)}</p>
          <h3>${esc(result.errorName)}</h3>
        </div>
        <span class="pill ${result.matched ? 'pill-ok' : 'pill-bad'}">${result.matched ? 'As expected' : `Expected ${esc(result.expected)}`}</span>
        <span class="muted">${result.ms.toFixed(1)} ms</span>
      </div>
      <dl class="result-grid">
        <div>
          <dt>Thrown message</dt>
          <dd><code>${esc(result.message)}</code></dd>
        </div>
        <div>
          <dt>User-facing message</dt>
          <dd>${esc(result.userMessage)}</dd>
        </div>
        <div>
          <dt>Detail</dt>
          <dd>${esc(result.detail)}</dd>
        </div>
      </dl>
    </article>
  `;
}

function renderTests(): string {
  const results = state.tests;
  const passed = results?.filter((result) => result.passed).length ?? 0;
  const failed = results ? results.length - passed : 0;

  return `
    <div class="section-head">
      <div>
        <p class="kicker">Verification</p>
        <h2>Tests &amp; code</h2>
        <p class="muted">Eight cases cover validation, parsing, SQL generation, upserts and unit conversion. The same cases run with Vitest.</p>
      </div>
      <button type="button" class="btn btn-primary" data-action="run-tests" ${state.testsRunning ? 'disabled' : ''}>
        ${state.testsRunning ? 'Running…' : results ? 'Run again' : 'Run tests'}
      </button>
    </div>

    ${
      results
        ? `
          <div class="test-summary">
            <span class="summary-chip ${failed === 0 ? 'is-ok' : 'is-bad'}">${passed} passed</span>
            <span class="summary-chip ${failed === 0 ? '' : 'is-bad'}">${failed} failed</span>
            <span class="muted">${results.reduce((sum, item) => sum + item.ms, 0).toFixed(1)} ms total</span>
          </div>
          <ul class="test-list">
            ${results
              .map(
                (result) => `
                  <li class="test-row ${result.passed ? 'is-pass' : 'is-fail'}">
                    <span class="test-mark">${result.passed ? '✓' : '✕'}</span>
                    <div class="test-body">
                      <span class="test-name">${esc(result.name)}</span>
                      ${result.error ? `<pre class="test-error">${esc(result.error)}</pre>` : ''}
                    </div>
                    <span class="test-time">${result.ms.toFixed(1)} ms</span>
                  </li>
                `,
              )
              .join('')}
          </ul>
        `
        : `
          <div class="result-placeholder">
            <span class="result-dot"></span>
            <p>${state.testsRunning ? 'Running the suite…' : 'Run the suite to check every case in this browser.'}</p>
          </div>
        `
    }

    <section class="code-section">
      <div class="section-head compact">
        <div>
          <p class="kicker">Source</p>
          <h3>The integration layer</h3>
        </div>
        <p class="muted">Read-only. These files have no framework or runtime dependency.</p>
      </div>

      <details class="card code-card">
        <summary>
          <span class="file-name">src/weatherClient.ts</span>
          <span class="muted">fetch · validate · parse</span>
        </summary>
        <pre class="code source-code">${esc(weatherClientSource)}</pre>
      </details>

      <details class="card code-card">
        <summary>
          <span class="file-name">src/sql.ts</span>
          <span class="muted">schema · parameterized upserts</span>
        </summary>
        <pre class="code source-code">${esc(sqlSource)}</pre>
      </details>
    </section>

    <section class="card integration-card">
      <div class="card-head">
        <div>
          <p class="eyebrow">Server side</p>
          <h3>Express route with pg</h3>
        </div>
        <span class="pill">Illustrative</span>
      </div>
      <p class="muted">The same client and mapper behind a JSON route. Add the schema once, then call this handler from your API.</p>
      <pre class="code source-code">${esc(EXPRESS_SNIPPET)}</pre>
    </section>
  `;
}

function renderFooter(): string {
  return `
    <footer class="footer">
      <p>Weather data by <a href="https://open-meteo.com/" target="_blank" rel="noreferrer">Open-Meteo.com</a> (CC BY 4.0). Static files only: no key, no login, no server.</p>
      <p class="footer-note">TypeScript · Vite · PostgreSQL mapping</p>
    </footer>
  `;
}

/* ------------------------------------------------------------------ */
/* Formatting helpers                                                  */
/* ------------------------------------------------------------------ */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

function unitLetter(): string {
  return state.unit === 'f' ? 'F' : 'C';
}

function formatTemp(celsius: number): string {
  const value = state.unit === 'f' ? cToF(celsius) : celsius;
  return String(Math.round(value));
}

function formatWind(kmh: number): string {
  return state.unit === 'f' ? `${Math.round(kmh * 0.621371)} mph` : `${Math.round(kmh)} km/h`;
}

function formatMm(mm: number): string {
  if (mm === 0) return '0 mm';
  return `${mm < 10 ? mm.toFixed(1) : Math.round(mm)} mm`;
}

function formatOffset(seconds: number): string {
  const sign = seconds < 0 ? '−' : '+';
  const absolute = Math.abs(seconds);
  const hours = Math.floor(absolute / 3600);
  const minutes = Math.floor((absolute % 3600) / 60);
  return `${sign}${hours}${minutes ? `:${String(minutes).padStart(2, '0')}` : ''}`;
}

function formatObserved(localTime: string): string {
  const [datePart = '', timePart = ''] = localTime.split('T');
  const [year = '', month = '', day = ''] = datePart.split('-');
  const monthName = MONTHS[Number(month) - 1] ?? month;
  const label = year && monthName ? `${monthName} ${Number(day)}` : datePart;
  return `${label}, ${timePart.slice(0, 5)}`;
}

function dayParts(date: string): { weekday: string; month: string; day: number } {
  const parsed = new Date(`${date}T12:00:00`);
  if (Number.isNaN(parsed.getTime())) return { weekday: '', month: '', day: 0 };
  return {
    weekday: WEEKDAYS[parsed.getDay()] ?? '',
    month: MONTHS[parsed.getMonth()] ?? '',
    day: parsed.getDate(),
  };
}

function compass(degrees: number): string {
  return COMPASS[Math.round(degrees / 22.5) % 16] ?? 'N';
}

function metric(value: number): string {
  return `${value.toFixed(1)}`;
}

function statusText(): string {
  if (state.loading) return `Fetching live data for ${state.location.name}…`;
  if (state.cached) return 'Cached sample active';
  if (state.updatedAt) return `Updated ${new Date(state.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  return 'Ready';
}

function formatParam(value: SqlValue): string {
  if (value === null) return 'NULL';
  if (typeof value === 'number') return String(value);
  return JSON.stringify(value);
}

function formatStoredTime(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return `${MONTHS[parsed.getMonth()]} ${parsed.getDate()}, ${parsed.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

function jsonSize(value: unknown): string {
  const bytes = new Blob([JSON.stringify(value)]).size;
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

function esc(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case "'":
        return '&#39;';
      default:
        return character;
    }
  });
}

/* ------------------------------------------------------------------ */
/* Events                                                              */
/* ------------------------------------------------------------------ */

app.addEventListener('click', (event) => {
  const target = (event.target as HTMLElement).closest<HTMLElement>('[data-action]');
  if (!target) return;
  const action = target.dataset.action;

  switch (action) {
    case 'tab': {
      const tab = target.dataset.tab as Tab | undefined;
      if (tab) {
        state.tab = tab;
        render();
      }
      break;
    }
    case 'unit': {
      const unit = target.dataset.unit;
      if (unit === 'f' || unit === 'c') {
        state.unit = unit;
        render();
      }
      break;
    }
    case 'geo':
      void useMyLocation();
      break;
    case 'refresh':
      if (!state.loading) void loadWeather(state.location);
      break;
    case 'copy-url':
      void copyRequestUrl(target as HTMLButtonElement);
      break;
    case 'clear-store':
      store.clear();
      render();
      break;
    case 'scenario': {
      const scenario = target.dataset.scenario as ScenarioId | undefined;
      if (scenario) void runScenario(scenario);
      break;
    }
    case 'run-tests':
      void runTestSuite();
      break;
    default:
      break;
  }
});

app.addEventListener('change', (event) => {
  const select = (event.target as HTMLElement).closest<HTMLSelectElement>('#city-select');
  if (!select) return;
  const preset = findPreset(select.value);
  if (preset) selectLocation(preset);
});

function findPreset(id: string | undefined): Preset | undefined {
  if (!id) return undefined;
  if (state.geoLocation?.id === id) return state.geoLocation;
  return PRESETS.find((preset) => preset.id === id);
}

const EXPRESS_SNIPPET = `// server/weatherRoute.ts
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
}`;

render();
void loadWeather(state.location);
