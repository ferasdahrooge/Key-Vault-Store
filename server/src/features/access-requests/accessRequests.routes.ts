/**
 * Access requests.
 *   POST /api/projects/:p/envs/:e/access-requests  (served via projectsRouter → accessRequestCreateRouter)
 *   GET  /api/access-requests
 *   POST /api/access-requests/:id/decide
 *
 * Approval grants a time-boxed membership (expiresAt = now + durationMin). It never touches an
 * existing permanent membership: if its role is already >= the requested one, approval is a no-op
 * (request marked approved, grant = the permanent role); if it is LOWER, approval is refused with
 * 409 already_member (the request stays pending; deny it or change the role via PUT members),
 * because the schema stores one row per user/env and an expiry must never remove a permanent role.
 */
import type { AccessRequest, EnvRole, Prisma } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../auth/auth.middleware.js';
import { HttpError, forbidden, notFound, parse } from '../../core/http.js';
import { auditFromReq } from '../audit/audit.service.js';
import { activeMemberWhere, conflict, isActiveMembership, param, roleAtLeast } from '../projects/environments.service.js';
import type { AppDeps } from '../../core/types.js';

// Requests expire after 7 days; grants last at most 7 days.
const PENDING_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_DURATION_MIN = 7 * 24 * 60;

// Body for creating an access request.
const createSchema = z.object({
  role: z.enum(['viewer', 'editor', 'owner']).default('viewer'),
  reason: z.string().trim().min(1).max(500),
  durationMin: z.number().int().min(5).max(MAX_DURATION_MIN),
});

// Relations loaded with every request so the DTO can show project/env/user names.
const include = {
  env: { select: { slug: true, name: true, project: { select: { slug: true, name: true } } } },
  user: { select: { id: true, name: true, email: true } },
} satisfies Prisma.AccessRequestInclude;

type Row = Prisma.AccessRequestGetPayload<{ include: typeof include }>;

// Shapes a request row for the API response.
function toDto(r: Row) {
  return {
    id: r.id,
    project: { slug: r.env.project.slug, name: r.env.project.name },
    env: { slug: r.env.slug, name: r.env.name },
    user: r.user,
    role: r.role,
    reason: r.reason,
    durationMin: r.durationMin,
    status: r.status,
    createdAt: r.createdAt,
    decidedAt: r.decidedAt,
  };
}

/** Mounted by projectsRouter at /:p/envs/:e/access-requests. Any authenticated user. */
export function accessRequestCreateRouter(deps: AppDeps): Router {
  const { db } = deps;
  const r = Router({ mergeParams: true });
  // POST — ask for time-boxed access to an environment.
  r.post('/', requireAuth(db), async (req, res) => {
    const body = parse(createSchema, req.body);
    const env = await db.environment.findFirst({
      where: { slug: param(req, 'e'), project: { slug: param(req, 'p') } },
      select: { id: true, projectId: true },
    });
    if (!env) throw notFound();
    const userId = req.user!.id;
    const request = await db.$transaction(async (tx) => {
      // Only one open request per user per environment.
      const pending = await tx.accessRequest.findFirst({
        where: { envId: env.id, userId, status: 'pending', createdAt: { gt: new Date(Date.now() - PENDING_TTL_MS) } },
      });
      if (pending) throw conflict('already_pending', 'You already have a pending request for this environment');
      const created = await tx.accessRequest.create({
        data: { envId: env.id, userId, role: body.role, reason: body.reason, durationMin: body.durationMin },
        include,
      });
      await auditFromReq(tx, req, {
        action: 'access.requested',
        projectId: env.projectId,
        envId: env.id,
        meta: { requestId: created.id, role: body.role, durationMin: body.durationMin },
      });
      return created;
    });
    res.status(201).json({ request: toDto(request) });
  });
  return r;
}

export function accessRequestsRouter(deps: AppDeps): Router {
  const { db } = deps;
  const r = Router();
  r.use(requireAuth(db));

  // GET — my own requests plus pending ones I can decide as an owner.
  r.get('/', async (req, res) => {
    const userId = req.user!.id;
    await expireStale(db);
    const owned = await db.environmentMember.findMany({
      where: { userId, role: 'owner', ...activeMemberWhere() },
      select: { envId: true },
    });
    const [mine, toDecide] = await Promise.all([
      db.accessRequest.findMany({ where: { userId }, include, orderBy: { createdAt: 'desc' }, take: 100 }),
      owned.length
        ? db.accessRequest.findMany({
            where: { envId: { in: owned.map((o) => o.envId) }, status: 'pending', NOT: { userId } },
            include,
            orderBy: { createdAt: 'asc' },
            take: 200,
          })
        : Promise.resolve([] as Row[]),
    ]);
    res.json({ mine: mine.map(toDto), toDecide: toDecide.map(toDto) });
  });

  // POST /:id/decide — an owner approves or denies a pending request.
  r.post('/:id/decide', async (req, res) => {
    const { approve } = parse(z.object({ approve: z.boolean() }), req.body);
    const id = param(req, 'id');
    if (!z.uuid().safeParse(id).success) throw notFound();
    const decider = req.user!.id;

    const updated = await db.$transaction(async (tx) => {
      const ar = await tx.accessRequest.findUnique({ where: { id }, include: { env: { select: { projectId: true } } } });
      if (!ar) throw notFound();
      // Decider must be an active owner of that env (else 404, nothing disclosed).
      const mine = await tx.environmentMember.findUnique({ where: { envId_userId: { envId: ar.envId, userId: decider } } });
      if (!mine || mine.role !== 'owner' || !isActiveMembership(mine)) throw notFound();
      if (ar.userId === decider) throw forbidden('You cannot decide your own request');
      if (ar.status !== 'pending') throw conflict('already_decided', 'This request was already decided');
      if (Date.now() - ar.createdAt.getTime() > PENDING_TTL_MS) {
        await tx.accessRequest.update({ where: { id }, data: { status: 'expired' } });
        throw new HttpError(409, 'request_expired', 'This request has expired');
      }

      let grant: { role: EnvRole; expiresAt: Date | null } | null = null;
      if (approve) grant = await applyGrant(tx, ar);

      const row = await tx.accessRequest.update({
        where: { id },
        data: { status: approve ? 'approved' : 'denied', decidedBy: decider, decidedAt: new Date() },
        include,
      });
      await auditFromReq(tx, req, {
        action: 'access.decided',
        projectId: ar.env.projectId,
        envId: ar.envId,
        meta: {
          requestId: id,
          userId: ar.userId,
          approve,
          role: ar.role,
          durationMin: ar.durationMin,
          grantedRole: grant?.role ?? null,
          expiresAt: grant?.expiresAt?.toISOString() ?? null,
        },
      });
      return row;
    });
    res.json({ request: toDto(updated) });
  });

  return r;
}

// Turns an approved request into a (time-boxed) membership.
async function applyGrant(tx: Prisma.TransactionClient, ar: AccessRequest): Promise<{ role: EnvRole; expiresAt: Date | null }> {
  const key = { envId_userId: { envId: ar.envId, userId: ar.userId } };
  const existing = await tx.environmentMember.findUnique({ where: key });
  const expiresAt = new Date(Date.now() + ar.durationMin * 60_000);

  if (existing && isActiveMembership(existing)) {
    if (existing.expiresAt === null) {
      if (roleAtLeast(existing.role, ar.role)) return { role: existing.role, expiresAt: null }; // already covered: no-op
      // One row per (env,user): a time-boxed elevation would replace the permanent role and
      // remove ALL access on expiry. Refuse; an owner can change the role via PUT members instead.
      throw conflict('already_member', `User already has a permanent ${existing.role} role; change it via members instead`);
    }
    if (existing.expiresAt !== null) {
      // Extend an in-force time-boxed grant; keep the higher of the two roles.
      const role = roleAtLeast(existing.role, ar.role) ? existing.role : ar.role;
      const until = existing.expiresAt > expiresAt ? existing.expiresAt : expiresAt;
      await tx.environmentMember.update({ where: key, data: { role, expiresAt: until } });
      return { role, expiresAt: until };
    }
  }
  await tx.environmentMember.upsert({
    where: key,
    create: { envId: ar.envId, userId: ar.userId, role: ar.role, expiresAt },
    update: { role: ar.role, expiresAt },
  });
  return { role: ar.role, expiresAt };
}

// Marks old pending requests as expired.
async function expireStale(db: AppDeps['db']) {
  await db.accessRequest.updateMany({
    where: { status: 'pending', createdAt: { lt: new Date(Date.now() - PENDING_TTL_MS) } },
    data: { status: 'expired' },
  });
}

export type { AccessRequest };
