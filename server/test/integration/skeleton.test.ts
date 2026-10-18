import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recordAudit, verifyAuditChain } from '../../src/features/audit/audit.service.js';
import { setupTestApp, type TestHarness } from '../helpers/app.js';

let h: TestHarness;
beforeAll(async () => {
  h = await setupTestApp();
});
afterAll(() => h?.teardown());

// Basic app wiring: headers, CSRF, caching, sessions and the audit chain.
describe('app skeleton', () => {
  it('serves health and security headers', async () => {
    const res = await h.request().get('/healthz').expect(200);
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-frame-options']).toBeDefined();
  });

  it('rejects state-changing requests without a CSRF token', async () => {
    await h.request().post('/api/__test/login').send({}).expect(403);
  });

  it('sets no-store on API responses and 404s unknown routes', async () => {
    const res = await h.request().get('/api/nope').expect(404);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('logs in through the test harness with a session cookie', async () => {
    const u = await h.createUser();
    const agent = await h.agentFor(u);
    expect(agent.csrf).toBeTruthy();
  });

  it('audit chain verifies and detects tampering', async () => {
    for (let i = 0; i < 5; i++) await recordAudit(h.db, { action: 'test.event', actorType: 'system', meta: { i } });
    expect((await verifyAuditChain(h.db)).ok).toBe(true);
    const row = await h.db.auditLog.findFirst({ orderBy: { seq: 'asc' }, skip: 2 });
    await h.db.auditLog.update({ where: { seq: row!.seq }, data: { meta: { i: 999 } } });
    const v = await verifyAuditChain(h.db);
    expect(v.ok).toBe(false);
    expect(v.brokenAtSeq).toBe(row!.seq.toString());
  });

  it('concurrent audit appends keep a single chain', async () => {
    await h.db.auditLog.deleteMany();
    await Promise.all(Array.from({ length: 20 }, (_, i) => recordAudit(h.db, { action: 'c', actorType: 'system', meta: { i } })));
    expect(await verifyAuditChain(h.db)).toEqual({ ok: true, checked: 20 });
  });

  it('meta with undefined, Date and BigInt values hashes what is stored', async () => {
    await h.db.auditLog.deleteMany();
    await recordAudit(h.db, {
      action: 'test.meta',
      actorType: 'system',
      meta: { gone: undefined, at: new Date('2026-01-02T03:04:05.000Z'), big: 2n ** 60n, nested: { x: undefined } },
    });
    expect(await verifyAuditChain(h.db)).toEqual({ ok: true, checked: 1 });
    const row = await h.db.auditLog.findFirstOrThrow({ where: { action: 'test.meta' } });
    expect(row.meta).toEqual({ at: '2026-01-02T03:04:05.000Z', big: '1152921504606846976', nested: {} });
  });
});
