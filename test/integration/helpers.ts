import { pool } from '../../apps/server/src/db/pool.js';
import { runMigrations } from '../../apps/server/src/db/migrate.js';
import { hashPassword } from '../../apps/server/src/services/auth/hash.js';

/**
 * Integration-test scaffolding.
 *
 * These tests need a real PostgreSQL, because what they verify lives in the
 * database rather than in TypeScript: `ON DELETE RESTRICT` refusing to orphan a
 * job, the append-only trigger on `audit_log`, `FOR UPDATE SKIP LOCKED`
 * behaviour under contention. Stubbing the database would test the stub.
 *
 * When no database is reachable the suite **skips with a clear reason** rather
 * than failing. A developer without Docker running should see "skipped, no
 * database" and get on with their day; CI provides Postgres and runs them for
 * real. A suite that fails noisily on a laptop is a suite people learn to
 * ignore.
 */

export interface TestContext {
  adminId: number;
  userId: number;
  systemUserId: number;
  zoneId: number;
  printerId: number;
}

let databaseAvailable: boolean | null = null;

export async function hasDatabase(): Promise<boolean> {
  if (databaseAvailable !== null) return databaseAvailable;
  try {
    await pool.query('SELECT 1');
    databaseAvailable = true;
  } catch {
    databaseAvailable = false;
  }
  return databaseAvailable;
}

export const describeIfDatabase = async (): Promise<boolean> => hasDatabase();

/**
 * Truncates every table and re-seeds the minimum a test needs.
 *
 * `TRUNCATE … RESTART IDENTITY CASCADE` rather than dropping and re-migrating:
 * migrations are the slowest part of the setup and they only need to run once
 * per suite, whereas isolation is needed per test.
 */
export async function resetDatabase(): Promise<TestContext> {
  await runMigrations();

  await pool.query(`
    TRUNCATE TABLE
      impression_ledger, notification_reads, notifications, push_subscriptions,
      scan_reservations, scans, jobs, user_printers, refresh_tokens,
      password_setup_tokens,
      collector_event_keys, print_templates,
      printer_supply_history, printer_supplies, printers, collectors,
      users, zones
    RESTART IDENTITY CASCADE
  `);

  // The audit log has a trigger that refuses UPDATE and DELETE. TRUNCATE is
  // neither, so it works — which is deliberate: append-only is about the
  // application never rewriting history, not about making the table
  // untestable.
  await pool.query('TRUNCATE TABLE audit_log RESTART IDENTITY');

  const passwordHash = await hashPassword('integration-test-password-2026');

  const { rows: system } = await pool.query<{ id: number }>(
    `INSERT INTO users (username, display_name, role, is_active, is_system, auth_provider)
     VALUES ('system', 'Device activity', 'user', FALSE, TRUE, 'system') RETURNING id`,
  );

  const { rows: admin } = await pool.query<{ id: number }>(
    `INSERT INTO users (username, password_hash, role, must_change_password)
     VALUES ('testadmin', $1, 'admin', FALSE) RETURNING id`,
    [passwordHash],
  );

  const { rows: user } = await pool.query<{ id: number }>(
    `INSERT INTO users (username, password_hash, role, department, must_change_password)
     VALUES ('testuser', $1, 'user', 'Reception', FALSE) RETURNING id`,
    [passwordHash],
  );

  const { rows: zone } = await pool.query<{ id: number }>(
    `INSERT INTO zones (code, label) VALUES ('MAIN', 'Main Office') RETURNING id`,
  );

  const { rows: printer } = await pool.query<{ id: number }>(
    `INSERT INTO printers (name, ip_address, zone_id, area, snmp_community)
     VALUES ('Reception MFP', '10.20.3.14'::inet, $1, 'Reception', 'public') RETURNING id`,
    [zone[0]?.id],
  );

  return {
    adminId: admin[0]?.id ?? 0,
    userId: user[0]?.id ?? 0,
    systemUserId: system[0]?.id ?? 0,
    zoneId: zone[0]?.id ?? 0,
    printerId: printer[0]?.id ?? 0,
  };
}

export async function closeDatabase(): Promise<void> {
  await pool.end().catch(() => undefined);
}

/** Inserts a job with sensible defaults, so tests only state what they care about. */
export async function insertTestJob(
  context: TestContext,
  overrides: Partial<{
    status: string;
    source: string;
    jobType: string;
    pages: number;
    impressions: number;
    userId: number | null;
    lockedAt: string | null;
    lockedBy: string | null;
  }> = {},
): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO jobs (printer_id, zone_id, user_id, username_snapshot, printer_name_snapshot,
                       source, job_type, status, pages, copies, impressions,
                       locked_at, locked_by)
     VALUES ($1, $2, $3, 'testuser', 'Reception MFP', $4, $5, $6, $7, 1, $8, $9, $10)
     RETURNING id`,
    [
      context.printerId,
      context.zoneId,
      overrides.userId === undefined ? context.userId : overrides.userId,
      overrides.source ?? 'app',
      overrides.jobType ?? 'print',
      overrides.status ?? 'queued',
      overrides.pages ?? 3,
      overrides.impressions ?? 3,
      overrides.lockedAt ?? null,
      overrides.lockedBy ?? null,
    ],
  );
  return rows[0]?.id ?? 0;
}
