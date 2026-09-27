// Jest config for the migration integration tests (tests/migrations/integration).
//
// These tests apply real migrations to a real PostgreSQL database and verify
// dry-run behaviour plus rollback of every migration, so they are run
// separately from the main unit-test suite:
//
//   npm run test:migrations
//
// They require a reachable PostgreSQL at DATABASE_URL (defaults to the same
// localhost:5432/test_db used by CI and docker-compose).
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  setupFiles: ["<rootDir>/tests/jest.setup.ts"],
  roots: ["<rootDir>/tests/migrations"],
  testMatch: ["**/*.integration.test.ts"],
  // The per-migration rollback suite executes every migration up to three
  // times, so allow generous timeouts.
  testTimeout: 900000,
  moduleNameMapper: {
    "^(\\.\\.?\\/.+)\\.js$": "$1",
  },
  transform: {
    "^.+\\.ts$": ["ts-jest", { diagnostics: false }],
  },
  maxWorkers: 1,
  verbose: true,
};
