/**
 * Bearer authentication for the machine API (/api/v1). Tokens look like `kv_st_<base64url>`;
 * only their sha256 is stored. Revoked, expired or unknown tokens all get the same 401.
 * A token also stops working (401 token_inactive) once its creator is no longer an active user
 * or no longer holds an in-force owner membership of the token's environment.
 */
import type { RequestHandler } from 'express';
import { sha256hex } from '../../crypto/index.js';
import type { Db } from '../../core/db.js';
import { HttpError, forbidden } from '../../core/http.js';
import { activeMemberWhere } from '../projects/environments.service.js';

// Token format: fixed prefix plus a base64url random part.
export const TOKEN_PREFIX = 'kv_st_';
const TOKEN_RE = /^kv_st_[A-Za-z0-9_-]{20,128}$/;

// Token details attached to the request for /api/v1 handlers.
declare global {
  namespace Express {
    interface Request {
      serviceToken?: { id: string; envId: string; projectId: string; projectSlug: string; envSlug: string; scopes: string[]; ejsonPublicKey: string | null };
    }
  }
}

// Same error for every bad token so callers can't probe which part failed.
const invalid = () => new HttpError(401, 'invalid_token', 'Invalid or expired token');

// Authenticates a request by its `Authorization: Bearer kv_st_...` header.
export function requireServiceToken(db: Db): RequestHandler {
  return async (req, res, next) => {
    const h = req.get('authorization') ?? '';
    const m = /^Bearer\s+(\S+)$/i.exec(h);
    if (!m || !TOKEN_RE.test(m[1]!)) {
      res.set('WWW-Authenticate', 'Bearer');
      throw invalid();
    }
    // Look up the token by hash, with its env and project slugs.
    const t = await db.serviceToken.findUnique({
      where: { tokenHash: sha256hex(m[1]!) },
      include: { env: { select: { id: true, slug: true, projectId: true, project: { select: { slug: true } } } } },
    });
    const now = new Date();
    if (!t || t.revokedAt || (t.expiresAt && t.expiresAt <= now)) {
      res.set('WWW-Authenticate', 'Bearer error="invalid_token"');
      throw invalid();
    }
    // The creator must still be an active user and an owner of the env.
    const [creator, ownership] = await Promise.all([
      db.user.findUnique({ where: { id: t.createdBy }, select: { status: true } }),
      db.environmentMember.findFirst({
        where: { envId: t.envId, userId: t.createdBy, role: 'owner', ...activeMemberWhere(now) },
        select: { userId: true },
      }),
    ]);
    if (creator?.status !== 'active' || !ownership) {
      res.set('WWW-Authenticate', 'Bearer error="invalid_token"');
      throw new HttpError(401, 'token_inactive', 'Token creator is no longer an active owner of this environment');
    }
    // Record usage and attach the token identity to the request.
    await db.serviceToken.update({ where: { id: t.id }, data: { lastUsedAt: now } });
    req.actor = { type: 'token', id: t.id, envId: t.envId, scopes: t.scopes };
    req.serviceToken = {
      id: t.id,
      envId: t.envId,
      projectId: t.env.projectId,
      projectSlug: t.env.project.slug,
      envSlug: t.env.slug,
      scopes: t.scopes,
      ejsonPublicKey: t.ejsonPublicKey,
    };
    next();
  };
}

// Rejects tokens that weren't granted the given scope.
export function requireScope(scope: 'read' | 'export'): RequestHandler {
  return (req, _res, next) => {
    if (!req.serviceToken?.scopes.includes(scope)) throw forbidden(`Token lacks the "${scope}" scope`);
    next();
  };
}
