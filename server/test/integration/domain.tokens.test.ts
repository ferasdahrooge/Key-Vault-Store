import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Decrypter } from '../../src/config/ejson.js';
import { generateKeypair } from '../../src/config/ejson.js';
import { verifyAuditChain } from '../../src/features/audit/audit.service.js';
import { setupTestApp, type TestAgent, type TestHarness } from '../helpers/app.js';

let h: TestHarness;
let owner: Awaited<ReturnType<TestHarness['createUser']>>;
let as: TestAgent;
let envId: string;

// Creates a service token with the given scopes.
async function mint(scopes: string[], extra: Record<string, unknown> = {}) {
  const res = await as.post('/api/projects/app/envs/dev/tokens').send({ name: 'ci', scopes, ...extra }).expect(201);
  return res.body as { token: string; meta: { id: string } };
}
const v1 = (path: string, token: string) => h.request().get(`/api/v1${path}`).set('Authorization', `Bearer ${token}`);

beforeAll(async () => {
  h = await setupTestApp();
  owner = await h.createUser({ isAdmin: true });
  as = await h.agentFor(owner);
  const p = await as.post('/api/projects').send({ slug: 'app', name: 'App' }).expect(201);
  envId = p.body.project.environments.find((e: { slug: string }) => e.slug === 'dev').id;
  await as.post('/api/projects/app/envs/dev/secrets').send({ key: 'DB_PASS', value: 's3cret' }).expect(201);
}, 60_000);
afterAll(() => h?.teardown());

// Service-token access to /api/v1.
describe('machine API', () => {
  it('reads secrets with a read token and audits token.use', async () => {
    const { token, meta } = await mint(['read']);
    const res = await v1('/secrets', token).expect(200);
    expect(res.body).toEqual({ project: 'app', env: 'dev', secrets: { DB_PASS: 's3cret' } });
    const use = await h.db.auditLog.findFirst({ where: { action: 'token.use', actorId: meta.id } });
    expect(use?.envId).toBe(envId);
    expect(JSON.stringify(use?.meta)).not.toContain('s3cret');
  });

  it('enforces scopes', async () => {
    const { token } = await mint(['read']);
    await v1(`/secrets.ejson?pub=${generateKeypair().publicKey}`, token).expect(403);
  });

  it('export scope returns ejson decryptable by the recipient', async () => {
    const kp = generateKeypair();
    const { token } = await mint(['export']);
    const res = await v1(`/secrets.ejson?pub=${kp.publicKey}`, token).expect(200);
    expect(res.body.DB_PASS).toMatch(/^EJ\[/);
    expect(new Decrypter(kp.privateKey).decrypt(res.body.DB_PASS)).toBe('s3cret');
    await v1('/secrets.ejson', token).expect(400);
  });

  it('rejects revoked and unknown tokens with 401', async () => {
    const { token, meta } = await mint(['read']);
    await as.delete(`/api/projects/app/envs/dev/tokens/${meta.id}`).expect(200);
    expect((await v1('/secrets', token).expect(401)).body.error.code).toBe('invalid_token');
    await v1('/secrets', 'kv_st_' + 'x'.repeat(40)).expect(401);
    await h.request().get('/api/v1/secrets').expect(401);
  });

  it('token_inactive once the creator loses ownership', async () => {
    const { token } = await mint(['read']);
    await v1('/secrets', token).expect(200);
    await h.db.environmentMember.update({ where: { envId_userId: { envId, userId: owner.id } }, data: { role: 'editor' } });
    try {
      expect((await v1('/secrets', token).expect(401)).body.error.code).toBe('token_inactive');
    } finally {
      await h.db.environmentMember.update({ where: { envId_userId: { envId, userId: owner.id } }, data: { role: 'owner' } });
    }
    await v1('/secrets', token).expect(200);
  });

  it('token_inactive once the creator is disabled', async () => {
    const { token } = await mint(['read']);
    await h.db.user.update({ where: { id: owner.id }, data: { status: 'disabled' } });
    try {
      expect((await v1('/secrets', token).expect(401)).body.error.code).toBe('token_inactive');
    } finally {
      await h.db.user.update({ where: { id: owner.id }, data: { status: 'active' } });
    }
  });

  it('rate-limits per token (60/min), independent of other tokens', async () => {
    const a = await mint(['read']);
    const b = await mint(['read']);
    for (let i = 0; i < 60; i++) await v1('/secrets', a.token).expect(200);
    expect((await v1('/secrets', a.token).expect(429)).body.error.code).toBe('rate_limited');
    await v1('/secrets', b.token).expect(200);
  }, 60_000);

  it('audit chain verifies', async () => {
    expect(await verifyAuditChain(h.db)).toMatchObject({ ok: true });
  });
});
