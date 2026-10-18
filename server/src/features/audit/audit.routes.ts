/**
 * /api/audit — admins read everything; environment owners read only their environment and must
 * pass envId. Entries are returned newest first; page with `before` (= nextBefore).
 */
import type { AuditLog, Prisma } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { requireAdmin, requireAuth } from '../auth/auth.middleware.js';
import { forbidden, notFound, parse } from '../../core/http.js';
import { verifyAuditChain } from './audit.service.js';
import { activeMemberWhere } from '../projects/environments.service.js';
import type { AppDeps } from '../../core/types.js';
import type { Db } from '../../core/db.js';

// Filters and cursor pagination for the audit list.
const query = z.object({
  envId: z.uuid().optional(),
  actorId: z.uuid().optional(),
  action: z.string().max(64).optional(),
  before: z.string().regex(/^\d{1,19}$/).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

// Adds actor names/emails to audit rows for display.
async function toDtos(db: Db, rows: AuditLog[]) {
  const ids = [...new Set(rows.filter((r) => r.actorType === 'user' && r.actorId).map((r) => r.actorId!))];
  const users = new Map(
    (await db.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, email: true } })).map((u) => [u.id, u]),
  );
  return rows.map((r) => ({
    seq: r.seq.toString(),
    at: r.at,
    actorType: r.actorType,
    actorId: r.actorId,
    actor: r.actorType === 'user' && r.actorId ? (users.get(r.actorId) ?? null) : null,
    action: r.action,
    projectId: r.projectId,
    envId: r.envId,
    secretId: r.secretId,
    ip: r.ip,
    meta: r.meta,
  }));
}

export function auditRouter(deps: AppDeps): Router {
  const { db } = deps;
  const r = Router();
  r.use(requireAuth(db));

  // GET — list audit entries (admins: all; owners: their env only).
  r.get('/', async (req, res) => {
    const q = parse(query, req.query);
    const user = req.user!;
    if (!user.isAdmin) {
      if (!q.envId) throw forbidden('envId is required');
      const m = await db.environmentMember.findFirst({
        where: { envId: q.envId, userId: user.id, ...activeMemberWhere() },
        select: { role: true },
      });
      if (!m) throw notFound();
      if (m.role !== 'owner') throw forbidden('Requires owner role');
    }
    const where: Prisma.AuditLogWhereInput = {
      ...(q.envId ? { envId: q.envId } : {}),
      ...(q.actorId ? { actorId: q.actorId } : {}),
      ...(q.action ? { action: q.action } : {}),
      ...(q.before ? { seq: { lt: BigInt(q.before) } } : {}),
    };
    const rows = await db.auditLog.findMany({ where, orderBy: { seq: 'desc' }, take: q.limit });
    res.json({
      entries: await toDtos(db, rows),
      nextBefore: rows.length === q.limit ? rows[rows.length - 1]!.seq.toString() : null,
    });
  });

  // GET /verify — check the audit hash chain for tampering (admin).
  r.get('/verify', requireAdmin, async (_req, res) => {
    res.json(await verifyAuditChain(db));
  });

  // GET /export.jsonl — stream the whole log as JSON lines, 500 rows at a time (admin).
  r.get('/export.jsonl', requireAdmin, async (_req, res) => {
    res.type('application/x-ndjson');
    res.set('Content-Disposition', 'attachment; filename="audit.jsonl"');
    let cursor: bigint | undefined;
    for (;;) {
      const rows = await db.auditLog.findMany({
        orderBy: { seq: 'asc' },
        take: 500,
        ...(cursor !== undefined ? { where: { seq: { gt: cursor } } } : {}),
      });
      if (rows.length === 0) break;
      for (const row of rows) {
        res.write(JSON.stringify({ ...row, seq: row.seq.toString() }) + '\n');
      }
      cursor = rows[rows.length - 1]!.seq;
    }
    res.end();
  });

  return r;
}
