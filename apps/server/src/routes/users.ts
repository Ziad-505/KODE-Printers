import { Router } from 'express';
import { z } from 'zod';
import {
  AppError,
  errors,
  idSchema,
  setupLinkSchema,
  setUserPasswordSchema,
  setUserPrintersSchema,
  userCreateSchema,
  userQuerySchema,
  userUpdateSchema,
} from '@kode/shared';
import { pool } from '../db/pool.js';
import { refreshTokensModel } from '../models/refreshTokens.js';
import { usersModel } from '../models/users.js';
import {
  actorOf,
  authenticate,
  requireAdmin,
  requirePasswordChanged,
} from '../middlewares/auth.js';
import { asyncHandler } from '../middlewares/context.js';
import {
  body,
  params,
  query,
  validateBody,
  validateParams,
  validateQuery,
} from '../middlewares/validate.js';
import { auditedMutation } from '../services/audit.js';
import { events } from '../services/events.js';
import { assertPasswordAcceptable } from '../services/auth/index.js';
import { createSetupLink } from '../services/auth/setupLinks.js';
import { hashPassword } from '../services/auth/hash.js';
import { clientIp } from '../middlewares/context.js';

export const usersRouter = Router();

const idParams = z.object({ id: idSchema });

// Every route here is admin-only, so the guards are mounted once rather than
// repeated per handler — a per-handler list is one omission away from a hole.
usersRouter.use(authenticate, requirePasswordChanged, requireAdmin);

usersRouter.get(
  '/',
  validateQuery(userQuerySchema),
  asyncHandler(async (req, res) => {
    res.json(await usersModel.list(pool, query(req, userQuerySchema)));
  }),
);

usersRouter.get(
  '/:id',
  validateParams(idParams),
  asyncHandler(async (req, res) => {
    const { id } = params(req, idParams);
    const user = await usersModel.find(pool, id);
    if (!user) throw errors.notFound('User', id);
    res.json(user);
  }),
);

usersRouter.post(
  '/',
  validateBody(userCreateSchema),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const input = body(req, userCreateSchema);

    /* No password unless one was explicitly supplied.
     *
     * An administrator who types a password has to transmit it, and the only
     * channels available are the ones this system cannot audit. The default
     * path creates the account with no password at all and mints a single-use
     * link below, which the administrator copies and sends. */
    let passwordHash: string | null = null;
    if (input.password !== undefined) {
      assertPasswordAcceptable(input.password, input.username);
      passwordHash = await hashPassword(input.password);
    }

    const user = await auditedMutation(
      async (tx) => {
        const created = await usersModel.insert(tx, {
          username: input.username,
          email: input.email ?? null,
          displayName: input.displayName ?? null,
          passwordHash,
          role: input.role,
          department: input.department ?? null,
          // Nothing to force a rotation of when they will pick it themselves.
          mustChangePassword: passwordHash === null ? false : input.mustChangePassword,
        });

        if (input.printerIds.length > 0) {
          // INV-01 — the only write path to user_printers, inside the same
          // transaction as the user create so a partial grant cannot survive.
          await usersModel.setPrinters(tx, created.id, input.printerIds, actor.id);
        }

        const withGrants = await usersModel.find(tx, created.id);
        return withGrants ?? created;
      },
      { req, action: 'user.create', entityType: 'user', entityId: (created) => created.id },
    );

    /* The link is minted after the account commits, not inside it.
     *
     * It is a separate, separately audited act, and a failure here must leave a
     * usable account rather than rolling back a person who was created
     * correctly. An administrator who ends up without a link presses "New
     * link"; one who ends up without an account has to start again. */
    const setupLink =
      passwordHash === null
        ? await createSetupLink(user.id, 'setup', actor, {
            ip: clientIp(req),
            userAgent: req.get('user-agent')?.slice(0, 300) ?? null,
            requestId: req.requestId,
          })
        : null;

    res.status(201).json({ user, setupLink });
  }),
);

/**
 * Mint a set-password or reset link for someone.
 *
 * The whole URL comes back exactly once, for the administrator to copy. Only
 * its hash is stored, so there is no route that can show it again — losing it
 * means minting another, which is a button, not a problem.
 */
usersRouter.post(
  '/:id/setup-link',
  validateParams(idParams),
  validateBody(setupLinkSchema),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const { id } = params(req, idParams);
    const { purpose } = body(req, setupLinkSchema);

    const link = await createSetupLink(id, purpose, actor, {
      ip: clientIp(req),
      userAgent: req.get('user-agent')?.slice(0, 300) ?? null,
      requestId: req.requestId,
    });

    res.status(201).json(link);
  }),
);

usersRouter.put(
  '/:id',
  validateParams(idParams),
  validateBody(userUpdateSchema),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const { id } = params(req, idParams);
    const patch = body(req, userUpdateSchema);

    const before = await usersModel.find(pool, id);
    if (!before) throw errors.notFound('User', id);
    if (before.isSystem) throw errors.forbidden('The system account cannot be edited.');

    await assertNotLastAdmin(before, patch, actor.id, id);

    const updated = await auditedMutation(async (tx) => usersModel.update(tx, id, patch), {
      req,
      action: 'user.update',
      entityType: 'user',
      entityId: id,
      before,
    });

    res.json(updated);
  }),
);

usersRouter.put(
  '/:id/active',
  validateParams(idParams),
  validateBody(z.object({ isActive: z.boolean() })),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const { id } = params(req, idParams);
    const { isActive } = body(req, z.object({ isActive: z.boolean() }));

    const before = await usersModel.find(pool, id);
    if (!before) throw errors.notFound('User', id);
    if (before.isSystem) throw errors.forbidden('The system account cannot be disabled.');

    await assertNotLastAdmin(before, { isActive }, actor.id, id);

    const updated = await auditedMutation(
      async (tx) => {
        const result = await usersModel.update(tx, id, { isActive });
        // Disabling an account must end its sessions immediately. Leaving a
        // valid refresh token behind means "disabled" takes effect whenever the
        // access token happens to expire, which is not what an admin means when
        // they disable someone mid-incident.
        if (!isActive) await refreshTokensModel.revokeAllForUser(tx, id);
        return result;
      },
      { req, action: 'user.deactivate', entityType: 'user', entityId: id, before },
    );

    res.json(updated);
  }),
);

usersRouter.put(
  '/:id/password',
  validateParams(idParams),
  validateBody(setUserPasswordSchema),
  asyncHandler(async (req, res) => {
    const { id } = params(req, idParams);
    const input = body(req, setUserPasswordSchema);

    const user = await usersModel.find(pool, id);
    if (!user) throw errors.notFound('User', id);
    if (user.isSystem) throw errors.forbidden('The system account has no password.');

    assertPasswordAcceptable(input.password, user.username);
    const passwordHash = await hashPassword(input.password);

    await auditedMutation(
      async (tx) => {
        await usersModel.setPasswordHash(tx, id, passwordHash, input.mustChangePassword);
        // An admin-set password ends every session for that account. If the
        // reset was prompted by a suspected compromise, leaving the attacker's
        // session alive defeats it.
        await refreshTokensModel.revokeAllForUser(tx, id);
      },
      {
        req,
        action: 'user.password_set',
        entityType: 'user',
        entityId: id,
        // The hash never enters the audit payload — `redactForAudit` would
        // catch it, but not putting it there is better than relying on that.
        after: { mustChangePassword: input.mustChangePassword, byAdmin: true },
      },
    );

    res.json({ ok: true, mustChangePassword: input.mustChangePassword });
  }),
);

/**
 * INV-01 — the only write path to `user_printers`.
 *
 * The whole set is replaced rather than diffed, so the audit row holds the
 * before and after sets and "who could use what on this date" is answerable
 * from the log alone.
 */
usersRouter.put(
  '/:id/printers',
  validateParams(idParams),
  validateBody(setUserPrintersSchema),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const { id } = params(req, idParams);
    const { printerIds } = body(req, setUserPrintersSchema);

    const before = await usersModel.find(pool, id);
    if (!before) throw errors.notFound('User', id);
    if (before.isSystem) throw errors.forbidden('The system account holds no printer grants.');

    const updated = await auditedMutation(
      async (tx) => {
        await usersModel.setPrinters(tx, id, printerIds, actor.id);
        return usersModel.find(tx, id);
      },
      {
        req,
        action: 'user.printers_set',
        entityType: 'user',
        entityId: id,
        before: { printerIds: before.printerIds ?? [] },
        after: { printerIds },
      },
    );

    // The live stream resolves permitted printers once at connect time, so a
    // revoked grant would otherwise keep delivering that printer's events until
    // the user happened to reconnect. Ending the stream makes it take effect now.
    events.closeForUser(id);

    res.json(updated);
  }),
);

/**
 * Deleting a user is allowed; their job history survives.
 *
 * `jobs.user_id` is ON DELETE SET NULL and `username_snapshot` was written at
 * insert time (INV-06), so the record stays readable — "who printed this" still
 * has an answer after the person leaves the club.
 */
usersRouter.delete(
  '/:id',
  validateParams(idParams),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const { id } = params(req, idParams);

    const user = await usersModel.find(pool, id);
    if (!user) throw errors.notFound('User', id);
    if (user.isSystem) throw errors.forbidden('The system account cannot be deleted.');
    if (user.id === actor.id) throw errors.forbidden('You cannot delete your own account.');

    await assertNotLastAdmin(user, { isActive: false }, actor.id, id);

    await auditedMutation(
      async (tx) => {
        await tx.query('DELETE FROM users WHERE id = $1', [id]);
      },
      {
        req,
        action: 'user.deactivate',
        entityType: 'user',
        entityId: id,
        before: user,
        after: null,
      },
    );

    res.status(204).end();
  }),
);

/**
 * Refuses the change that locks everyone out.
 *
 * Demoting or disabling the last active admin leaves a system nobody can
 * administer, recoverable only by editing the database directly. §B19.1 asks
 * for a second admin account before go-live; this makes losing the last one
 * impossible rather than merely inadvisable.
 */
async function assertNotLastAdmin(
  target: { id: number; role: string; isActive: boolean },
  patch: { role?: string | undefined; isActive?: boolean | undefined },
  actorId: number,
  targetId: number,
): Promise<void> {
  const losingAdmin =
    target.role === 'admin' &&
    target.isActive &&
    ((patch.role !== undefined && patch.role !== 'admin') || patch.isActive === false);

  if (!losingAdmin) return;

  const remaining = await usersModel.countAdmins(pool);
  if (remaining > 1) return;

  throw new AppError(
    'CONFLICT',
    targetId === actorId
      ? 'You are the only administrator. Promote someone else before changing your own account.'
      : 'This is the only administrator account. Promote someone else first.',
    { details: { adminCount: remaining } },
  );
}
