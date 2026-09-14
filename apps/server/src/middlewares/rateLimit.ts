import rateLimit, { type Options } from 'express-rate-limit';
import type { Request } from 'express';
import { config } from '../config/index.js';
import { clientIp } from './context.js';

/**
 * Rate limiting.
 *
 * §B12.4 names the gap in a purely IP-based limiter: it "does not stop a slow
 * distributed attempt against one username". So the login limiter keys on
 * *username plus IP*, and account lockout (`users.locked_until`) handles the
 * per-account dimension independently. Two controls, two failure modes covered.
 *
 * Note the interaction with `trust proxy` (§B18.3): behind IIS or Caddy every
 * request appears to originate from 127.0.0.1 unless the proxy depth is set, at
 * which point one user's mistyped password would rate-limit the whole club.
 */

function base(overrides: Partial<Options>): ReturnType<typeof rateLimit> {
  return rateLimit({
    windowMs: 60_000,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    // Handing the limiter to the error pipeline keeps §B5.2's envelope intact —
    // express-rate-limit's own body would be the one response shaped differently
    // from every other.
    handler: (req, res) => {
      const retryAfter = Math.ceil((overrides.windowMs ?? 60_000) / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      res.status(429).json({
        error: {
          code: 'RATE_LIMITED' as const,
          message: 'Too many requests. Wait a moment and try again.',
          details: { retryAfterSeconds: retryAfter },
          requestId: req.requestId,
        },
      });
    },
    keyGenerator: (req: Request) => clientIp(req) ?? 'unknown',
    ...overrides,
  });
}

export const generalLimiter = base({ limit: config.rateLimit.general });

/**
 * Login. Keyed on username+IP so a shared office NAT does not let one
 * attacker's attempts against `admin` exhaust everyone else's budget, and so a
 * distributed attempt against one account is still counted together.
 */
export const loginLimiter = base({
  limit: config.rateLimit.login,
  keyGenerator: (req: Request) => {
    const username =
      typeof req.body === 'object' && req.body !== null && 'username' in req.body
        ? String((req.body as { username: unknown }).username)
            .slice(0, 64)
            .toLowerCase()
        : 'anonymous';
    return `${clientIp(req) ?? 'unknown'}:${username}`;
  },
  skipSuccessfulRequests: true,
});

/** Uploads are expensive: they buffer bytes and wake a converter. */
export const uploadLimiter = base({
  limit: config.rateLimit.upload,
  keyGenerator: (req: Request) => `${req.actor?.id ?? clientIp(req) ?? 'unknown'}`,
});

/**
 * Collector traffic is machine-generated and predictable — heartbeats every
 * 30 s plus event batches — so the ceiling is high enough never to bind in
 * normal operation while still capping a misbehaving agent.
 */
export const collectorLimiter = base({
  limit: 600,
  keyGenerator: (req: Request) => `collector:${req.collectorId ?? clientIp(req) ?? 'unknown'}`,
});

/**
 * The set-password endpoints.
 *
 * Unauthenticated by necessity: someone redeeming a link has no session yet.
 * That makes them the one public surface where a token could be guessed at, so
 * the ceiling is low — a person opens one link, once, and never needs a second
 * attempt in the same minute.
 */
export const setPasswordLimiter = base({
  limit: 12,
  keyGenerator: (req: Request) => `setpw:${clientIp(req) ?? 'unknown'}`,
});
