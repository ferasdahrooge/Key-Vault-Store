/** /api/admin — user administration (admin only). Grants no access to secrets. */
import { Router } from 'express';
import { z } from 'zod';
import { requireAdmin, requireAuth, requireRecentMfa } from '../auth/auth.middleware.js';
import { HttpError, notFound, parse } from '../../core/http.js';
import { auditFromReq } from '../audit/audit.service.js';
import type { AppDeps } from '../../core/types.js';
import { killUserSessions } from '../auth/auth.routes.js';

// User fields admins may see (never password hashes or MFA data).
const userSelect = {
  id: true,
  email: true,
  name: true,
  isAdmin: true,
  status: true,
  lockedUntil: true,
  createdAt: true,
} as const;

// Admin can change status, admin flag, or unlock — at least one per request.
const patchBody = z
  .object({
    status: z.enum(['active', 'disabled']).optional(),
    isAdmin: z.boolean().optional(),
    unlock: z.literal(true).optional(),
  })
  .strict()
  .refine((b) => b.status !== undefined || b.isAdmin !== undefined || b.unlock, { message: 'Nothing to change' });

/** Advisory lock key for admin-set changes (distinct from the audit chain's key). */
const ADMIN_LOCK_KEY = 0x6b76_6164; // "kvad"

export function adminRouter(deps: AppDeps): Router {
  const { db } = deps;
  const r = Router();
  r.use(requireAuth(db), requireAdmin);

  // GET /users — list all users.
  r.get('/users', async (_req, res) => {
    const users = await db.user.findMany({ select: userSelect, orderBy: [{ createdAt: 'asc' }] });
    res.json({ users });
  });

  // PATCH /users/:id — enable/disable, promote/demote or unlock a user.
  r.patch('/users/:id', requireRecentMfa, async (req, res) => {
    const id = parse(z.string().uuid(), req.params.id);
    const body = parse(patchBody, req.body);
    const target = await db.user.findUnique({ where: { id }, select: userSelect });
    if (!target) throw notFound();

    if (id === req.user!.id && (body.isAdmin === false || body.status === 'disabled')) {
      throw new HttpError(409, 'cannot_modify_self', 'You cannot demote or disable yourself');
    }
    if (body.status === 'active' && target.status === 'invited') {
      throw new HttpError(409, 'user_invited', 'An invited user becomes active by accepting their invite');
    }

    // Only write fields that actually change.
    const data: { status?: 'active' | 'disabled'; isAdmin?: boolean; failedLogins?: number; lockedUntil?: null } = {};
    if (body.status !== undefined && body.status !== target.status) data.status = body.status;
    if (body.isAdmin !== undefined && body.isAdmin !== target.isAdmin) data.isAdmin = body.isAdmin;
    if (body.unlock) {
      data.failedLogins = 0;
      data.lockedUntil = null;
    }

    const user = await db.$transaction(async (tx) => {
      const removesAdmin = target.isAdmin && (data.isAdmin === false || data.status === 'disabled');
      if (removesAdmin) {
        // Serialise admin removals: two admins demoting each other at once must not both succeed.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ADMIN_LOCK_KEY})`;
        const others = await tx.user.count({ where: { isAdmin: true, status: 'active', NOT: { id } } });
        if (others === 0) throw new HttpError(409, 'last_admin', 'At least one active admin must remain');
      }
      return tx.user.update({ where: { id }, data, select: userSelect });
    });
    // Disabling a user logs them out everywhere.
    if (data.status === 'disabled') await killUserSessions(db, id);

    // Audit exactly what changed (from → to).
    const changes: Record<string, unknown> = {};
    if (data.status) changes.status = { from: target.status, to: data.status };
    if (data.isAdmin !== undefined) changes.isAdmin = { from: target.isAdmin, to: data.isAdmin };
    if (body.unlock) changes.unlocked = true;
    await auditFromReq(db, req, { action: 'user.updated', meta: { userId: id, changes } });
    res.json({ user });
  });

  return r;
}
