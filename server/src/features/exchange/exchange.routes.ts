/**
 * ejson exchange. Mounted at /api, so auth is applied PER ROUTE (router-level middleware would turn
 * every unknown /api path into a 401 instead of a 404).
 */
import { Router, type Request } from 'express';
import { z } from 'zod';
import { requireAuth, requireRecentMfa } from '../auth/auth.middleware.js';
import { parse } from '../../core/http.js';
import { requireEnvRole } from '../projects/rbac.middleware.js';
import { auditFromReq } from '../audit/audit.service.js';
import { confirmRequired } from '../projects/environments.service.js';
import { HEX_KEY_RE, buildExportDoc, parseImportDoc, type ImportEntry } from './exchange.service.js';
import { KEY_RE, addVersion, createSecret, currentValues, withEnvKey, withEnvRead } from '../secrets/secrets.service.js';
import type { AppDeps } from '../../core/types.js';

// Export needs the recipient's ejson public key; keys optionally limit what is exported.
const exportSchema = z.object({
  recipientPublicKey: z.string().regex(HEX_KEY_RE, 'must be 64 lowercase hex chars'),
  keys: z.array(z.string().regex(KEY_RE)).max(1000).optional(),
});
// Import takes an ejson document encrypted to our import key.
const importSchema = z.object({
  ejson: z.string().min(2).max(2 * 1024 * 1024),
  confirm: z.string().optional(),
});

// How an imported key compares to what is stored.
type Status = 'new' | 'changed' | 'unchanged';

export function exchangeRouter(deps: AppDeps): Router {
  const { db, config } = deps;
  const r = Router();
  const auth = requireAuth(db);
  const base = '/projects/:p/envs/:e';
  const imp = config.secrets.import_keypair;

  // GET /import-key — public key users encrypt import files to.
  r.get('/import-key', auth, (_req, res) => {
    res.json({ publicKey: imp._public });
  });

  // POST .../export — download env secrets as ejson for the given public key (owner + recent MFA).
  r.post(`${base}/export`, auth, requireEnvRole(db, 'owner'), requireRecentMfa, async (req, res) => {
    const body = parse(exportSchema, req.body ?? {});
    const c = req.envCtx!;
    const values = await withEnvRead(db, c.envId, (tx, k) => currentValues(tx, k, c.envId, body.keys));
    const entries = [...values].map(([k, v]) => [k, v.value] as [string, string]);
    const doc = buildExportDoc(body.recipientPublicKey, { project: c.projectSlug, env: c.envSlug }, entries);
    await auditFromReq(db, req, {
      action: 'export.ejson',
      meta: { count: entries.length, keys: entries.map(([k]) => k), recipientPublicKey: body.recipientPublicKey },
    });
    res.set('Content-Disposition', `attachment; filename="secrets.${c.envSlug}.ejson"`);
    res.json(doc);
  });

  // Labels each imported key as new, changed or unchanged.
  async function classify(req: Request, entries: ImportEntry[]) {
    const c = req.envCtx!;
    const current = await withEnvRead(db, c.envId, (tx, k) => currentValues(tx, k, c.envId, entries.map((e) => e.key)));
    return entries.map((e) => {
      const cur = current.get(e.key);
      const status: Status = !cur ? 'new' : cur.value === e.value ? 'unchanged' : 'changed';
      return { key: e.key, status };
    });
  }

  // POST .../import/preview — show what an import would change, without writing.
  r.post(`${base}/import/preview`, auth, requireEnvRole(db, 'editor'), async (req, res) => {
    const body = parse(importSchema, req.body ?? {});
    const { entries, rejected } = parseImportDoc(body.ejson, imp._public, imp.private);
    res.json({ changes: await classify(req, entries), rejected });
  });

  // POST .../import/commit — apply an import (protected envs need the slug typed back).
  r.post(`${base}/import/commit`, auth, requireEnvRole(db, 'editor'), async (req, res) => {
    const body = parse(importSchema, req.body ?? {});
    const c = req.envCtx!;
    if (c.protected && body.confirm !== c.envSlug) throw confirmRequired();
    const { entries, rejected } = parseImportDoc(body.ejson, imp._public, imp.private);
    const userId = req.user!.id;
    const out = await withEnvKey(db, c.envId, async (tx, k) => {
      // Compare inside the locked tx so concurrent writes can't race the classification.
      const current = await currentValues(tx, k, c.envId, entries.map((e) => e.key));
      const created: string[] = [];
      const updated: string[] = [];
      let unchanged = 0;
      for (const e of entries) {
        const cur = current.get(e.key);
        if (!cur) {
          await createSecret(tx, k, { envId: c.envId, key: e.key, value: e.value, userId, comment: 'import' });
          created.push(e.key);
        } else if (cur.value !== e.value) {
          await addVersion(tx, k, cur.secret, e.value, userId, 'import');
          updated.push(e.key);
        } else unchanged++;
      }
      await auditFromReq(tx, req, {
        action: 'import.ejson',
        meta: { created: created.length, updated: updated.length, unchanged, rejected: rejected.length, keys: [...created, ...updated] },
      });
      return { created: created.length, updated: updated.length, unchanged };
    });
    res.json({ ...out, rejected });
  });

  return r;
}
