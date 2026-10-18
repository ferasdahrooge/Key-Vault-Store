/**
 * /api/projects — projects, environments, compare, DEK rotation, plus the per-environment
 * sub-routers (secrets, members, tokens, access-request creation). Auth is applied per route
 * (sub-routers authenticate themselves) so unmatched paths fall through to exchangeRouter.
 */
import { Router } from 'express';
import { z } from 'zod';
import { requireAdmin, requireAuth, requireRecentMfa } from '../auth/auth.middleware.js';
import { notFound, parse } from '../../core/http.js';
import { requireEnvRole } from './rbac.middleware.js';
import { auditFromReq } from '../audit/audit.service.js';
import { rotateEnvironmentDek } from '../key-rotation/dekRotation.service.js';
import {
  COLOR_RE,
  DEFAULT_ENVIRONMENTS,
  SLUG_RE,
  activeMemberWhere,
  assertRecentMfa,
  confirmRequired,
  conflict,
  createEnvironment,
  envPublicSelect,
  isUniqueViolation,
  param,
  projectsForUser,
  toEnvPublic,
} from './environments.service.js';
import type { AppDeps } from '../../core/types.js';
import { accessRequestCreateRouter } from '../access-requests/accessRequests.routes.js';
import { membersRouter } from '../members/members.routes.js';
import { secretsRouter } from '../secrets/secrets.routes.js';
import { tokensRouter } from '../tokens/tokens.routes.js';

// Request schemas for projects, environments and compare.
const envSchema = z.object({
  slug: z.string().regex(SLUG_RE, 'invalid slug'),
  name: z.string().trim().min(1).max(100),
  color: z.string().regex(COLOR_RE).optional(),
  protected: z.boolean().optional(),
});
const projectSchema = z.object({
  slug: z.string().regex(SLUG_RE, 'invalid slug'),
  name: z.string().trim().min(1).max(100),
  description: z.string().max(1000).optional(),
  environments: z
    .array(envSchema)
    .min(1)
    .max(20)
    .refine((a) => new Set(a.map((e) => e.slug)).size === a.length, 'duplicate environment slug')
    .optional(),
});
const envPatchSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  color: z.string().regex(COLOR_RE).optional(),
  protected: z.boolean().optional(),
  confirm: z.string().optional(),
});
const compareQuery = z.object({ envs: z.string().max(1000).optional() });

export function projectsRouter(deps: AppDeps): Router {
  const { db } = deps;
  const r = Router();
  const auth = requireAuth(db);
  const envBase = '/:p/envs/:e';

  // Per-environment sub-routers.
  r.use(`${envBase}/secrets`, secretsRouter(deps));
  r.use(`${envBase}/members`, membersRouter(deps));
  r.use(`${envBase}/tokens`, tokensRouter(deps));
  r.use(`${envBase}/access-requests`, accessRequestCreateRouter(deps));

  // GET — projects and environments visible to the user.
  r.get('/', auth, async (req, res) => {
    res.json({ projects: await projectsForUser(db, req.user!) });
  });

  // POST — admin creates a project (with default or given environments).
  r.post('/', auth, requireAdmin, async (req, res) => {
    const body = parse(projectSchema, req.body ?? {});
    const userId = req.user!.id;
    try {
      const project = await db.$transaction(async (tx) => {
        const p = await tx.project.create({
          data: { slug: body.slug, name: body.name, description: body.description ?? '', createdBy: userId },
        });
        await auditFromReq(tx, req, { action: 'project.created', projectId: p.id, meta: { slug: p.slug } });
        const environments = [];
        for (const input of body.environments ?? DEFAULT_ENVIRONMENTS) {
          const env = await createEnvironment(tx, p.id, input, userId);
          await auditFromReq(tx, req, { action: 'env.created', projectId: p.id, envId: env.id, meta: { slug: env.slug } });
          environments.push(toEnvPublic(env, 'owner'));
        }
        return { id: p.id, slug: p.slug, name: p.name, description: p.description, environments };
      });
      res.status(201).json({ project });
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('slug_taken', 'A project with this slug already exists');
      throw e;
    }
  });

  // GET /:p — one project with its environments.
  r.get('/:p', auth, async (req, res) => {
    const [project] = await projectsForUser(db, req.user!, param(req, 'p'));
    if (!project) throw notFound();
    res.json({ project });
  });

  // POST /:p/envs — admin adds an environment to a project.
  r.post('/:p/envs', auth, requireAdmin, async (req, res) => {
    const body = parse(envSchema, req.body ?? {});
    const project = await db.project.findUnique({ where: { slug: param(req, 'p') }, select: { id: true } });
    if (!project) throw notFound();
    try {
      const environment = await db.$transaction(async (tx) => {
        const env = await createEnvironment(tx, project.id, body, req.user!.id);
        await auditFromReq(tx, req, { action: 'env.created', projectId: project.id, envId: env.id, meta: { slug: env.slug } });
        return toEnvPublic(env, 'owner');
      });
      res.status(201).json({ environment });
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('slug_taken', 'An environment with this slug already exists');
      throw e;
    }
  });

  // PATCH /:p/envs/:e — owner renames, recolours or (un)protects an env.
  r.patch(envBase, auth, requireEnvRole(db, 'owner'), async (req, res) => {
    const { confirm, ...body } = parse(envPatchSchema, req.body ?? {});
    const c = req.envCtx!;
    // Any change to a protected env needs the slug typed back (otherwise one call drops the guard).
    if (c.protected && confirm !== c.envSlug) throw confirmRequired();
    // Lowering protection is a sensitive change.
    if (c.protected && body.protected === false) assertRecentMfa(req);
    const environment = await db.$transaction(async (tx) => {
      const env = await tx.environment.update({ where: { id: c.envId }, data: body, select: envPublicSelect });
      const flag = env.protected !== c.protected ? { protected: { from: c.protected, to: env.protected } } : {};
      await auditFromReq(tx, req, { action: 'env.updated', meta: { changes: Object.keys(body), ...flag } });
      return toEnvPublic(env, c.role);
    });
    res.json({ environment });
  });

  // POST .../rotate-key — owner rotates the env's data key (re-encrypts all secrets).
  r.post(`${envBase}/rotate-key`, auth, requireEnvRole(db, 'owner'), requireRecentMfa, async (req, res) => {
    const { confirm } = parse(z.object({ confirm: z.string().optional() }), req.body ?? {});
    if (req.envCtx!.protected && confirm !== req.envCtx!.envSlug) throw confirmRequired();
    const out = await rotateEnvironmentDek(db, req.envCtx!.envId, {
      actorType: 'user',
      actorId: req.user!.id,
      ip: req.ip ?? null,
      userAgent: req.get('user-agent')?.slice(0, 256) ?? null,
      reason: 'manual',
    });
    res.json({ ok: true, ...out });
  });

  // GET /:p/compare — which keys exist in which envs (no values).
  r.get('/:p/compare', auth, async (req, res) => {
    const q = parse(compareQuery, req.query);
    const wanted = q.envs ? q.envs.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
    const project = await db.project.findUnique({ where: { slug: param(req, 'p') }, select: { id: true } });
    if (!project) throw notFound();
    // Only environments the caller is an in-force member of — admins get no implicit access.
    const envs = await db.environment.findMany({
      where: {
        projectId: project.id,
        ...(wanted ? { slug: { in: wanted } } : {}),
        members: { some: { userId: req.user!.id, ...activeMemberWhere() } },
      },
      orderBy: { createdAt: 'asc' },
      select: {
        slug: true,
        secrets: { where: { deletedAt: null }, select: { key: true, currentVersion: true, updatedAt: true } },
      },
    });
    if (envs.length === 0 && !req.user!.isAdmin) {
      const any = await db.environment.count({
        where: { projectId: project.id, members: { some: { userId: req.user!.id, ...activeMemberWhere() } } },
      });
      if (any === 0) throw notFound();
    }
    // Union of keys across envs, with per-env presence and version.
    const keys = [...new Set(envs.flatMap((e) => e.secrets.map((s) => s.key)))].sort();
    res.json({
      envs: envs.map((e) => e.slug),
      keys: keys.map((key) => ({
        key,
        presence: Object.fromEntries(
          envs.map((e) => {
            const s = e.secrets.find((x) => x.key === key);
            return [e.slug, s ? { exists: true, version: s.currentVersion, updatedAt: s.updatedAt } : null];
          }),
        ),
      })),
    });
  });

  return r;
}
