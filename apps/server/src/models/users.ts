import type { Paginated, Role, User } from '@kode/shared';
import type { Db } from '../db/pool.js';
import { applyKeyset, toPage, WhereBuilder } from '../db/sql.js';

/**
 * The users table.
 *
 * As with printers, the password hash has no route out of this module: `User`
 * has no field for it, and the one function that reads it returns a distinct
 * type used only by the authentication service.
 */

interface UserRow {
  id: number;
  username: string;
  email: string | null;
  display_name: string | null;
  role: Role;
  department: string | null;
  zone_id: number | null;
  auth_provider: string;
  must_change_password: boolean;
  locked_until: string | null;
  last_login_at: string | null;
  is_active: boolean;
  is_system: boolean;
  has_password: boolean;
  setup_link_expires_at: string | null;
  created_at: string;
  updated_at: string;
  printer_ids: number[] | null;
}

const USER_SELECT = `
  SELECT u.id, u.username::text AS username, u.email::text AS email, u.display_name,
         u.role, u.department, u.zone_id, u.auth_provider, u.must_change_password, u.locked_until,
         u.last_login_at, u.is_active, u.is_system, u.created_at, u.updated_at,
         (u.password_hash IS NOT NULL) AS has_password,
         -- The outstanding set-password link, if there is one. Drives the
         -- "waiting to set a password" list without a second round trip.
         (SELECT t.expires_at FROM password_setup_tokens t
            WHERE t.user_id = u.id AND t.consumed_at IS NULL AND t.expires_at > now()
            LIMIT 1) AS setup_link_expires_at,
         COALESCE(
           (SELECT array_agg(up.printer_id ORDER BY up.printer_id)
              FROM user_printers up
             WHERE up.user_id = u.id
               AND (up.expires_at IS NULL OR up.expires_at > now())),
           '{}'
         ) AS printer_ids
    FROM users u
`;

const toUser = (row: UserRow): User => ({
  id: row.id,
  username: row.username,
  email: row.email,
  displayName: row.display_name,
  role: row.role,
  department: row.department,
  zoneId: row.zone_id,
  authProvider: row.auth_provider,
  mustChangePassword: row.must_change_password,
  lockedUntil: row.locked_until,
  lastLoginAt: row.last_login_at,
  isActive: row.is_active,
  isSystem: row.is_system,
  hasPassword: row.has_password,
  setupLinkExpiresAt: row.setup_link_expires_at,
  printerIds: row.printer_ids ?? [],
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export async function findUser(db: Db, id: number): Promise<User | null> {
  const { rows } = await db.query<UserRow>(`${USER_SELECT} WHERE u.id = $1`, [id]);
  const row = rows[0];
  return row ? toUser(row) : null;
}

export async function findUserByUsername(db: Db, username: string): Promise<User | null> {
  const { rows } = await db.query<UserRow>(`${USER_SELECT} WHERE u.username = $1`, [username]);
  const row = rows[0];
  return row ? toUser(row) : null;
}

export interface UserFilter {
  role?: Role | undefined;
  search?: string | undefined;
  includeInactive?: boolean | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
}

export async function listUsers(db: Db, filter: UserFilter): Promise<Paginated<User>> {
  const where = new WhereBuilder();
  // The system account owns walk-up jobs and cannot sign in. Showing it in the
  // user list would invite an admin to "fix" it and orphan every walk-up record.
  where.add('NOT u.is_system');
  if (!filter.includeInactive) where.add('u.is_active');
  where.addIf(filter.role, 'u.role = ?', filter.role);
  if (filter.search) {
    where.add(
      '(u.username ILIKE ? OR u.display_name ILIKE ? OR u.email ILIKE ? OR u.department ILIKE ?)',
      `%${filter.search}%`,
      `%${filter.search}%`,
      `%${filter.search}%`,
      `%${filter.search}%`,
    );
  }

  const limit = applyKeyset(where, {
    cursor: filter.cursor,
    limit: filter.limit,
    timestampColumn: 'u.created_at',
    idColumn: 'u.id',
  });
  const limitParam = where.push(limit + 1);

  const { rows } = await db.query<UserRow>(
    `${USER_SELECT} ${where.sql} ORDER BY u.created_at DESC, u.id DESC LIMIT ${limitParam}`,
    where.params,
  );
  return toPage(rows.map(toUser), limit, (user) => ({ t: user.createdAt, i: user.id }));
}

/* ------------------------------------------------------- credentials only  */

/** Never returned by a route. Consumed exclusively by services/auth. */
export interface UserCredentials {
  id: number;
  username: string;
  passwordHash: string | null;
  authProvider: string;
  role: Role;
  isActive: boolean;
  isSystem: boolean;
  mustChangePassword: boolean;
  failedLoginCount: number;
  firstFailedLoginAt: string | null;
  lockedUntil: string | null;
}

export async function findCredentials(db: Db, username: string): Promise<UserCredentials | null> {
  const { rows } = await db.query<{
    id: number;
    username: string;
    password_hash: string | null;
    auth_provider: string;
    role: Role;
    is_active: boolean;
    is_system: boolean;
    must_change_password: boolean;
    failed_login_count: number;
    first_failed_login_at: string | null;
    locked_until: string | null;
  }>(
    `SELECT id, username::text AS username, password_hash, auth_provider, role,
            is_active, is_system, must_change_password, failed_login_count,
            first_failed_login_at, locked_until
       FROM users WHERE username = $1`,
    [username],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    passwordHash: row.password_hash,
    authProvider: row.auth_provider,
    role: row.role,
    isActive: row.is_active,
    isSystem: row.is_system,
    mustChangePassword: row.must_change_password,
    failedLoginCount: row.failed_login_count,
    firstFailedLoginAt: row.first_failed_login_at,
    lockedUntil: row.locked_until,
  };
}

export async function findCredentialsById(db: Db, id: number): Promise<UserCredentials | null> {
  const { rows } = await db.query<{ username: string }>(
    'SELECT username::text AS username FROM users WHERE id = $1',
    [id],
  );
  const username = rows[0]?.username;
  return username ? findCredentials(db, username) : null;
}

/* ------------------------------------------------------------------ writes */

export interface UserInsert {
  username: string;
  email: string | null;
  displayName: string | null;
  /** Null when the person will choose their own through a set-password link. */
  passwordHash: string | null;
  role: Role;
  department: string | null;
  mustChangePassword: boolean;
}

export async function insertUser(db: Db, input: UserInsert): Promise<User> {
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO users (username, email, display_name, password_hash, role, department,
                        must_change_password, auth_provider)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'local')
     RETURNING id`,
    [
      input.username,
      input.email,
      input.displayName,
      input.passwordHash,
      input.role,
      input.department,
      input.mustChangePassword,
    ],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('user insert returned no id');
  const created = await findUser(db, id);
  if (!created) throw new Error('user disappeared immediately after insert');
  return created;
}

const UPDATABLE: Readonly<Record<string, string>> = {
  email: 'email',
  displayName: 'display_name',
  role: 'role',
  department: 'department',
  zoneId: 'zone_id',
  isActive: 'is_active',
  mustChangePassword: 'must_change_password',
};

export async function updateUser(
  db: Db,
  id: number,
  patch: Record<string, unknown>,
): Promise<User | null> {
  const assignments: string[] = [];
  const values: unknown[] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const column = UPDATABLE[key];
    if (!column) continue;
    values.push(value);
    assignments.push(`${column} = $${values.length}`);
  }
  if (assignments.length === 0) return findUser(db, id);
  values.push(id);
  await db.query(`UPDATE users SET ${assignments.join(', ')} WHERE id = $${values.length}`, values);
  return findUser(db, id);
}

export async function setPasswordHash(
  db: Db,
  id: number,
  passwordHash: string,
  mustChangePassword: boolean,
): Promise<void> {
  await db.query(
    `UPDATE users
        SET password_hash = $2,
            must_change_password = $3,
            failed_login_count = 0,
            first_failed_login_at = NULL,
            locked_until = NULL
      WHERE id = $1`,
    [id, passwordHash, mustChangePassword],
  );
}

/**
 * Records a failed sign-in and locks the account once the threshold is crossed.
 *
 * The window matters: ten failures spread over a month is a forgetful person,
 * ten within fifteen minutes is an attack. Counting without a window would lock
 * out the former and is the reason `first_failed_login_at` exists.
 */
export async function recordLoginFailure(
  db: Db,
  id: number,
  options: { windowMs: number; maxFailures: number; lockoutMs: number },
): Promise<{ locked: boolean; failures: number }> {
  const { rows } = await db.query<{ failed_login_count: number; locked_until: string | null }>(
    `UPDATE users
        SET first_failed_login_at = CASE
              WHEN first_failed_login_at IS NULL
                OR first_failed_login_at < now() - make_interval(secs => $2)
              THEN now() ELSE first_failed_login_at END,
            failed_login_count = CASE
              WHEN first_failed_login_at IS NULL
                OR first_failed_login_at < now() - make_interval(secs => $2)
              THEN 1 ELSE failed_login_count + 1 END
      WHERE id = $1
      RETURNING failed_login_count, locked_until`,
    [id, options.windowMs / 1000],
  );

  const failures = rows[0]?.failed_login_count ?? 0;
  if (failures < options.maxFailures) return { locked: false, failures };

  await db.query(
    `UPDATE users SET locked_until = now() + make_interval(secs => $2) WHERE id = $1`,
    [id, options.lockoutMs / 1000],
  );
  return { locked: true, failures };
}

export async function recordLoginSuccess(db: Db, id: number): Promise<void> {
  await db.query(
    `UPDATE users
        SET last_login_at = now(), failed_login_count = 0,
            first_failed_login_at = NULL, locked_until = NULL
      WHERE id = $1`,
    [id],
  );
}

/**
 * INV-01 — the single write path to user_printers.
 *
 * Implemented as delete-then-insert inside the caller's transaction rather than
 * as a diff, because the audit row records the before and after sets and a diff
 * would need the same read anyway.
 */
export async function setUserPrinters(
  db: Db,
  userId: number,
  printerIds: readonly number[],
  grantedBy: number | null,
): Promise<void> {
  await db.query('DELETE FROM user_printers WHERE user_id = $1', [userId]);
  if (printerIds.length === 0) return;
  await db.query(
    `INSERT INTO user_printers (user_id, printer_id, granted_by)
     SELECT $1, unnest($2::int[]), $3
     ON CONFLICT DO NOTHING`,
    [userId, [...printerIds], grantedBy],
  );
}

export async function getPermittedPrinterIds(db: Db, userId: number): Promise<number[]> {
  const { rows } = await db.query<{ printer_id: number }>(
    `SELECT printer_id FROM user_printers
      WHERE user_id = $1 AND (expires_at IS NULL OR expires_at > now())`,
    [userId],
  );
  return rows.map((row) => row.printer_id);
}

/** The walk-up job owner. Created by the seed and never editable. */
export async function getSystemUser(db: Db): Promise<{ id: number; username: string }> {
  const { rows } = await db.query<{ id: number; username: string }>(
    `SELECT id, username::text AS username FROM users WHERE is_system ORDER BY id LIMIT 1`,
  );
  const row = rows[0];
  if (!row) throw new Error('system user is missing — run the seed.');
  return row;
}

export async function countAdmins(db: Db): Promise<number> {
  const { rows } = await db.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM users WHERE role = 'admin' AND is_active AND NOT is_system`,
  );
  return rows[0]?.count ?? 0;
}

/**
 * Password hashes that could still be the seeded default (GAP-01).
 *
 * Narrowed to accounts that have never changed their password, because those
 * are the only ones that can hold it: `setPasswordHash` clears the flag on
 * every change, and `assertPasswordAcceptable` refuses the seeded value, so it
 * cannot be set back deliberately either. Normally this returns zero or one
 * row, where the unnarrowed query returned every account and cost the boot one
 * argon2 verify each.
 */
export async function listUnchangedPasswordHashes(
  db: Db,
): Promise<Array<{ id: number; hash: string }>> {
  const { rows } = await db.query<{ id: number; password_hash: string }>(
    `SELECT id, password_hash FROM users
      WHERE auth_provider = 'local' AND password_hash IS NOT NULL
        AND NOT is_system AND must_change_password`,
  );
  return rows.map((row) => ({ id: row.id, hash: row.password_hash }));
}

export const usersModel = {
  find: findUser,
  findByUsername: findUserByUsername,
  list: listUsers,
  findCredentials,
  findCredentialsById,
  insert: insertUser,
  update: updateUser,
  setPasswordHash,
  recordLoginFailure,
  recordLoginSuccess,
  setPrinters: setUserPrinters,
  getPermittedPrinterIds,
  getSystemUser,
  countAdmins,
  listUnchangedPasswordHashes,
} as const;
