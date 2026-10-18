/**
 * Session state transitions for the login flow, plus small helpers shared by the auth routers.
 *
 *   anonymous --password ok--> pending (pendingUserId, pendingAt; expires after PENDING_TTL_MS)
 *   pending   --MFA ok-------> full (userId, loginAt, mfaAt)
 *   anonymous --password ok, no factors / invite accepted--> enrollment (userId, loginAt, mfaEnrollmentRequired)
 *
 * Every transition regenerates the session id (prevents fixation); the client must refetch CSRF.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ABSOLUTE_TIMEOUT_MS } from './auth.middleware.js';
import type { Db } from '../../core/db.js';
import { HttpError } from '../../core/http.js';
import { recordAudit } from '../audit/audit.service.js';
import type { AuthUser } from '../../core/types.js';

// Session field used by the pending (password-ok, MFA-pending) state.
declare module 'express-session' {
  interface SessionData {
    /** Epoch ms when the password step succeeded; pending state expires PENDING_TTL_MS later. */
    pendingAt?: number;
  }
}

// The user has 5 minutes after the password step to finish MFA.
export const PENDING_TTL_MS = 5 * 60 * 1000;

// Issues a new session id (keeps the store entry clean, prevents fixation).
export function regenerate(req: Request): Promise<void> {
  return new Promise((resolve, reject) => req.session.regenerate((err) => (err ? reject(err) : resolve())));
}

// Deletes the session from the store; safe to call when none exists.
export function destroySession(req: Request): Promise<void> {
  return new Promise((resolve) => {
    if (!req.session) return resolve();
    req.session.destroy(() => resolve());
  });
}

// Password ok: wait for the second factor.
export async function startPending(req: Request, userId: string): Promise<void> {
  await regenerate(req);
  req.session.pendingUserId = userId;
  req.session.pendingAt = Date.now();
}

// Logged in, but restricted to MFA enrollment until a factor is added.
export async function startEnrollment(req: Request, userId: string): Promise<void> {
  await regenerate(req);
  req.session.userId = userId;
  req.session.loginAt = Date.now();
  req.session.mfaEnrollmentRequired = true;
}

// Password and MFA both done: fully logged in.
export async function startFullSession(req: Request, userId: string): Promise<void> {
  await regenerate(req);
  const now = Date.now();
  req.session.userId = userId;
  req.session.loginAt = now;
  req.session.mfaAt = now;
}

// What a WebAuthn challenge was issued for; it can't be used for anything else.
export type ChallengePurpose = 'login' | 'reauth' | 'register';

/** Matches the client-side timeout hint in webauthn.ts; the server enforces it too. */
export const CHALLENGE_TTL_MS = 2 * 60 * 1000;

// Remembers a freshly generated WebAuthn challenge on the session.
export function issueChallenge(req: Request, purpose: ChallengePurpose, challenge: string): void {
  req.session.webauthnChallenge = { challenge, purpose, at: Date.now() };
}

/**
 * Consumes the session's WebAuthn challenge. Returns null if it is missing, stale or for another
 * purpose. The burn is a compare-and-delete in the session store, so two parallel verifies on one
 * session can't both use it (synced passkeys report counter 0, so the counter check won't catch it).
 */
export async function takeChallenge(db: Db, req: Request, purpose: ChallengePurpose): Promise<string | null> {
  const c = req.session.webauthnChallenge;
  delete req.session.webauthnChallenge;
  if (!c || typeof c !== 'object' || c.purpose !== purpose || Date.now() - c.at > CHALLENGE_TTL_MS) return null;
  const burned = await db.$executeRaw`
    UPDATE "session" SET sess = sess - 'webauthnChallenge'
    WHERE sid = ${req.sessionID} AND sess->'webauthnChallenge'->>'challenge' = ${c.challenge}`;
  return burned === 1 ? c.challenge : null;
}

/** Returns the pending user id, or throws 401 (and clears stale pending state). */
export async function requirePending(req: Request): Promise<string> {
  const s = req.session;
  if (!s?.pendingUserId || !s.pendingAt) throw new HttpError(401, 'unauthenticated', 'Login required');
  if (Date.now() - s.pendingAt > PENDING_TTL_MS) {
    await destroySession(req);
    throw new HttpError(401, 'session_expired', 'Login took too long, start again');
  }
  return s.pendingUserId;
}

/** Re-auth: new session id, same login, fresh mfaAt. */
export async function refreshMfa(req: Request): Promise<number> {
  const { userId, loginAt } = req.session;
  await regenerate(req);
  const now = Date.now();
  req.session.userId = userId;
  req.session.loginAt = loginAt;
  req.session.mfaAt = now;
  return now;
}

/**
 * Like requireAuth, but also admits sessions in MFA-enrollment mode. Used for GET /api/auth/me so
 * the SPA can render the enrollment screen. Keep the checks in sync with auth.middleware.ts.
 */
export function requireAuthOrEnrollment(db: Db): RequestHandler {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const s = req.session;
    if (!s?.userId) throw new HttpError(401, 'unauthenticated', 'Login required');
    if (!s.loginAt || Date.now() - s.loginAt > ABSOLUTE_TIMEOUT_MS) {
      await destroySession(req);
      throw new HttpError(401, 'session_expired', 'Session expired');
    }
    const user = await db.user.findUnique({
      where: { id: s.userId },
      select: { id: true, email: true, name: true, isAdmin: true, status: true },
    });
    if (!user || user.status !== 'active') {
      await destroySession(req);
      throw new HttpError(401, 'unauthenticated', 'Login required');
    }
    req.user = { id: user.id, email: user.email, name: user.name, isAdmin: user.isAdmin };
    req.actor = { type: 'user', id: user.id };
    next();
  };
}

/** Audit for auth events where req.actor may not be set yet (login, MFA, logout). */
export function auditAuth(
  db: Db,
  req: Request,
  action: string,
  opts: { userId?: string | null; meta?: Record<string, unknown> } = {},
): Promise<void> {
  const actorId = opts.userId ?? req.actor?.id ?? null;
  return recordAudit(db, {
    action,
    actorType: actorId ? 'user' : 'system',
    actorId,
    ip: req.ip ?? null,
    userAgent: req.get('user-agent')?.slice(0, 256) ?? null,
    meta: opts.meta ?? {},
  });
}

// The user fields safe to send to the browser.
export const publicUser = (u: { id: string; email: string; name: string; isAdmin: boolean }): AuthUser => ({
  id: u.id,
  email: u.email,
  name: u.name,
  isAdmin: u.isAdmin,
});

/** Which second factors the user can complete login with. */
export async function availableMethods(db: Db, userId: string): Promise<('totp' | 'passkey' | 'recovery')[]> {
  const [totp, passkeys, recovery] = await Promise.all([
    db.totpSecret.findFirst({ where: { userId, confirmed: true }, select: { userId: true } }),
    db.passkey.count({ where: { userId } }),
    db.recoveryCode.count({ where: { userId, usedAt: null } }),
  ]);
  const m: ('totp' | 'passkey' | 'recovery')[] = [];
  if (totp) m.push('totp');
  if (passkeys > 0) m.push('passkey');
  if (recovery > 0 && m.length > 0) m.push('recovery');
  return m;
}
