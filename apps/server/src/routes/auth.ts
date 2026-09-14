import { Router } from 'express';
import { z } from 'zod';
import {
  changePasswordSchema,
  errors,
  loginSchema,
  pushSubscriptionSchema,
  redeemSetupLinkSchema,
} from '@kode/shared';
import { config } from '../config/index.js';
import { pool } from '../db/pool.js';
import { usersModel } from '../models/users.js';
import { authenticate, actorOf } from '../middlewares/auth.js';
import { asyncHandler, clientIp } from '../middlewares/context.js';
import { loginLimiter, setPasswordLimiter } from '../middlewares/rateLimit.js';
import { body, params, validateBody, validateParams } from '../middlewares/validate.js';
import * as auth from '../services/auth/index.js';
import { describeSetupLink, redeemSetupLink } from '../services/auth/setupLinks.js';
import { savePushSubscription } from '../services/notify.js';

export const authRouter = Router();

/**
 * The refresh token travels as an httpOnly cookie, not in the JSON body.
 *
 * A refresh token in a response body has to be stored by the client, and every
 * available store — localStorage, sessionStorage, a JS variable — is readable
 * by injected script. httpOnly removes that entire class of theft. The access
 * token stays in memory on the client, where its 15-minute lifetime bounds the
 * damage.
 *
 * `sameSite: 'strict'` is affordable because this is a first-party internal
 * app: there is no cross-site flow that needs the cookie to travel.
 */
const REFRESH_COOKIE = 'kode_refresh';

/**
 * @param maxAgeSeconds Lifetime of the token this cookie carries.
 *
 * Taken from the issued token rather than from the remembered TTL. When it was
 * the latter unconditionally, an ordinary sign-in got a thirty-day cookie
 * wrapped around a seven-day token: the browser kept presenting something the
 * server had already stopped honouring, so the session ended in a rejected
 * refresh rather than by quietly expiring.
 */
function refreshCookieOptions(maxAgeSeconds: number): {
  httpOnly: true;
  secure: boolean;
  sameSite: 'strict';
  path: string;
  maxAge: number;
} {
  return {
    httpOnly: true,
    // TLS terminates at the reverse proxy (§B18.3), so the cookie is only
    // marked secure where the deployment actually serves HTTPS.
    secure: config.isProduction,
    sameSite: 'strict',
    path: '/api/auth',
    maxAge: maxAgeSeconds * 1000,
  };
}

authRouter.post(
  '/login',
  loginLimiter,
  validateBody(loginSchema),
  asyncHandler(async (req, res) => {
    const input = body(req, loginSchema);
    const { result, refreshToken, refreshMaxAgeSeconds } = await auth.login(
      input.username,
      input.password,
      input.rememberMe,
      {
        ip: clientIp(req),
        userAgent: req.get('user-agent')?.slice(0, 300) ?? null,
        requestId: req.requestId,
      },
    );

    res.cookie(REFRESH_COOKIE, refreshToken, refreshCookieOptions(refreshMaxAgeSeconds));
    res.json(result);
  }),
);

authRouter.post(
  '/refresh',
  asyncHandler(async (req, res) => {
    const presented = (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE];
    if (!presented) throw errors.unauthenticated('Your session has expired. Sign in again.');

    try {
      const { result, refreshToken, refreshMaxAgeSeconds } = await auth.refresh(presented, {
        ip: clientIp(req),
        userAgent: req.get('user-agent')?.slice(0, 300) ?? null,
        requestId: req.requestId,
      });

      res.cookie(REFRESH_COOKIE, refreshToken, refreshCookieOptions(refreshMaxAgeSeconds));
      res.json(result);
    } catch (error) {
      // Clear the cookie on any refresh failure. Leaving a token the server has
      // rejected means the client retries it forever and, in the reuse case,
      // keeps presenting a token that triggers a critical alert each time.
      res.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
      throw error;
    }
  }),
);

authRouter.post(
  '/logout',
  asyncHandler(async (req, res) => {
    const presented = (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE];
    if (presented) await auth.logout(presented);
    res.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
    res.status(204).end();
  }),
);

authRouter.post(
  '/logout-all',
  authenticate,
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const revoked = await auth.logoutAll(actor.id, actor.username, {
      ip: clientIp(req),
      userAgent: req.get('user-agent')?.slice(0, 300) ?? null,
      requestId: req.requestId,
    });
    res.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
    res.json({ sessionsEnded: revoked });
  }),
);

/**
 * The one route reachable while `must_change_password` holds — see
 * `requirePasswordChanged`. Everything else returns PASSWORD_CHANGE_REQUIRED
 * until this succeeds.
 */
authRouter.post(
  '/change-password',
  authenticate,
  validateBody(changePasswordSchema),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const input = body(req, changePasswordSchema);

    await auth.changePassword(actor.id, input.currentPassword, input.newPassword, {
      ip: clientIp(req),
      userAgent: req.get('user-agent')?.slice(0, 300) ?? null,
      requestId: req.requestId,
    });

    // Every session ended, including this one: the client must sign in again.
    res.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
    res.json({ ok: true, reauthenticationRequired: true });
  }),
);

/* ------------------------------------------------------ set-password links */

const setupTokenParams = z.object({
  token: z
    .string()
    .trim()
    .min(20)
    .max(200)
    .regex(/^[A-Za-z0-9_-]+$/),
});

/**
 * What the set-password page shows before anyone has authenticated.
 *
 * Unauthenticated by necessity — the whole point is that the person has no way
 * in yet. Rate limited, because the alternative is a free oracle for guessing
 * tokens, and the response is deliberately thin: a name to greet them by and
 * the expiry. An unknown, spent or expired link produces one indistinguishable
 * refusal.
 */
authRouter.get(
  '/set-password/:token',
  setPasswordLimiter,
  validateParams(setupTokenParams),
  asyncHandler(async (req, res) => {
    const { token } = params(req, setupTokenParams);
    res.json(await describeSetupLink(token));
  }),
);

/**
 * Redeem the link: choose a password and come out signed in.
 *
 * Signing them in here is deliberate. They have just proved possession of a
 * single-use secret and chosen a password seconds ago; sending them back to
 * the sign-in form to type it again is the step where people give up.
 */
authRouter.post(
  '/set-password',
  setPasswordLimiter,
  validateBody(redeemSetupLinkSchema),
  asyncHandler(async (req, res) => {
    const input = body(req, redeemSetupLinkSchema);

    const { result, refreshToken, refreshMaxAgeSeconds } = await redeemSetupLink(
      input.token,
      input.password,
      {
        ip: clientIp(req),
        userAgent: req.get('user-agent')?.slice(0, 300) ?? null,
        requestId: req.requestId,
      },
    );

    res.cookie(REFRESH_COOKIE, refreshToken, refreshCookieOptions(refreshMaxAgeSeconds));
    res.json(result);
  }),
);

authRouter.get(
  '/me',
  authenticate,
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const user = await usersModel.find(pool, actor.id);
    if (!user) throw errors.unauthenticated();

    const credentials = await usersModel.findCredentialsById(pool, actor.id);
    res.json({
      user,
      mustChangePassword: credentials?.mustChangePassword ?? false,
      // The client needs this to register for push without a second round trip.
      pushPublicKey: config.push.enabled ? config.push.publicKey : null,
    });
  }),
);

authRouter.post(
  '/push-subscription',
  authenticate,
  validateBody(pushSubscriptionSchema),
  asyncHandler(async (req, res) => {
    const actor = actorOf(req);
    const subscription = body(req, pushSubscriptionSchema);
    await savePushSubscription(
      pool,
      actor.id,
      subscription,
      req.get('user-agent')?.slice(0, 300) ?? null,
    );
    res.status(204).end();
  }),
);
