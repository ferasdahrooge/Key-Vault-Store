import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setDekRotationThreshold } from '../../src/features/key-rotation/dekRotation.service.js';
import { verifyAuditChain } from '../../src/features/audit/audit.service.js';
import { setupTestApp, type TestAgent, type TestHarness } from '../helpers/app.js';

let h: TestHarness;
let owner: Awaited<ReturnType<TestHarness['createUser']>>;
let as: TestAgent;
const base = (env: string) => `/api/projects/app/envs/${env}/secrets`;

// Creates a secret through the API and returns its id/version.
async function create(env: string, key: string, value: string, agent = as) {
  return (await agent.post(base(env)).send({ key, value }).expect(201)).body.secret as { id: string; currentVersion: number };
}
function reveal(env: string, id: string, version?: number, agent = as) {
  return agent.post(`${base(env)}/${id}/reveal`).send(version ? { version } : {});
}
const envRow = (slug: string) => h.db.environment.findFirstOrThrow({ where: { slug, project: { slug: 'app' } } });

beforeAll(async () => {
  h = await setupTestApp();
  owner = await h.createUser({ isAdmin: true });
  as = await h.agentFor(owner);
  await as.post('/api/projects').send({ slug: 'app', name: 'App' }).expect(201);
}, 60_000);
afterAll(() => {
  setDekRotationThreshold(undefined);
  return h?.teardown();
});

// Secret CRUD, versioning, protection and DEK rotation.
describe('secrets', () => {
  it('versioning + rollback restores old plaintext as a new version', async () => {
    const s = await create('dev', 'VERSIONED', 'one');
    await as.patch(`${base('dev')}/${s.id}`).send({ value: 'two', comment: 'bump' }).expect(200);
    const v = (await as.get(`${base('dev')}/${s.id}/versions`).expect(200)).body.versions;
    expect(v.map((x: { version: number }) => x.version)).toEqual([2, 1]);
    expect(v[0].comment).toBe('bump');
    expect((await reveal('dev', s.id).expect(200)).body).toEqual({ value: 'two', version: 2 });
    expect((await reveal('dev', s.id, 1).expect(200)).body.value).toBe('one');
    await reveal('dev', s.id, 9).expect(404);

    const rb = await as.post(`${base('dev')}/${s.id}/rollback/1`).send({}).expect(200);
    expect(rb.body.secret.currentVersion).toBe(3);
    expect((await reveal('dev', s.id).expect(200)).body).toEqual({ value: 'one', version: 3 });
    await as.post(`${base('dev')}/${s.id}/rollback/3`).send({}).expect(400);
    await as.post(`${base('dev')}/${s.id}/rollback/7`).send({}).expect(404);
  });

  it('list never contains values; reveal is audited without the value', async () => {
    const s = await create('dev', 'LISTED', 'plain-zebra-42');
    const list = await as.get(base('dev')).expect(200);
    expect(list.body.secrets.some((x: { key: string }) => x.key === 'LISTED')).toBe(true);
    expect(JSON.stringify(list.body)).not.toContain('plain-zebra-42');
    expect(JSON.stringify((await as.get(`${base('dev')}/${s.id}`).expect(200)).body)).not.toContain('plain-zebra-42');

    await reveal('dev', s.id).expect(200);
    const row = await h.db.auditLog.findFirst({ where: { action: 'secret.reveal', secretId: s.id } });
    expect(row?.meta).toEqual({ key: 'LISTED', version: 1 });
    const all = await h.db.auditLog.findMany({ select: { meta: true } });
    expect(JSON.stringify(all)).not.toContain('plain-zebra-42');
  });

  it('AAD tamper: swapping ciphertexts between secrets fails closed with 500 and no value', async () => {
    const a = await create('dev', 'TAMPER_A', 'alpha-value');
    const b = await create('dev', 'TAMPER_B', 'bravo-value');
    const va = await h.db.secretVersion.findFirstOrThrow({ where: { secretId: a.id, version: 1 } });
    const vb = await h.db.secretVersion.findFirstOrThrow({ where: { secretId: b.id, version: 1 } });
    await h.db.secretVersion.update({ where: { secretId_version: { secretId: a.id, version: 1 } }, data: { ciphertext: vb.ciphertext, iv: vb.iv, tag: vb.tag } });
    await h.db.secretVersion.update({ where: { secretId_version: { secretId: b.id, version: 1 } }, data: { ciphertext: va.ciphertext, iv: va.iv, tag: va.tag } });
    for (const id of [a.id, b.id]) {
      const res = await reveal('dev', id).expect(500);
      expect(res.body.error.code).toBe('decryption_failed');
      expect(res.text).not.toMatch(/alpha-value|bravo-value/);
    }
    expect(await h.db.auditLog.count({ where: { action: 'secret.reveal', secretId: { in: [a.id, b.id] } } })).toBe(0);
    // Clean up so the env stays rotatable.
    await as.delete(`${base('dev')}/${a.id}`).expect(200);
    await as.delete(`${base('dev')}/${b.id}`).expect(200);
  });

  it('protected env requires confirm on PATCH/DELETE/rollback and recent MFA on reveal', async () => {
    const s = await create('prod', 'PROD_KEY', 'p1');
    const c1 = await as.patch(`${base('prod')}/${s.id}`).send({ value: 'p2' }).expect(400);
    expect(c1.body.error.code).toBe('confirm_required');
    await as.patch(`${base('prod')}/${s.id}`).send({ value: 'p2', confirm: 'staging' }).expect(400);
    await as.patch(`${base('prod')}/${s.id}`).send({ value: 'p2', confirm: 'prod' }).expect(200);
    expect((await as.post(`${base('prod')}/${s.id}/rollback/1`).send({}).expect(400)).body.error.code).toBe('confirm_required');
    await as.post(`${base('prod')}/${s.id}/rollback/1`).send({ confirm: 'prod' }).expect(200);

    const stale = await h.agentFor(owner, { mfaAgoMs: 600_000 });
    const r = await reveal('prod', s.id, undefined, stale).expect(401);
    expect(r.body.error.code).toBe('reauth_required');
    expect(r.text).not.toContain('p1');
    await stale.get(base('prod')).expect(200); // listing is fine
    const devS = await create('dev', 'DEV_STALE', 'd', stale);
    await reveal('dev', devS.id, undefined, stale).expect(200); // unprotected env: no MFA needed

    expect((await as.delete(`${base('prod')}/${s.id}`).expect(400)).body.error.code).toBe('confirm_required');
    await as.delete(`${base('prod')}/${s.id}?confirm=prod`).expect(200);
    await reveal('prod', s.id).expect(404);
  });

  it('protected env: rotate-key and env PATCH need confirm; un-protecting needs MFA and is audited', async () => {
    const prod = '/api/projects/app/envs/prod';
    expect((await as.post(`${prod}/rotate-key`).send({}).expect(400)).body.error.code).toBe('confirm_required');
    await as.post(`${prod}/rotate-key`).send({ confirm: 'dev' }).expect(400);
    await as.post(`${prod}/rotate-key`).send({ confirm: 'prod' }).expect(200);

    expect((await as.patch(prod).send({ name: 'Production' }).expect(400)).body.error.code).toBe('confirm_required');
    expect((await as.patch(prod).send({ protected: false }).expect(400)).body.error.code).toBe('confirm_required');
    await as.patch(prod).send({ name: 'Production', confirm: 'prod' }).expect(200);
    const stale = await h.agentFor(owner, { mfaAgoMs: 600_000 });
    expect((await stale.patch(prod).send({ protected: false, confirm: 'prod' }).expect(401)).body.error.code).toBe('reauth_required');
    const off = await as.patch(prod).send({ protected: false, confirm: 'prod' }).expect(200);
    expect(off.body.environment.protected).toBe(false);
    await as.patch(prod).send({ name: 'Prod' }).expect(200); // no longer protected → no confirm
    await as.patch(prod).send({ protected: true }).expect(200);
    const rows = await h.db.auditLog.findMany({ where: { action: 'env.updated' }, orderBy: { seq: 'asc' } });
    const flags = rows.map((r) => (r.meta as { protected?: unknown }).protected).filter(Boolean);
    expect(flags).toEqual([{ from: true, to: false }, { from: false, to: true }]);
    await as.patch(prod).send({ name: 'x' }).expect(400); // protected again
  });

  it('manual rotate-key preserves every version and needs recent MFA', async () => {
    const s = await create('staging', 'ROT', 'r1');
    await as.patch(`${base('staging')}/${s.id}`).send({ value: 'r2' }).expect(200);
    const before = await envRow('staging');
    const stale = await h.agentFor(owner, { mfaAgoMs: 600_000 });
    await stale.post('/api/projects/app/envs/staging/rotate-key').send({}).expect(401);
    await as.post('/api/projects/app/envs/staging/rotate-key').send({}).expect(200);
    const after = await envRow('staging');
    expect(after.dekVersion).toBe(before.dekVersion + 1);
    expect(Buffer.from(after.wrappedDek).equals(Buffer.from(before.wrappedDek))).toBe(false);
    expect((await reveal('staging', s.id, 1).expect(200)).body.value).toBe('r1');
    expect((await reveal('staging', s.id, 2).expect(200)).body.value).toBe('r2');
  });

  it('reveal/export never 500 while a rotation runs concurrently', async () => {
    const s = await create('staging', 'RACE', 'race-1');
    for (let i = 2; i <= 5; i++) await as.patch(`${base('staging')}/${s.id}`).send({ value: `race-${i}` }).expect(200);
    const { generateKeypair } = await import('../../src/config/ejson.js');
    const pub = generateKeypair().publicKey;
    for (let round = 0; round < 3; round++) {
      const results = await Promise.all([
        as.post('/api/projects/app/envs/staging/rotate-key').send({}),
        ...Array.from({ length: 8 }, (_, i) => reveal('staging', s.id, (i % 5) + 1)),
        as.post('/api/projects/app/envs/staging/export').send({ recipientPublicKey: pub }),
      ]);
      expect(results.map((r) => r.status)).toEqual(results.map(() => 200));
    }
  }, 60_000);

  it('auto-rotates the DEK once the encryption counter crosses the threshold', async () => {
    const s = await create('staging', 'AUTO', 'a1');
    const before = await envRow('staging');
    setDekRotationThreshold(3);
    try {
      for (const v of ['a2', 'a3', 'a4']) await as.patch(`${base('staging')}/${s.id}`).send({ value: v }).expect(200);
    } finally {
      setDekRotationThreshold(undefined);
    }
    const after = await envRow('staging');
    expect(after.dekVersion).toBeGreaterThan(before.dekVersion);
    for (const [i, v] of ['a1', 'a2', 'a3', 'a4'].entries()) {
      expect((await reveal('staging', s.id, i + 1).expect(200)).body.value).toBe(v);
    }
  });

  it('audit chain verifies', async () => {
    expect(await verifyAuditChain(h.db)).toMatchObject({ ok: true });
  });
});
