/**
 * Machine API (/api/v1), bearer `kv_st_…` service tokens only — no session, no CSRF.
 * Rate-limited per token (keyed on the sha256 of the presented bearer token, not the IP), 60/min.
 * Separately, FAILED bearer auths (401) are limited per client IP (30 / 5 min → 429 for that IP,
 * valid tokens included) so unauthenticated token guessing can't rotate through fresh bearer values
 * to dodge the per-token limiter.
 * Every call is audited as token.use.
 */
import { Router, type Request, type Response } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { sha256hex } from '../../crypto/index.js';
import { badRequest } from '../../core/http.js';
import { requireScope, requireServiceToken } from '../tokens/serviceToken.middleware.js';
import { recordAudit } from '../audit/audit.service.js';
import { HEX_KEY_RE, buildExportDoc } from '../exchange/exchange.service.js';
import { currentValues, withEnvRead } from '../secrets/secrets.service.js';
import type { AppDeps } from '../../core/types.js';

// Rate-limit settings for the machine API.
export const SERVICE_API_RATE_LIMIT_PER_MIN = 60;
export const SERVICE_API_AUTH_FAILURES_PER_IP = 30;
export const SERVICE_API_AUTH_FAILURE_WINDOW_MS = 5 * 60_000;

// Extracts the raw bearer token from the Authorization header.
function bearer(req: Request): string | null {
  const m = /^Bearer\s+(\S+)$/i.exec(req.get('authorization') ?? '');
  return m ? m[1]! : null;
}

export function serviceApiRouter(deps: AppDeps): Router {
  const { db } = deps;
  const r = Router();

  // Standard 429 response.
  const tooMany = (_req: Request, res: Response) => {
    res.status(429).json({ error: { code: 'rate_limited', message: 'Too many requests' } });
  };

  // Per-IP limiter that only counts failed authentications (401). Runs first so a blocked IP is
  // rejected before any token lookup.
  r.use(
    rateLimit({
      windowMs: SERVICE_API_AUTH_FAILURE_WINDOW_MS,
      limit: SERVICE_API_AUTH_FAILURES_PER_IP,
      standardHeaders: false,
      legacyHeaders: false,
      keyGenerator: (req) => `authfail:${ipKeyGenerator(req.ip ?? '')}`,
      skipSuccessfulRequests: true,
      requestWasSuccessful: (_req, res) => res.statusCode !== 401,
      handler: tooMany,
    }),
  );
  r.use(
    rateLimit({
      windowMs: 60_000,
      limit: SERVICE_API_RATE_LIMIT_PER_MIN,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      keyGenerator: (req) => {
        const t = bearer(req);
        return t ? `st:${sha256hex(t)}` : `ip:${ipKeyGenerator(req.ip ?? '')}`;
      },
      handler: tooMany,
    }),
  );
  // Every route below needs a valid service token.
  r.use(requireServiceToken(db));

  // Decrypts all current secrets of the token's env.
  async function load(req: Request) {
    const t = req.serviceToken!;
    const values = await withEnvRead(db, t.envId, (tx, k) => currentValues(tx, k, t.envId));
    return { t, entries: [...values].map(([k, v]) => [k, v.value] as [string, string]) };
  }

  // Records a token.use audit entry for each call.
  const audit = (req: Request, endpoint: string, count: number, extra: Record<string, unknown> = {}) => {
    const t = req.serviceToken!;
    return recordAudit(db, {
      action: 'token.use',
      actorType: 'token',
      actorId: t.id,
      projectId: t.projectId,
      envId: t.envId,
      ip: req.ip ?? null,
      userAgent: req.get('user-agent')?.slice(0, 256) ?? null,
      meta: { endpoint, count, ...extra },
    });
  };

  // GET /secrets.ejson — secrets as an ejson file for a public key (export scope).
  r.get('/secrets.ejson', requireScope('export'), async (req, res) => {
    const pub = typeof req.query.pub === 'string' ? req.query.pub : req.serviceToken!.ejsonPublicKey;
    if (!pub || !HEX_KEY_RE.test(pub)) throw badRequest('Provide ?pub=<64 hex chars> or register an ejson key on the token');
    const { t, entries } = await load(req);
    const doc = buildExportDoc(pub, { project: t.projectSlug, env: t.envSlug }, entries);
    await audit(req, 'secrets.ejson', entries.length, { recipientPublicKey: pub });
    res.set('Content-Disposition', `attachment; filename="secrets.${t.envSlug}.ejson"`);
    res.json(doc);
  });

  // GET /secrets — secrets as JSON, or as ejson if the token has a key registered (read scope).
  r.get('/secrets', requireScope('read'), async (req, res) => {
    const { t, entries } = await load(req);
    if (t.ejsonPublicKey) {
      const doc = buildExportDoc(t.ejsonPublicKey, { project: t.projectSlug, env: t.envSlug }, entries);
      await audit(req, 'secrets', entries.length, { ejson: true });
      res.json(doc);
      return;
    }
    await audit(req, 'secrets', entries.length);
    res.json({ project: t.projectSlug, env: t.envSlug, secrets: Object.fromEntries(entries) });
  });

  return r;
}
