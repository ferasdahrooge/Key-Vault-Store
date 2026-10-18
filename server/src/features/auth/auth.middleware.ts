/**
 * Request guards for the browser API: logged-in session, admin, and recent MFA (step-up).
 * Timeouts live here so the session, auth and domain routers share one definition.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Db } from '../../core/db.js';
import { HttpError, forbidden } from '../../core/http.js';

// Session timeouts: 15 min idle, 8 h absolute, 5 min re-auth window for sensitive actions.
export const IDLE_TIMEOUT_MS = 15 * 60 * 1000;
export const ABSOLUTE_TIMEOUT_MS = 8 * 60 * 60 * 1000;
export const REAUTH_WINDOW_MS = 5 * 60 * 1000;

/**
 * Loads req.user from the session. Rejects sessions past the absolute lifetime and
 * disabled/locked users. (Idle timeout is enforced by the rolling session cookie maxAge.)
 */
export function requireAuth(db: Db): RequestHandler {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const s = req.session;
    // No full login on this session.
    if (!s?.userId) throw new HttpError(401, 'unauthenticated', 'Login required');
    // Session older than the absolute lifetime: destroy it.
    if (!s.loginAt || Date.now() - s.loginAt > ABSOLUTE_TIMEOUT_MS) {
      await new Promise<void>((r) => s.destroy(() => r()));
      throw new HttpError(401, 'session_expired', 'Session expired');
    }
    // Enrollment-mode sessions may only reach the auth router's /mfa/* routes.
    if (s.mfaEnrollmentRequired && !(req.baseUrl === '/api/auth' && req.path.startsWith('/mfa'))) {
      throw new HttpError(403, 'mfa_enrollment_required', 'Enroll an MFA factor first');
    }
    // Re-check the user in the database so disabling takes effect immediately.
    const user = await db.user.findUnique({
      where: { id: s.userId },
      select: { id: true, email: true, name: true, isAdmin: true, status: true },
    });
    if (!user || user.status !== 'active') {
      await new Promise<void>((r) => s.destroy(() => r()));
      throw new HttpError(401, 'unauthenticated', 'Login required');
    }
    req.user = { id: user.id, email: user.email, name: user.name, isAdmin: user.isAdmin };
    req.actor = { type: 'user', id: user.id };
    next();
  };
}

/** Must run after requireAuth; isAdmin is re-read from the database on every request. */
export const requireAdmin: RequestHandler = (req, _res, next) => {
  if (!req.user?.isAdmin) throw forbidden('Admin only');
  next();
};

/** Sensitive operations require MFA within the last REAUTH_WINDOW_MS. Client should call POST /api/auth/reauth. */
export const requireRecentMfa: RequestHandler = (req, _res, next) => {
  const at = req.session?.mfaAt ?? 0;
  if (Date.now() - at > REAUTH_WINDOW_MS) throw new HttpError(401, 'reauth_required', 'Re-authenticate to continue');
  next();
};
