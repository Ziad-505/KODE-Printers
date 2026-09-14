/**
 * Test environment.
 *
 * The configuration layer refuses to start without its required variables, and
 * that is correct behaviour — §B3.3 exists precisely so a deployment cannot
 * boot half-configured. Tests therefore have to supply a real environment
 * rather than the config layer being made lenient for them.
 *
 * `KODE_DEBUG=true` keeps the production boot guards off: they check converter
 * binaries and loopback binding, neither of which a unit test should require.
 * The integration suite sets it to `false` where it is testing the guards
 * themselves.
 */

process.env.NODE_ENV = 'test';
process.env.KODE_DEBUG = 'true';

/**
 * The throwaway database from `docker compose --profile test up -d db-test`.
 *
 * Port 5434, not 5432: a developer's own PostgreSQL usually holds 5432, and the
 * application's own database container publishes 5433. Pointing the suite at
 * either would have it TRUNCATE tables somebody cared about. A third port that
 * belongs to nothing else is the cheapest way to make that impossible.
 */
process.env.DATABASE_URL ??= 'postgres://kode_test:kode_test@127.0.0.1:5434/kode_printer_test';
process.env.JWT_SECRET ??= 'test-only-jwt-secret-not-used-anywhere-real-0123456789';
process.env.SECRET_KEY ??= 'test-only-secret-key-not-used-anywhere-real-9876543210';
process.env.CORS_ORIGINS ??= 'http://localhost:5173';

// Background work must not start during tests. A watcher polling a nonexistent
// printer every four seconds turns a clean test run into a wall of timeouts.
process.env.WATCHERS_ENABLED = 'false';
process.env.QUEUE_ENABLED = 'false';
process.env.METRICS_ENABLED = 'false';
process.env.LOG_LEVEL = 'silent';

process.env.UPLOAD_DIR ??= './data/test/uploads';
process.env.SCAN_DIR ??= './data/test/scans';
process.env.TEMPLATE_DIR ??= './data/test/templates';
process.env.TMP_DIR ??= './data/test/tmp';
