import type { Db } from '../db/pool.js';

/**
 * Single-use links for choosing a password (migration 003).
 *
 * Stored hashed, like refresh tokens and collector keys, and for the same
 * reason: the raw value is shown to the administrator once and is not
 * recoverable afterwards. A database dump therefore contains no usable link.
 *
 * The `live` unique index does the interesting work. Minting a second link for
 * someone must invalidate the first — an administrator reissuing a link because
 * the old one went to the wrong number is expressing exactly that intent — so
 * `mint` consumes any outstanding one inside the same transaction rather than
 * leaving two doors open.
 */

export type SetupPurpose = 'setup' | 'reset';

export interface StoredSetupToken {
  id: number;
  userId: number;
  purpose: SetupPurpose;
  expiresAt: string;
  consumedAt: string | null;
}

export interface MintInput {
  userId: number;
  tokenHash: string;
  purpose: SetupPurpose;
  createdBy: number | null;
  expiresAt: Date;
}

/**
 * Issues a link, replacing whatever was outstanding for that person.
 *
 * Takes the caller's transaction: the revoke and the insert have to commit
 * together, or a failure between them leaves an account whose only working
 * link has just been thrown away.
 */
export async function mintToken(db: Db, input: MintInput): Promise<number> {
  await revokeLiveTokens(db, input.userId);

  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO password_setup_tokens (user_id, token_hash, purpose, created_by, expires_at)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [input.userId, input.tokenHash, input.purpose, input.createdBy, input.expiresAt.toISOString()],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('setup token insert returned no id');
  return id;
}

/**
 * Looks a presented link up by its hash.
 *
 * Returns the row whatever state it is in — expired, already used — because
 * the caller has to tell those apart from "no such link" for the message it
 * shows, even though all three refuse.
 */
export async function findByHash(db: Db, tokenHash: string): Promise<StoredSetupToken | null> {
  const { rows } = await db.query<{
    id: number;
    user_id: number;
    purpose: SetupPurpose;
    expires_at: string;
    consumed_at: string | null;
  }>(
    `SELECT id, user_id, purpose, expires_at, consumed_at
       FROM password_setup_tokens WHERE token_hash = $1`,
    [tokenHash],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    purpose: row.purpose,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
  };
}

/**
 * Marks a link used.
 *
 * Conditional on it still being unused, and the caller checks the row count:
 * two tabs redeeming the same link concurrently must not both succeed, and
 * this is the only place that race is decided.
 */
export async function consumeToken(db: Db, id: number): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE password_setup_tokens SET consumed_at = now()
      WHERE id = $1 AND consumed_at IS NULL`,
    [id],
  );
  return (rowCount ?? 0) > 0;
}

export async function revokeLiveTokens(db: Db, userId: number): Promise<number> {
  const { rowCount } = await db.query(
    `UPDATE password_setup_tokens SET consumed_at = now()
      WHERE user_id = $1 AND consumed_at IS NULL`,
    [userId],
  );
  return rowCount ?? 0;
}

/** The outstanding link's expiry, for the "waiting to set a password" list. */
export async function liveTokenExpiry(db: Db, userId: number): Promise<string | null> {
  const { rows } = await db.query<{ expires_at: string }>(
    `SELECT expires_at FROM password_setup_tokens
      WHERE user_id = $1 AND consumed_at IS NULL AND expires_at > now()
      LIMIT 1`,
    [userId],
  );
  return rows[0]?.expires_at ?? null;
}

/**
 * Removes spent and expired rows.
 *
 * Kept a week past expiry so an administrator asking "did she ever use that
 * link?" still has an answer; after that the row is only clutter.
 */
export async function purgeSpentTokens(db: Db, graceDays = 7): Promise<number> {
  const { rowCount } = await db.query(
    `DELETE FROM password_setup_tokens
      WHERE (consumed_at IS NOT NULL AND consumed_at < now() - make_interval(days => $1))
         OR expires_at < now() - make_interval(days => $1)`,
    [graceDays],
  );
  return rowCount ?? 0;
}

export const passwordTokensModel = {
  mint: mintToken,
  findByHash,
  consume: consumeToken,
  revokeLive: revokeLiveTokens,
  liveExpiry: liveTokenExpiry,
  purgeSpent: purgeSpentTokens,
} as const;
