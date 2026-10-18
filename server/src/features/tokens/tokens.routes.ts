/** /api/projects/:p/envs/:e/tokens — owner only. Mounted by projectsRouter (mergeParams). */
import type { ServiceToken } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireRecentMfa } from '../auth/auth.middleware.js';
import { randomToken, sha256hex } from '../../crypto/index.js';
import { notFound, parse } from '../../core/http.js';
import { requireEnvRole } from '../projects/rbac.middleware.js';
import { TOKEN_PREFIX } from './serviceToken.middleware.js';
import { auditFromReq } from '../audit/audit.service.js';
import { param } from '../projects/environments.service.js';
import { HEX_KEY_RE } from '../exchange/exchange.service.js';
import type { AppDeps } from '../../core/types.js';

// Body for creating a service token.
const createSchema = z.object({
  name: z.string().trim().min(1).max(100),
  scopes: z.array(z.enum(['read', 'export'])).min(1).max(2),
  ejsonPublicKey: z.string().regex(HEX_KEY_RE, 'must be 64 lowercase hex chars').optional(),
  expiresInDays: z.number().int().min(1).max(365).optional(),
});

// Token fields safe to return (never the hash).
function toMeta(t: ServiceToken) {
  return {
    id: t.id,
    name: t.name,
    prefix: t.prefix,
    scopes: t.scopes,
    ejsonPublicKey: t.ejsonPublicKey,
    expiresAt: t.expiresAt,
    lastUsedAt: t.lastUsedAt,
    revokedAt: t.revokedAt,
    createdAt: t.createdAt,
  };
}

export function tokensRouter(deps: AppDeps): Router {
  const { db } = deps;
  const r = Router({ mergeParams: true });
  const owner = [requireAuth(db), requireEnvRole(db, 'owner')];

  // GET — list the env's service tokens.
  r.get('/', ...owner, async (req, res) => {
    const tokens = await db.serviceToken.findMany({ where: { envId: req.envCtx!.envId }, orderBy: { createdAt: 'desc' } });
    res.json({ tokens: tokens.map(toMeta) });
  });

  // POST — create a token; the plaintext is returned only once (recent MFA).
  r.post('/', ...owner, requireRecentMfa, async (req, res) => {
    const body = parse(createSchema, req.body);
    const token = randomToken(TOKEN_PREFIX);
    const scopes = [...new Set(body.scopes)];
    const meta = await db.$transaction(async (tx) => {
      const t = await tx.serviceToken.create({
        data: {
          envId: req.envCtx!.envId,
          name: body.name,
          tokenHash: sha256hex(token),
          prefix: token.slice(0, 10),
          scopes,
          ejsonPublicKey: body.ejsonPublicKey ?? null,
          expiresAt: body.expiresInDays ? new Date(Date.now() + body.expiresInDays * 86_400_000) : null,
          createdBy: req.user!.id,
        },
      });
      await auditFromReq(tx, req, { action: 'token.created', meta: { tokenId: t.id, name: t.name, scopes, prefix: t.prefix } });
      return toMeta(t);
    });
    res.status(201).json({ token, meta });
  });

  // DELETE /:id — revoke a token.
  r.delete('/:id', ...owner, async (req, res) => {
    const id = param(req, 'id');
    if (!z.uuid().safeParse(id).success) throw notFound();
    await db.$transaction(async (tx) => {
      const t = await tx.serviceToken.findFirst({ where: { id, envId: req.envCtx!.envId } });
      if (!t) throw notFound();
      if (!t.revokedAt) await tx.serviceToken.update({ where: { id }, data: { revokedAt: new Date() } });
      await auditFromReq(tx, req, { action: 'token.revoked', meta: { tokenId: id, name: t.name, prefix: t.prefix } });
    });
    res.json({ ok: true });
  });

  return r;
}
