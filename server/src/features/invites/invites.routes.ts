/**
 * /api/invites — admin-issued, single-use, 24 h invite links. Accepting sets the password and logs
 * the user in in MFA-enrollment mode.
 */
import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { findUsableInvite, issueInvite } from './invites.service.js';
import { requireAdmin, requireAuth, requireRecentMfa } from '../auth/auth.middleware.js';
import { assertPasswordPolicy, hashPassword, PASSWORD_MAX } from '../auth/password.js';
import { authLimiterFor } from '../auth/rateLimit.js';
import { auditAuth, startEnrollment } from '../auth/session.js';
import { notFound, parse } from '../../core/http.js';
import { auditFromReq } from '../audit/audit.service.js';
import type { AppDeps } from '../../core/types.js';

// Request schemas for creating and accepting invites.
const createBody = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  name: z.string().trim().min(1).max(100),
  isAdmin: z.boolean().optional(),
});
const tokenParam = z.string().min(1).max(200);
const acceptBody = z.object({ password: z.string().max(PASSWORD_MAX * 4) });

export function invitesRouter(deps: AppDeps): Router {
  const { db, config } = deps;
  const r = Router();
  const limiter = authLimiterFor(config);

  /** Inviting an admin grants privilege, so it needs a recent MFA like other privilege changes. */
  const recentMfaForAdmin: RequestHandler = (req, res, next) =>
    req.body?.isAdmin === true ? requireRecentMfa(req, res, next) : next();

  // POST — admin creates an invite link for a new user.
  r.post('/', requireAuth(db), requireAdmin, recentMfaForAdmin, async (req, res) => {
    const body = parse(createBody, req.body);
    const inv = await issueInvite(db, config.APP_ORIGIN, { ...body, createdBy: req.user!.id });
    await auditFromReq(db, req, {
      action: 'invite.created',
      meta: { userId: inv.userId, email: body.email, isAdmin: body.isAdmin ?? false },
    });
    res.status(201).json({ inviteUrl: inv.inviteUrl, expiresAt: inv.expiresAt.toISOString() });
  });

  // GET /:token — show who an invite is for (used by the accept page).
  r.get('/:token', limiter, async (req, res) => {
    const invite = await findUsableInvite(db, parse(tokenParam, req.params.token));
    if (!invite) throw notFound();
    res.json({ email: invite.user.email, name: invite.user.name });
  });

  // POST /:token/accept — set a password and start MFA enrollment.
  r.post('/:token/accept', limiter, async (req, res) => {
    const token = parse(tokenParam, req.params.token);
    const { password } = parse(acceptBody, req.body);
    const invite = await findUsableInvite(db, token);
    if (!invite) throw notFound();
    assertPasswordPolicy(password, invite.user.email);
    const passwordHash = await hashPassword(password);

    // Single use: claim the invite and activate the user atomically.
    const claimed = await db.$transaction(async (tx) => {
      const { count } = await tx.invite.updateMany({
        where: { id: invite.id, usedAt: null, expiresAt: { gt: new Date() } },
        data: { usedAt: new Date() },
      });
      if (count !== 1) return false;
      const u = await tx.user.updateMany({
        where: { id: invite.userId, status: 'invited' },
        data: { passwordHash, status: 'active', failedLogins: 0, lockedUntil: null },
      });
      if (u.count !== 1) throw notFound(); // rolls back the claim
      return true;
    });
    if (!claimed) throw notFound();

    await startEnrollment(req, invite.userId);
    await auditAuth(db, req, 'invite.accepted', { userId: invite.userId, meta: { inviteId: invite.id } });
    res.json({ mfaEnrollmentRequired: true });
  });

  return r;
}
