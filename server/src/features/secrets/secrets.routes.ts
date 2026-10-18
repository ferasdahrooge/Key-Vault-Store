/** /api/projects/:p/envs/:e/secrets — mounted by projectsRouter (mergeParams). */
import type { Prisma } from '@prisma/client';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { requireAuth, requireRecentMfa } from '../auth/auth.middleware.js';
import { badRequest, notFound, parse } from '../../core/http.js';
import { requireEnvRole } from '../projects/rbac.middleware.js';
import { auditFromReq } from '../audit/audit.service.js';
import { confirmRequired, param } from '../projects/environments.service.js';
import {
  KEY_RE,
  MAX_VALUE_BYTES,
  SECRET_TYPES,
  addVersion,
  createSecret,
  decryptVersion,
  findLiveSecret,
  secretMeta,
  toSecretMeta,
  userRefs,
  valueTooLarge,
  withEnvKey,
  withEnvRead,
} from './secrets.service.js';
import type { AppDeps, EnvContext } from '../../core/types.js';

// Shared field validators.
const value = z
  .string()
  .min(1)
  .refine((v) => !valueTooLarge(v), `must be at most ${MAX_VALUE_BYTES} bytes`);
const tags = z.array(z.string().trim().min(1).max(40)).max(20);
const expiresAt = z.iso.datetime({ offset: true }).nullable();

// Body for creating a secret.
const createSchema = z.object({
  key: z.string().regex(KEY_RE, 'invalid key'),
  value,
  type: z.enum(SECRET_TYPES).optional(),
  description: z.string().max(1000).optional(),
  tags: tags.optional(),
  expiresAt: expiresAt.optional(),
});

// Body for updating a secret; a new value creates a new version.
const patchSchema = z.object({
  value: value.optional(),
  type: z.enum(SECRET_TYPES).optional(),
  description: z.string().max(1000).optional(),
  tags: tags.optional(),
  expiresAt: expiresAt.optional(),
  comment: z.string().max(500).optional(),
  confirm: z.string().optional(),
});

// Search/filter options for listing secrets.
const listQuery = z.object({
  q: z.string().max(128).optional(),
  tag: z.string().max(40).optional(),
  type: z.enum(SECRET_TYPES).optional(),
});

// Small helpers for the resolved env and current user.
const ctx = (req: Request): EnvContext => req.envCtx!;
const userId = (req: Request) => req.user!.id;

// Protected envs require the env slug typed back for destructive changes.
function requireConfirm(req: Request, confirm: unknown) {
  const c = ctx(req);
  if (c.protected && confirm !== c.envSlug) throw confirmRequired();
}

export function secretsRouter(deps: AppDeps): Router {
  const { db } = deps;
  const r = Router({ mergeParams: true });
  const auth = requireAuth(db);
  const viewer = [auth, requireEnvRole(db, 'viewer')];
  const editor = [auth, requireEnvRole(db, 'editor')];

  // GET — list secret metadata (never values).
  r.get('/', ...viewer, async (req, res) => {
    const q = parse(listQuery, req.query);
    const where: Prisma.SecretWhereInput = {
      envId: ctx(req).envId,
      deletedAt: null,
      ...(q.type ? { type: q.type } : {}),
      ...(q.tag ? { tags: { has: q.tag } } : {}),
      ...(q.q
        ? { OR: [{ key: { contains: q.q, mode: 'insensitive' } }, { description: { contains: q.q, mode: 'insensitive' } }] }
        : {}),
    };
    const secrets = await db.secret.findMany({ where, orderBy: { key: 'asc' } });
    const users = await userRefs(db, secrets.map((s) => s.updatedBy));
    res.json({ secrets: secrets.map((s) => toSecretMeta(s, users)) });
  });

  // POST — create a secret (editor).
  r.post('/', ...editor, async (req, res) => {
    const body = parse(createSchema, req.body);
    const c = ctx(req);
    const secret = await withEnvKey(db, c.envId, async (tx, k) => {
      const s = await createSecret(tx, k, {
        envId: c.envId,
        key: body.key,
        value: body.value,
        type: body.type,
        description: body.description,
        tags: body.tags,
        expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
        userId: userId(req),
      });
      await auditFromReq(tx, req, { action: 'secret.created', secretId: s.id, meta: { key: s.key, version: 1 } });
      return s;
    });
    res.status(201).json({ secret: await secretMeta(db, secret) });
  });

  // GET /:id — one secret's metadata.
  r.get('/:id', ...viewer, async (req, res) => {
    const s = await findLiveSecret(db, ctx(req).envId, uuidParam(req));
    res.json({ secret: await secretMeta(db, s) });
  });

  // PATCH /:id — update value and/or metadata (editor).
  r.patch('/:id', ...editor, async (req, res) => {
    const body = parse(patchSchema, req.body);
    requireConfirm(req, body.confirm);
    const c = ctx(req);
    const id = uuidParam(req);
    const extra: Prisma.SecretUpdateInput = {
      ...(body.type !== undefined ? { type: body.type } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.tags !== undefined ? { tags: body.tags } : {}),
      ...(body.expiresAt !== undefined ? { expiresAt: body.expiresAt ? new Date(body.expiresAt) : null } : {}),
    };
    const fields = Object.keys(extra);
    const secret = await withEnvKey(db, c.envId, async (tx, k) => {
      const cur = await findLiveSecret(tx, c.envId, id);
      const updated =
        body.value !== undefined
          ? await addVersion(tx, k, cur, body.value, userId(req), body.comment ?? '', extra)
          : await tx.secret.update({ where: { id }, data: { ...extra, updatedBy: userId(req) } });
      await auditFromReq(tx, req, {
        action: 'secret.updated',
        secretId: id,
        meta: { key: cur.key, version: updated.currentVersion, valueChanged: body.value !== undefined, fields },
      });
      return updated;
    });
    res.json({ secret: await secretMeta(db, secret) });
  });

  // DELETE /:id — soft-delete a secret (editor).
  r.delete('/:id', ...editor, async (req, res) => {
    requireConfirm(req, req.query.confirm);
    const c = ctx(req);
    const id = uuidParam(req);
    await db.$transaction(async (tx) => {
      const cur = await findLiveSecret(tx, c.envId, id);
      await tx.secret.update({ where: { id }, data: { deletedAt: new Date(), updatedBy: userId(req) } });
      await auditFromReq(tx, req, { action: 'secret.deleted', secretId: id, meta: { key: cur.key, version: cur.currentVersion } });
    });
    res.json({ ok: true });
  });

  // POST /:id/reveal — decrypt and return a value (protected envs need recent MFA).
  r.post('/:id/reveal', ...viewer, (req, res, next) => (ctx(req).protected ? requireRecentMfa(req, res, next) : next()), async (req, res) => {
    const body = parse(z.object({ version: z.number().int().positive().optional() }), req.body ?? {});
    const c = ctx(req);
    const id = uuidParam(req);
    const { plaintext, version } = await withEnvRead(db, c.envId, async (tx, k) => {
      const s = await findLiveSecret(tx, c.envId, id);
      const version = body.version ?? s.currentVersion;
      if (version > s.currentVersion) throw notFound();
      const plaintext = await decryptVersion(tx, k, s, version);
      // Audit before the value leaves the server; a failed audit means no reveal.
      await auditFromReq(tx, req, { action: 'secret.reveal', secretId: s.id, meta: { key: s.key, version } });
      return { plaintext, version };
    });
    res.json({ value: plaintext, version });
  });

  // GET /:id/versions — version history (no values).
  r.get('/:id/versions', ...viewer, async (req, res) => {
    const s = await findLiveSecret(db, ctx(req).envId, uuidParam(req));
    const versions = await db.secretVersion.findMany({
      where: { secretId: s.id },
      orderBy: { version: 'desc' },
      select: { version: true, createdAt: true, createdBy: true, comment: true },
    });
    const users = await userRefs(db, versions.map((v) => v.createdBy));
    res.json({
      versions: versions.map((v) => ({
        version: v.version,
        createdAt: v.createdAt,
        createdBy: v.createdBy ? (users.get(v.createdBy) ?? null) : null,
        comment: v.comment,
      })),
    });
  });

  // POST /:id/rollback/:version — restore an old value as a new version.
  r.post('/:id/rollback/:version', ...editor, async (req, res) => {
    const body = parse(z.object({ confirm: z.string().optional() }), req.body ?? {});
    requireConfirm(req, body.confirm);
    const target = parse(z.coerce.number().int().positive(), param(req, 'version'));
    const c = ctx(req);
    const id = uuidParam(req);
    const secret = await withEnvKey(db, c.envId, async (tx, k) => {
      const cur = await findLiveSecret(tx, c.envId, id);
      if (target > cur.currentVersion) throw notFound();
      if (target === cur.currentVersion) throw badRequest('Already at that version');
      const old = await decryptVersion(tx, k, cur, target);
      const updated = await addVersion(tx, k, cur, old, userId(req), `rollback to v${target}`);
      await auditFromReq(tx, req, {
        action: 'secret.rollback',
        secretId: id,
        meta: { key: cur.key, fromVersion: target, version: updated.currentVersion },
      });
      return updated;
    });
    res.json({ secret: await secretMeta(db, secret) });
  });

  return r;
}

// Reads :id and treats a non-UUID as not found.
function uuidParam(req: Request): string {
  const id = param(req, 'id');
  if (!z.uuid().safeParse(id).success) throw notFound();
  return id;
}
