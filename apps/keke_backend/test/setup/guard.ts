/**
 * Test-safety guard (runs before every test file).
 *
 * 1. Aborts the entire run if it looks like the environment points at PRODUCTION
 *    Redis/Postgres — tests must never touch real infrastructure.
 * 2. Forces NODE_ENV=test.
 * 3. Flushes the in-memory mock Redis before each test for full isolation.
 */
import { redis } from '../../src/config/redis'; // remapped to the ioredis-mock

const PROD_MARKERS = ['kekeride', 'keke_prod', 'api.kekeride', '206.189.96.147'];

function looksProd(value: string | undefined): boolean {
  if (!value) return false;
  return PROD_MARKERS.some((m) => value.includes(m));
}

if (process.env.NODE_ENV === 'production') {
  throw new Error('[test-guard] Refusing to run tests with NODE_ENV=production.');
}

if (
  process.env.ALLOW_PROD_TEST !== 'yes' &&
  (looksProd(process.env.DATABASE_URL) ||
    looksProd(process.env.REDIS_URL) ||
    looksProd(process.env.TEST_DATABASE_URL))
) {
  throw new Error(
    '[test-guard] Production-looking DATABASE_URL/REDIS_URL detected. Aborting to protect prod. ' +
      'Unset it (tests use an in-memory Redis) or set ALLOW_PROD_TEST=yes only if you are certain.',
  );
}

process.env.NODE_ENV = 'test';

// Global timeout headroom for repeated race-sensitive iterations.
jest.setTimeout(30000);

// Full isolation between tests: wipe the mock Redis store.
beforeEach(async () => {
  try {
    await (redis as any).flushall();
  } catch {
    /* ignore */
  }
});
