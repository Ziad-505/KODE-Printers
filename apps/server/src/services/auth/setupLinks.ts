import { AppError, type SetupLink, type SetupLinkSubject } from '@kode/shared';
import { config } from '../../config/index.js';
import { pool, withTransaction } from '../../db/pool.js';
import { auditModel } from '../../models/audit.js';
import { passwordTokensModel, type SetupPurpose } from '../../models/passwordTokens.js';
import { refreshTokensModel } from '../../models/refreshTokens.js';
import { usersModel } from '../../models/users.js';
import { subsystem } from '../../utilities/logger.js';
import { assertPasswordAcceptable, login, type AuthContext, type Session } from './index.js';
import { generateSetupToken, hashPassword, hashToken } from './hash.js';

const log = subsystem('auth:setup-link');

/**
 * Set-password links (migration 003).
 *
 * The problem this replaces: an administrator typed a new person's first
 * password and then had to tell them what it was, which meant a working
 * credential travelling over WhatsApp. Everything else in this system works to
 * make the record trustworthy, and that one step made it impossible to say
 * that only the account's owner had ever known its password.
 *
 * A link fixes it without an email server. The administrator copies it and
 * sends it however they already reach that person; the person opens it and
 * chooses a password nobody else ever sees. The club's staff are reachable on
 * their phones, and an SMTP dependency that must work before anyone can sign
 * in would be a worse failure mode than a link that is pasted by hand.
 *
 * This module deliberately does not import anything that imports it: the
 * routes reach it directly, and it reaches `login` in the auth service. That
 * keeps the sign-in that follows a redemption on exactly the same path as any
 * other sign-in — same audit row, same lockout reset, same refresh cookie —
 * rather than a second, subtly different one.
 */

/**
 * How long a link lasts.
 *
 * A week for a new starter, who might be handed the link on a Friday and not
 * open it until Monday. One hour for a reset, because the reason someone needs
 * one is that they are locked out *now*, and a reset link that lingers for a
 * week is a standing key to an account whose owner has already lost track of
 * its password once.
 */
export const SETUP_TTL_SECONDS = 7 * 24 * 60 * 60;
export const RESET_TTL_SECONDS = 60 * 60;

/**
 * The refusal, worded once.
 *
 * Unknown, already used and expired all produce the same message on purpose.
 * A link is a bearer credential, and telling whoever holds it which of the
 * three it is tells them something about an account they may have no business
 * knowing exists.
 */
function linkRefused(): AppError {
  return new AppError(
    'SETUP_LINK_INVALID',
    'This link has already been used, or it has expired. Ask an administrator for a new one.',
  );
}

/**
 * Issues a link and returns the whole URL — once.
 *
 * Only the hash is stored, so this return value is the only readable form the
 * link ever takes. A caller that loses it mints another; there is no route
 * that can show it again.
 *
 * A reset additionally ends every session for the account. An administrator
 * doing this is answering either "I can't get in" or "I think someone else
 * can", and in the second case handing the owner a new password while leaving
 * the intruder signed in achieves nothing.
 */
export async function createSetupLink(
  userId: number,
  purpose: SetupPurpose,
  actor: { id: number; username: string },
  context: AuthContext,
): Promise<SetupLink> {
  const user = await usersModel.find(pool, userId);
  if (!user) throw new AppError('NOT_FOUND', 'That account no longer exists.');
  if (user.isSystem) {
    throw new AppError('FORBIDDEN', 'The system account cannot be signed in to.');
  }
  if (!user.isActive) {
    throw new AppError(
      'CONFLICT',
      `${user.displayName ?? user.username} is turned off. Turn the account back on first.`,
    );
  }

  const { token, hash } = generateSetupToken();
  const ttl = purpose === 'reset' ? RESET_TTL_SECONDS : SETUP_TTL_SECONDS;
  const expiresAt = new Date(Date.now() + ttl * 1000);

  await withTransaction(async (tx) => {
    // `mint` revokes whatever was outstanding in the same transaction, so
    // reissuing a link cannot leave the previous one working.
    await passwordTokensModel.mint(tx, {
      userId,
      tokenHash: hash,
      purpose,
      createdBy: actor.id,
      expiresAt,
    });

    if (purpose === 'reset') {
      await refreshTokensModel.revokeAllForUser(tx, userId);
    }

    await auditModel.write(tx, {
      actorUserId: actor.id,
      actorUsername: actor.username,
      action: 'user.setup_link',
      entityType: 'user',
      entityId: userId,
      // The link never enters the audit payload. That table is the one an
      // operator reads casually and exports freely, which makes it the worst
      // possible place for a working credential. INV-08.
      after: { purpose, expiresAt: expiresAt.toISOString(), subject: user.username },
      ipAddress: context.ip,
      requestId: context.requestId,
    });
  });

  log.info({ userId, purpose, actorId: actor.id }, 'set-password link issued');

  return {
    url: `${config.http.publicUrl}/set-password/${token}`,
    purpose,
    expiresAt: expiresAt.toISOString(),
    user: { id: user.id, username: user.username, displayName: user.displayName },
  };
}

/**
 * What the set-password page may know before anyone has proved anything.
 *
 * Deliberately thin: a name so the page can greet the right person, and the
 * expiry so it can say when the link dies. No email, no role, no printer
 * grants — whoever is holding this link is not yet known to be its owner.
 */
export async function describeSetupLink(rawToken: string): Promise<SetupLinkSubject> {
  const stored = await passwordTokensModel.findByHash(pool, hashToken(rawToken));
  if (stored?.consumedAt !== null) throw linkRefused();
  if (Date.parse(stored.expiresAt) <= Date.now()) throw linkRefused();

  const user = await usersModel.find(pool, stored.userId);
  if (!user?.isActive || user.isSystem) throw linkRefused();

  return {
    username: user.username,
    displayName: user.displayName,
    purpose: stored.purpose,
    expiresAt: stored.expiresAt,
  };
}

/**
 * Redeems a link: sets the password, burns the token, signs the person in.
 *
 * They are signed in rather than returned to the sign-in form. They proved
 * possession of a single-use secret and chose a password thirty seconds ago;
 * making them type it again immediately buys nothing and is exactly the step
 * where someone gives up and telephones the office.
 *
 * The consume is checked for its row count *inside* the transaction. Two tabs
 * submitting the same link at once must not both succeed, and this is the only
 * place that race is settled.
 */
export async function redeemSetupLink(
  rawToken: string,
  newPassword: string,
  context: AuthContext,
): Promise<Session> {
  const stored = await passwordTokensModel.findByHash(pool, hashToken(rawToken));
  if (stored?.consumedAt !== null) throw linkRefused();
  if (Date.parse(stored.expiresAt) <= Date.now()) throw linkRefused();

  const user = await usersModel.find(pool, stored.userId);
  if (!user?.isActive || user.isSystem) throw linkRefused();

  // The same policy a password change is held to. Checked before the token is
  // spent, so a refused password leaves the link usable.
  assertPasswordAcceptable(newPassword, user.username);
  const passwordHash = await hashPassword(newPassword);

  await withTransaction(async (tx) => {
    const claimed = await passwordTokensModel.consume(tx, stored.id);
    if (!claimed) throw linkRefused();

    // `false`: they chose this password themselves, so there is nothing to
    // force a rotation of. `must_change_password` exists for passwords that
    // somebody else picked.
    await usersModel.setPasswordHash(tx, user.id, passwordHash, false);

    // Every session that existed before this moment predates the new password.
    // For a reset that is the entire point; for a first-time setup there are
    // none, and revoking nothing costs nothing.
    await refreshTokensModel.revokeAllForUser(tx, user.id);

    await auditModel.write(tx, {
      actorUserId: user.id,
      actorUsername: user.username,
      action: 'user.password_chosen',
      entityType: 'user',
      entityId: user.id,
      after: { purpose: stored.purpose, self: true },
      ipAddress: context.ip,
      requestId: context.requestId,
    });
  });

  log.info({ userId: user.id, purpose: stored.purpose }, 'password chosen through a link');

  /* Straight through the ordinary sign-in.
   *
   * Not a shortcut that mints tokens here: `login` also writes the
   * auth.login_success row, clears the failed-attempt counter, stamps
   * last_login_at and applies the seeded-password re-check. Duplicating four
   * of those five correctly and forgetting the fifth is precisely how a second
   * sign-in path drifts from the real one. */
  return login(user.username, newPassword, false, context);
}
