/**
 * Environment-level RBAC for routes with :p (project slug) and :e (environment slug).
 * Must run after requireAuth. Non-members get 404 not_found — including admins, who have no
 * implicit access to secrets — so environment existence is not disclosed. Members whose role is
 * too low get 403. Expired time-boxed memberships count as no membership.
 */
import type { EnvRole } from '@prisma/client';
import type { RequestHandler } from 'express';
import type { Db } from '../../core/db.js';
import { HttpError, forbidden, notFound } from '../../core/http.js';
import { roleAtLeast, resolveEnv } from './environments.service.js';

// Middleware factory: allow only members with at least `min` role on the env.
export function requireEnvRole(db: Db, min: EnvRole): RequestHandler {
  return async (req, _res, next) => {
    const user = req.user;
    if (!user) throw new HttpError(401, 'unauthenticated', 'Login required');
    const params = req.params as Record<string, string | undefined>;
    const p = params.p;
    const e = params.e;
    if (!p || !e) throw notFound();
    // Find the env and the user's active membership in it.
    const r = await resolveEnv(db, p, e, user.id);
    if (!r || !r.membership) throw notFound();
    if (!roleAtLeast(r.membership.role, min)) throw forbidden(`Requires ${min} role`);
    // Expose the resolved env to downstream handlers.
    req.envCtx = {
      projectId: r.env.projectId,
      projectSlug: r.env.project.slug,
      envId: r.env.id,
      envSlug: r.env.slug,
      protected: r.env.protected,
      role: r.membership.role,
    };
    next();
  };
}
