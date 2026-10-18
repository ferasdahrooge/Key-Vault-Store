/**
 * Per-IP rate limits for credential-guessing endpoints (login, MFA, re-auth, invite accept).
 * In-memory store: fine for a single instance; use a shared store if the server is scaled out.
 */
import { rateLimit } from 'express-rate-limit';
import type { RequestHandler } from 'express';
import type { AppConfig } from '../../config/index.js';

// Attempts allowed per IP per minute on auth endpoints.
export const AUTH_RATE_LIMIT_PER_MIN = 10;

// Builds a limiter that answers 429 with our standard JSON error shape.
export function makeAuthLimiter(limit: number, windowMs = 60_000): RequestHandler {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).json({ error: { code: 'rate_limited', message: 'Too many attempts, try again later' } });
    },
  });
}

/** The integration suite drives many logins from one IP, so the limit is relaxed ONLY under NODE_ENV=test. */
export function authLimiterFor(config: AppConfig): RequestHandler {
  return makeAuthLimiter(config.NODE_ENV === 'test' ? 10_000 : AUTH_RATE_LIMIT_PER_MIN);
}
