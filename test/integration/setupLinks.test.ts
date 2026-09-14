import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../../apps/server/src/db/pool.js';
import { usersModel } from '../../apps/server/src/models/users.js';
import { passwordTokensModel } from '../../apps/server/src/models/passwordTokens.js';
import { refreshTokensModel } from '../../apps/server/src/models/refreshTokens.js';
import { auditModel } from '../../apps/server/src/models/audit.js';
import {
  createSetupLink,
  describeSetupLink,
  redeemSetupLink,
} from '../../apps/server/src/services/auth/setupLinks.js';
import { login } from '../../apps/server/src/services/auth/index.js';
import { closeDatabase, hasDatabase, resetDatabase, type TestContext } from './helpers.js';

afterAll(async () => {
  await closeDatabase();
});

/**
 * Set-password links (migration 003).
 *
 * These are integration tests rather than unit tests because everything worth
 * asserting here lives in the database: the partial unique index that allows
 * exactly one live link per person, the conditional UPDATE that makes
 * redemption single-use under concurrency, and the cascade that ties a link to
 * its account. A mocked store would test the mock.
 */

const available = await hasDatabase();
const suite = available ? describe : describe.skip;

if (!available) {
  console.warn(
    '\n  ⚠ Set-password link tests skipped: no PostgreSQL at DATABASE_URL.' +
      '\n    Start one with:  docker compose up -d db\n',
  );
}

const CONTEXT = { ip: '10.20.3.9', userAgent: 'vitest', requestId: 'test-request' };
const GOOD_PASSWORD = 'quiet harbour lantern';

let context: TestContext;
let actor: { id: number; username: string };

/** The raw token out of a minted URL — the only place it exists readable. */
const tokenOf = (url: string): string => url.split('/set-password/')[1] ?? '';

suite('set-password links', () => {
  beforeEach(async () => {
    context = await resetDatabase();
    actor = { id: context.adminId, username: 'testadmin' };
  });

  it('creates an account with no password, then lets the person choose one', async () => {
    const created = await usersModel.insert(pool, {
      username: 'sara.kamal',
      email: null,
      displayName: 'Sara Kamal',
      // The whole point: nobody types a password for her.
      passwordHash: null,
      role: 'user',
      department: null,
      mustChangePassword: false,
    });

    expect(created.hasPassword).toBe(false);

    const link = await createSetupLink(created.id, 'setup', actor, CONTEXT);
    expect(link.url).toContain('/set-password/');
    expect(link.purpose).toBe('setup');

    // The page can greet her before she has proved anything.
    const subject = await describeSetupLink(tokenOf(link.url));
    expect(subject.displayName).toBe('Sara Kamal');
    expect(subject.username).toBe('sara.kamal');

    const session = await redeemSetupLink(tokenOf(link.url), GOOD_PASSWORD, CONTEXT);

    // She comes out signed in rather than back at the form.
    expect(session.result.accessToken).toBeTruthy();
    expect(session.result.user.username).toBe('sara.kamal');
    // She picked it herself, so there is nothing to force a rotation of.
    expect(session.result.mustChangePassword).toBe(false);

    const after = await usersModel.find(pool, created.id);
    expect(after?.hasPassword).toBe(true);
    expect(after?.setupLinkExpiresAt).toBeNull();

    // And the ordinary sign-in works from then on.
    const signedIn = await login('sara.kamal', GOOD_PASSWORD, false, CONTEXT);
    expect(signedIn.result.user.id).toBe(created.id);
  });

  it('refuses the same link a second time', async () => {
    const link = await createSetupLink(context.userId, 'setup', actor, CONTEXT);
    const token = tokenOf(link.url);

    await redeemSetupLink(token, GOOD_PASSWORD, CONTEXT);

    await expect(redeemSetupLink(token, 'another good passphrase', CONTEXT)).rejects.toMatchObject({
      code: 'SETUP_LINK_INVALID',
    });
    // And the page behind it stops describing anyone.
    await expect(describeSetupLink(token)).rejects.toMatchObject({ code: 'SETUP_LINK_INVALID' });
  });

  it('invalidates the previous link when a new one is issued', async () => {
    const first = await createSetupLink(context.userId, 'setup', actor, CONTEXT);
    const second = await createSetupLink(context.userId, 'setup', actor, CONTEXT);

    // An administrator reissuing a link because the old one went to the wrong
    // number must not leave the old one working.
    await expect(redeemSetupLink(tokenOf(first.url), GOOD_PASSWORD, CONTEXT)).rejects.toMatchObject(
      { code: 'SETUP_LINK_INVALID' },
    );

    const session = await redeemSetupLink(tokenOf(second.url), GOOD_PASSWORD, CONTEXT);
    expect(session.result.user.id).toBe(context.userId);
  });

  it('refuses a link that has passed its expiry', async () => {
    const link = await createSetupLink(context.userId, 'setup', actor, CONTEXT);

    await pool.query(
      `UPDATE password_setup_tokens SET expires_at = now() - interval '1 minute'
        WHERE user_id = $1 AND consumed_at IS NULL`,
      [context.userId],
    );

    await expect(redeemSetupLink(tokenOf(link.url), GOOD_PASSWORD, CONTEXT)).rejects.toMatchObject({
      code: 'SETUP_LINK_INVALID',
    });
  });

  it('refuses a token nobody ever issued', async () => {
    await expect(describeSetupLink('this-token-was-never-minted-at-all')).rejects.toMatchObject({
      code: 'SETUP_LINK_INVALID',
    });
  });

  it('ends existing sessions the moment a reset link is made', async () => {
    // She is signed in somewhere.
    const before = await login('testuser', 'integration-test-password-2026', false, CONTEXT);
    expect(before.result.accessToken).toBeTruthy();

    await createSetupLink(context.userId, 'reset', actor, CONTEXT);

    // An administrator issuing a reset may be answering "I think someone else
    // can get in". Leaving that session alive would defeat the point.
    const { rows } = await pool.query<{ live: number }>(
      `SELECT count(*)::int AS live FROM refresh_tokens
        WHERE user_id = $1 AND revoked_at IS NULL`,
      [context.userId],
    );
    expect(rows[0]?.live).toBe(0);
  });

  it('leaves the link usable when the chosen password is refused', async () => {
    const link = await createSetupLink(context.userId, 'setup', actor, CONTEXT);
    const token = tokenOf(link.url);

    // Contains the username — refused by the same policy a password change is
    // held to. The token must survive, or one typo burns the link.
    await expect(redeemSetupLink(token, 'testuser-is-my-password', CONTEXT)).rejects.toMatchObject({
      code: 'PASSWORD_POLICY_VIOLATION',
    });

    const session = await redeemSetupLink(token, GOOD_PASSWORD, CONTEXT);
    expect(session.result.user.id).toBe(context.userId);
  });

  it('lets only one of two simultaneous redemptions win', async () => {
    const link = await createSetupLink(context.userId, 'setup', actor, CONTEXT);
    const token = tokenOf(link.url);

    // Two tabs, one link. The conditional UPDATE inside the transaction is the
    // only thing standing between this and two different passwords being set.
    const results = await Promise.allSettled([
      redeemSetupLink(token, GOOD_PASSWORD, CONTEXT),
      redeemSetupLink(token, 'a different quiet passphrase', CONTEXT),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled).toHaveLength(1);
  });

  it('records the issue and the redemption without ever storing the link', async () => {
    const link = await createSetupLink(context.userId, 'setup', actor, CONTEXT);
    await redeemSetupLink(tokenOf(link.url), GOOD_PASSWORD, CONTEXT);

    const page = await auditModel.list(pool, { limit: 50 });
    const actions = page.items.map((entry) => entry.action);
    expect(actions).toContain('user.setup_link');
    expect(actions).toContain('user.password_chosen');

    // The audit log is the table an operator reads casually and exports
    // freely, which makes it the worst possible place for a working
    // credential. INV-08.
    const serialised = JSON.stringify(page.items);
    expect(serialised).not.toContain(tokenOf(link.url));
  });

  it('will not issue a link for the system account', async () => {
    await expect(
      createSetupLink(context.systemUserId, 'setup', actor, CONTEXT),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('will not issue a link for an account that has been turned off', async () => {
    await usersModel.update(pool, context.userId, { isActive: false });

    await expect(createSetupLink(context.userId, 'setup', actor, CONTEXT)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('reports an outstanding link on the account, and clears it once used', async () => {
    const link = await createSetupLink(context.userId, 'setup', actor, CONTEXT);

    const waiting = await usersModel.find(pool, context.userId);
    expect(waiting?.setupLinkExpiresAt).not.toBeNull();
    expect(await passwordTokensModel.liveExpiry(pool, context.userId)).not.toBeNull();

    await redeemSetupLink(tokenOf(link.url), GOOD_PASSWORD, CONTEXT);

    const done = await usersModel.find(pool, context.userId);
    expect(done?.setupLinkExpiresAt).toBeNull();
  });

  it('sweeps spent links away after their grace period', async () => {
    await createSetupLink(context.userId, 'setup', actor, CONTEXT);
    await pool.query(
      `UPDATE password_setup_tokens
          SET consumed_at = now() - interval '30 days', expires_at = now() - interval '30 days'`,
    );

    const purged = await passwordTokensModel.purgeSpent(pool);
    expect(purged).toBeGreaterThan(0);
  });

  it('does not sweep a link that is still live', async () => {
    await createSetupLink(context.userId, 'setup', actor, CONTEXT);
    expect(await passwordTokensModel.purgeSpent(pool)).toBe(0);
    expect(await refreshTokensModel.purgeExpired(pool)).toBe(0);
  });
});
