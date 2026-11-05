/**
 * Base class for every error this integration raises on purpose.
 * `message` is for logs. `userMessage` is safe to show in a UI.
 */
export class WeatherError extends Error {
  readonly userMessage: string;

  constructor(message: string, userMessage: string) {
    super(message);
    this.name = 'WeatherError';
    this.userMessage = userMessage;
  }
}

/** Bad input, caught before a request leaves the process. */
export class ValidationError extends WeatherError {
  readonly field: string | null;

  constructor(message: string, field: string | null = null) {
    super(message, 'The location is not valid. Choose a city or allow location access.');
    this.name = 'ValidationError';
    this.field = field;
  }
}

/** The upstream request did not finish inside the deadline. */
export class TimeoutError extends WeatherError {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Request timed out after ${timeoutMs} ms.`, 'The weather service took too long to answer. Please try again.');
    this.name = 'TimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

/** The upstream service answered with an error or could not be reached. */
export class UpstreamError extends WeatherError {
  readonly status: number;
  readonly reason: string | null;

  constructor(message: string, status: number, reason: string | null = null) {
    super(message, 'The weather service could not complete the request. Please try again.');
    this.name = 'UpstreamError';
    this.status = status;
    this.reason = reason;
  }
}

/** The JSON parsed, but a field is missing or has the wrong type. */
export class ResponseShapeError extends WeatherError {
  readonly field: string;

  constructor(field: string, detail: string) {
    super(`${field} ${detail}`, 'The weather service sent data in an unexpected format.');
    this.name = 'ResponseShapeError';
    this.field = field;
  }
}
