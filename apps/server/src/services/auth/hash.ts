import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import argon2 from 'argon2';

/**
 * Password and token hashing.
 *
 * §B12.3 says new deployments SHOULD use argon2id. This one does, with no
 * bcrypt path at all — a "legacy" branch on a greenfield build is a downgrade
 * attack waiting for someone to set the wrong flag.
 */

/**
 * Argon2id parameters.
 *
 * 64 MiB and three passes is the OWASP-recommended floor and takes roughly
 * 100 ms on the target VM's 4 vCPU. That is slow enough to make offline
 * cracking expensive and fast enough that thirty concurrent users signing in
 * after lunch do not queue behind each other — the login rate limit of 10/min
 * caps the worst case well below the pool's capacity anyway.
 */
const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 65_536, // 64 MiB
  timeCost: 3,
  parallelism: 4,
} as const;

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, ARGON2_OPTIONS);
}

/**
 * Verifies a password.
 *
 * Returns false rather than throwing on a malformed stored hash: a corrupted
 * row should deny access, not produce a 500 that tells an attacker the account
 * exists and is interesting.
 */
export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

/**
 * Whether a stored hash was produced with weaker parameters than current policy.
 *
 * Used to transparently re-hash on successful sign-in, so raising the cost
 * later upgrades every account as people log in rather than requiring a reset.
 */
export function needsRehash(hash: string): boolean {
  try {
    return argon2.needsRehash(hash, ARGON2_OPTIONS);
  } catch {
    return true;
  }
}

/* ------------------------------------------------------------------ tokens */

/**
 * Refresh tokens are random, opaque and stored hashed.
 *
 * SHA-256 rather than argon2 here, deliberately: the token is 256 bits of
 * entropy from a CSPRNG, so there is no dictionary to attack and a slow hash
 * buys nothing except latency on every refresh. Argon2's cost exists to defend
 * *low-entropy* secrets.
 */
export function generateRefreshToken(): { token: string; hash: string } {
  const token = randomBytes(48).toString('base64url');
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Collector API keys, same reasoning as refresh tokens. Shown once (INV-08). */
export function generateApiKey(): { key: string; hash: string; prefix: string } {
  const key = `kode_${randomBytes(32).toString('base64url')}`;
  return { key, hash: hashToken(key), prefix: key.slice(0, 12) };
}

/**
 * Constant-time comparison of two hex digests.
 *
 * `===` on a hash leaks its prefix through timing. That is a marginal attack
 * over a LAN, but the correct comparison costs one function call.
 */
export function safeCompare(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}

/**
 * A small denylist of passwords that pass the 12-character rule but are
 * trivially guessable (§B12.4, GAP-18).
 *
 * Not a substitute for a real breach corpus — the deployment notes point at
 * Have I Been Pwned's k-anonymity API for that — but it catches what people
 * actually type when told "at least twelve characters", which is
 * `Password1234`.
 */
const OBVIOUS_PASSWORDS: ReadonlySet<string> = new Set([
  'password1234',
  'passwordpassword',
  '123456789012',
  'qwertyuiop12',
  'letmein12345',
  'welcome12345',
  'kodeprinter1',
  'kodesportsclub',
  'administrator',
  'changeme1234',
  'admin1234567',
  'printer12345',
]);

export function isObviousPassword(password: string): boolean {
  // The seeded default is printed to a console at install time and quoted in
  // the runbook, so it is public by construction. Refusing it here is what
  // makes `must_change_password` a reliable marker for "might still hold it",
  // which is what lets the boot check scan one row instead of every account.
  if (password === SEEDED_DEFAULT_PASSWORD) return true;

  const normalised = password.toLowerCase().replace(/\s+/g, '');
  if (OBVIOUS_PASSWORDS.has(normalised)) return true;
  // A single repeated character or a straight run of digits.
  if (/^(.)\1+$/.test(normalised)) return true;
  if (/^(?:0123456789|1234567890)\d*$/.test(normalised)) return true;
  return false;
}

/**
 * The seeded default, kept in one place so the GAP-01 boot guard and the seed
 * script cannot disagree about what "still the default password" means.
 */
export const SEEDED_DEFAULT_PASSWORD = 'KodePrinter!Setup2026';

/**
 * Set-password links. Random, opaque, stored hashed — same reasoning as a
 * refresh token: 256 bits from a CSPRNG has no dictionary to attack, so a slow
 * hash would buy latency and nothing else.
 *
 * base64url because the value goes in a URL path and is pasted by hand into a
 * chat window; `+`, `/` and `=` all survive that badly.
 */
export function generateSetupToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}
