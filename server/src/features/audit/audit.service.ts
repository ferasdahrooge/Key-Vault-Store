/**
 * Append-only, hash-chained audit log.
 *   hash = sha256(prevHash + canonicalJSON(entry))
 * Appends are serialised with a transaction-scoped advisory lock so the chain never forks.
 */
import type { Request } from 'express';
import type { ActorType, AuditLog, Prisma } from '@prisma/client';
import { sha256hex } from '../../crypto/random.js';
import type { Db } from '../../core/db.js';

// Hash the first entry chains from, and the advisory-lock id for appends.
const GENESIS = '0'.repeat(64);
const LOCK_KEY = 0x6b76_6175; // "kvau"

// One audit event as callers describe it.
export interface AuditEntry {
  action: string; // e.g. "secret.reveal", "auth.login.failed"
  actorType: ActorType;
  actorId?: string | null;
  projectId?: string | null;
  envId?: string | null;
  secretId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  meta?: Record<string, unknown>; // NEVER put secret values here
}

type Tx = Prisma.TransactionClient;

// Appends one entry, hashed together with the previous entry's hash.
export async function recordAudit(db: Db | Tx, entry: AuditEntry): Promise<void> {
  const run = async (tx: Tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LOCK_KEY})`;
    const last = await tx.auditLog.findFirst({ orderBy: { seq: 'desc' }, select: { hash: true } });
    const prevHash = last?.hash ?? GENESIS;
    const at = new Date();
    const body = normalise(entry, at);
    const hash = sha256hex(prevHash + canonicalJson(body));
    await tx.auditLog.create({ data: { ...body, at, meta: body.meta as Prisma.InputJsonValue, prevHash, hash } });
  };
  // Open our own transaction unless the caller already passed one.
  if ('$transaction' in db) await db.$transaction(run);
  else await run(db);
}

/** Convenience: fills actor, ip and user agent from the request. */
export function auditFromReq(db: Db | Tx, req: Request, entry: Omit<AuditEntry, 'actorType' | 'actorId' | 'ip' | 'userAgent'>) {
  const actor = req.actor;
  return recordAudit(db, {
    ...entry,
    actorType: actor?.type ?? 'system',
    actorId: actor?.id ?? null,
    envId: entry.envId ?? req.envCtx?.envId ?? null,
    projectId: entry.projectId ?? req.envCtx?.projectId ?? null,
    ip: req.ip ?? null,
    userAgent: req.get('user-agent')?.slice(0, 256) ?? null,
  });
}

// Result of walking the chain: ok, how many rows checked, where it broke.
export interface ChainVerification {
  ok: boolean;
  checked: number;
  brokenAtSeq?: string;
}

// Recomputes every hash in order (1000 rows at a time) to detect tampering.
export async function verifyAuditChain(db: Db): Promise<ChainVerification> {
  let prev = GENESIS;
  let checked = 0;
  let cursor: bigint | undefined;
  for (;;) {
    const rows: AuditLog[] = await db.auditLog.findMany({
      orderBy: { seq: 'asc' },
      take: 1000,
      ...(cursor !== undefined ? { cursor: { seq: cursor }, skip: 1 } : {}),
    });
    if (rows.length === 0) return { ok: true, checked };
    for (const r of rows) {
      const expected = sha256hex(prev + canonicalJson(normalise(r, r.at)));
      if (r.prevHash !== prev || r.hash !== expected) return { ok: false, checked, brokenAtSeq: r.seq.toString() };
      prev = r.hash;
      checked++;
    }
    cursor = rows[rows.length - 1]!.seq;
  }
}

// The exact fields that go into an entry's hash.
function normalise(e: AuditEntry | AuditLog, at: Date) {
  return {
    action: e.action,
    actorType: e.actorType,
    actorId: e.actorId ?? null,
    projectId: e.projectId ?? null,
    envId: e.envId ?? null,
    secretId: e.secretId ?? null,
    ip: e.ip ?? null,
    userAgent: e.userAgent ?? null,
    // Normalise once so the hash covers exactly what jsonb stores: undefined keys dropped, Dates as
    // ISO strings, BigInts as decimal strings (JSON.stringify would otherwise throw).
    meta: JSON.parse(JSON.stringify(e.meta ?? {}, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))) as Record<string, unknown>,
    at: at.toISOString(),
  };
}

// JSON with sorted keys, so the same data always hashes the same.
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(v as object).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`).join(',')}}`;
}
