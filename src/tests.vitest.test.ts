import { describe, it } from 'vitest';
import { TEST_CASES } from './tests.ts';

describe('Open-Meteo integration', () => {
  for (const test of TEST_CASES) {
    it(test.name, () => {
      test.run();
    });
  }
});
