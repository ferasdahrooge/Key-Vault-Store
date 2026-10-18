/**
 * /api/projects/:p/envs/:e/members — mounted by projectsRouter (mergeParams).
 * Owners manage members. Break-glass: an admin may PUT *themselves* into an environment they
 * are not a member of; that is allowed but audited as member.admin_self_grant.
 */
import type { EnvRole, Prisma } from '@prisma/client';
import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { requireAuth, requireRecentMfa } from '../auth/auth.middleware.js';
import { notFound, parse } from '../../core/http.js';
import { requireEnvRole } from '../projects/rbac.middleware.js';
import { auditFromReq } from '../audit/audit.service.js';
import { activeMemberWhere, conflict, param, resolveEnv } from '../projects/environments.service.js';
import type { AppDeps } from '../../core/types.js';

// Roles an owner can assign.
const ROLES = ['viewer', 'editor', 'owner'] as const satisfies readonly EnvRole[];

export function membersRouter(deps: AppDeps): Router {
  const { db } = deps;
  const r = Router({ mergeParams: true });
  const auth = requireAuth(db);
  const owner = requireEnvRole(db, 'owner');

  /** Owner, or an admin targeting themselves (break-glass self-grant). */
  const ownerOrAdminSelf: RequestHandler = async (req, res, next) => {
    if (req.user!.isAdmin && param(req, 'userId') === req.user!.id) {
      const resolved = await resolveEnv(db, param(req, 'p'), param(req, 'e'), req.user!.id);
      if (!resolved) throw notFound();
      if (resolved.membership?.role !== 'owner') {
        req.envCtx = {
          projectId: resolved.env.projectId,
          projectSlug: resolved.env.project.slug,
          envId: resolved.env.id,
          envSlug: resolved.env.slug,
          protected: resolved.env.protected,
          role: resolved.membership?.role ?? 'viewer',
        };
        (req as { adminSelfGrant?: boolean }).adminSelfGrant = true;
        return next();
      }
    }
    return owner(req, res, next);
  };

  // GET — list active members of the env (any member).
  r.get('/', auth, requireEnvRole(db, 'viewer'), async (req, res) => {
    const members = await db.environmentMember.findMany({
      where: { envId: req.envCtx!.envId, ...activeMemberWhere() },
      include: { user: { select: { id: true, email: true, name: true } } },
      orderBy: [{ role: 'desc' }, { createdAt: 'asc' }],
    });
    res.json({ members: members.map((m) => ({ user: m.user, role: m.role, expiresAt: m.expiresAt })) });
  });

  // PUT /:userId — add a member or change their role (owner, recent MFA).
  r.put('/:userId', auth, ownerOrAdminSelf, requireRecentMfa, async (req, res) => {
    const { role } = parse(z.object({ role: z.enum(ROLES) }), req.body);
    const targetId = parse(z.uuid(), param(req, 'userId'));
    const envId = req.envCtx!.envId;
    const selfGrant = (req as { adminSelfGrant?: boolean }).adminSelfGrant === true;

    const member = await db.$transaction(async (tx) => {
      const target = await tx.user.findUnique({ where: { id: targetId }, select: { id: true, email: true, name: true, status: true } });
      if (!target || target.status === 'disabled') throw notFound();
      // Serialise membership changes per environment so the last-owner check cannot race.
      await tx.$queryRaw`SELECT id FROM "Environment" WHERE id = ${envId}::uuid FOR UPDATE`;
      const existing = await tx.environmentMember.findUnique({ where: { envId_userId: { envId, userId: targetId } } });
      if (existing?.role === 'owner' && role !== 'owner') await assertOtherOwner(tx, envId, targetId);
      const m = await tx.environmentMember.upsert({
        where: { envId_userId: { envId, userId: targetId } },
        create: { envId, userId: targetId, role },
        update: { role, expiresAt: null },
      });
      await auditFromReq(tx, req, {
        action: selfGrant ? 'member.admin_self_grant' : 'member.set',
        meta: { userId: targetId, email: target.email, role, previousRole: existing?.role ?? null },
      });
      if (selfGrant) {
        // No email channel: one notice row per in-force owner (an owner's GET /api/audit?envId shows it).
        const owners = await tx.environmentMember.findMany({
          where: { envId, role: 'owner', userId: { not: targetId }, user: { status: 'active' }, ...activeMemberWhere() },
          select: { userId: true },
        });
        for (const o of owners) {
          await auditFromReq(tx, req, { action: 'member.admin_self_grant.notice', meta: { ownerId: o.userId, adminId: targetId, role } });
        }
      }
      return { user: { id: target.id, email: target.email, name: target.name }, role: m.role, expiresAt: m.expiresAt };
    });
    res.json({ member });
  });

  // DELETE /:userId — remove a member (never the last owner).
  r.delete('/:userId', auth, owner, requireRecentMfa, async (req, res) => {
    const targetId = param(req, 'userId');
    if (!z.uuid().safeParse(targetId).success) throw notFound();
    const envId = req.envCtx!.envId;
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Environment" WHERE id = ${envId}::uuid FOR UPDATE`;
      const existing = await tx.environmentMember.findUnique({ where: { envId_userId: { envId, userId: targetId } } });
      if (!existing) throw notFound();
      if (existing.role === 'owner') await assertOtherOwner(tx, envId, targetId);
      await tx.environmentMember.delete({ where: { envId_userId: { envId, userId: targetId } } });
      await auditFromReq(tx, req, { action: 'member.removed', meta: { userId: targetId, role: existing.role } });
    });
    res.json({ ok: true });
  });

  return r;
}

/** At least one *permanent* owner (active user, no expiry) other than `userId` must remain. */
async function assertOtherOwner(tx: Prisma.TransactionClient, envId: string, userId: string) {
  const others = await tx.environmentMember.count({
    where: { envId, role: 'owner', expiresAt: null, user: { status: 'active' }, NOT: { userId } },
  });
  if (others === 0) throw conflict('last_owner', 'An environment must keep at least one owner');
}
