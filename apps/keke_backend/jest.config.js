/**
 * Jest harness for the keke_backend (CommonJS + TypeScript via ts-jest).
 *
 * Projects keep unit / concurrency / integration suites separate:
 *   - unit + concurrency: no external services (Redis is mocked via ioredis-mock,
 *     see test/mocks/redis.ts). Always runnable.
 *   - integration: opt-in only when TEST_DATABASE_URL is set (disposable DB).
 *
 * A safety guard (test/setup/guard.ts) aborts the whole run if production
 * credentials are detected, so the suite can never touch prod Redis/Postgres.
 * (Global test timeout is set in that guard via jest.setTimeout.)
 */
const shared = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  setupFilesAfterEnv: ['<rootDir>/test/setup/guard.ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { diagnostics: false }],
  },
  // Redirect the real Redis client to an in-memory ioredis-mock so tests NEVER
  // touch a real/prod Redis. All reservation logic runs against this mock.
  moduleNameMapper: {
    '(^|/)config/redis$': '<rootDir>/test/mocks/redis.ts',
  },
  clearMocks: true,
};

module.exports = {
  /*
   * Jest's 5s per-test default is too tight for this suite.
   *
   * The integration tests talk to a real Postgres and several exercise the auth
   * path, where bcrypt runs at cost 12 — about a quarter-second per hash, on
   * purpose. The account-lockout test alone performs five failed logins in
   * sequence, so it spends over a second hashing before any database round
   * trip. Running all three projects together on a loaded machine tipped it
   * over the default twice in four runs, while the same suite passed every time
   * on its own.
   *
   * That is a slow test, not a broken one. Lowering bcrypt's cost to suit the
   * test suite would weaken the thing being tested.
   *
   * Root level, not inside a project: Jest rejects `testTimeout` in a project
   * block as an unknown option — and does so as a warning, so a fix put there
   * looks applied and silently is not.
   */
  testTimeout: 30_000,

  /*
   * Half the cores, not all of them.
   *
   * Jest defaults to cores-1 workers, which is right for I/O-bound tests and
   * wrong for this suite: the staff-auth tests are pure CPU — bcrypt at cost 12
   * — and under 11-way contention a single hash that takes 250ms alone can take
   * ten times that. The account-lockout test performs five in sequence, and
   * once the suite grew past ~690 tests it began exceeding even a 30s timeout.
   *
   * Capping the workers gives the hashing tests a core to run on. The
   * alternative — lowering bcrypt's cost for tests — would weaken the thing
   * being tested, which is not a trade worth making for a faster suite.
   */
  maxWorkers: '50%',

  // Coverage available but NOT collected by default (keeps normal runs fast).
  collectCoverage: false,
  coverageDirectory: '<rootDir>/coverage',
  coveragePathIgnorePatterns: ['/node_modules/', '/test/'],
  projects: [
    { ...shared, displayName: 'unit', testMatch: ['<rootDir>/test/unit/**/*.test.ts'] },
    { ...shared, displayName: 'concurrency', testMatch: ['<rootDir>/test/concurrency/**/*.test.ts'] },
    {
      ...shared,
      displayName: 'integration',
      testMatch: ['<rootDir>/test/integration/**/*.test.ts'],
    },
  ],
};
