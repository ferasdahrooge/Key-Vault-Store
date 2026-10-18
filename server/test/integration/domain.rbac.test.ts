import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateKeypair } from '../../src/config/ejson.js';
import { setupTestApp, type TestAgent, type TestHarness } from '../helpers/app.js';

type User = Awaited<ReturnType<TestHarness['createUser']>>;
let h: TestHarness;
let owner: User, editorU: User, viewerU: User, outsiderU: User, admin2U: User;
let as: TestAgent, editor: TestAgent, viewer: TestAgent, outsider: TestAgent, admin2: TestAgent;
let secretId: string;
let devId: string;
const dev = '/api/projects/app/envs/dev';

beforeAll(async () => {
  h = await setupTestApp();
  owner = await h.createUser({ isAdmin: true });
  admin2U = await h.createUser({ isAdmin: true });
  [editorU, viewerU, outsiderU] = (await Promise.all([h.createUser(), h.createUser(), h.createUser()])) as [User, User, User];
  as = await h.agentFor(owner);
  const p = await as.post('/api/projects').send({ slug: 'app', name: 'App' }).expect(201);
  devId = p.body.project.environments.find((e: { slug: string }) => e.slug === 'dev').id;
  await as.put(`${dev}/members/${editorU.id}`).send({ role: 'editor' }).expect(200);
  await as.put(`${dev}/members/${viewerU.id}`).send({ role: 'viewer' }).expect(200);
  [editor, viewer, outsider, admin2] = (await Promise.all([editorU, viewerU, outsiderU, admin2U].map((u) => h.agentFor(u)))) as [TestAgent, TestAgent, TestAgent, TestAgent];
  secretId = (await as.post(`${dev}/secrets`).send({ key: 'K', value: 'top-secret-val' }).expect(201)).body.secret.id;
  await as.patch(`${dev}/secrets/${secretId}`).send({ value: 'top-secret-v2' }).expect(200);
}, 60_000);
afterAll(() => h?.teardown());

// What each role can and cannot do.
describe('RBAC matrix', () => {
  it('PUT members upserts: creates a missing member, then changes the role', async () => {
    const u = await h.createUser({ email: 'new-member@test.local' });
    const add = await as.put(`${dev}/members/${u.id}`).send({ role: 'viewer' }).expect(200);
    expect(add.body.member).toMatchObject({ user: { id: u.id, email: 'new-member@test.local' }, role: 'viewer', expiresAt: null });
    await as.put(`${dev}/members/${u.id}`).send({ role: 'editor' }).expect(200);
    const list = (await as.get(`${dev}/members`).expect(200)).body.members;
    expect(list.find((m: { user: { id: string } }) => m.user.id === u.id).role).toBe('editor');
    await as.delete(`${dev}/members/${u.id}`).expect(200);
    await as.put(`${dev}/members/00000000-0000-4000-8000-000000000000`).send({ role: 'viewer' }).expect(404);
  });

  it('sole owner: demote and delete both → 409 last_owner', async () => {
    const staging = '/api/projects/app/envs/staging';
    expect((await as.put(`${staging}/members/${owner.id}`).send({ role: 'editor' }).expect(409)).body.error.code).toBe('last_owner');
    expect((await as.delete(`${staging}/members/${owner.id}`).expect(409)).body.error.code).toBe('last_owner');
  });

  it('viewer can read/reveal but not create, update, delete or rollback', async () => {
    await viewer.get(`${dev}/secrets`).expect(200);
    await viewer.post(`${dev}/secrets/${secretId}/reveal`).send({}).expect(200);
    await viewer.get(`${dev}/secrets/${secretId}/versions`).expect(200);
    await viewer.post(`${dev}/secrets`).send({ key: 'V', value: 'x' }).expect(403);
    await viewer.patch(`${dev}/secrets/${secretId}`).send({ value: 'x' }).expect(403);
    await viewer.delete(`${dev}/secrets/${secretId}`).expect(403);
    await viewer.post(`${dev}/secrets/${secretId}/rollback/1`).send({}).expect(403);
  });

  it('editor can write but not manage members, export, tokens or rotate the key', async () => {
    const s = await editor.post(`${dev}/secrets`).send({ key: 'E', value: 'e1' }).expect(201);
    await editor.patch(`${dev}/secrets/${s.body.secret.id}`).send({ value: 'e2' }).expect(200);
    await editor.delete(`${dev}/secrets/${s.body.secret.id}`).expect(200);
    await editor.put(`${dev}/members/${outsiderU.id}`).send({ role: 'viewer' }).expect(403);
    await editor.delete(`${dev}/members/${viewerU.id}`).expect(403);
    await editor.post(`${dev}/export`).send({ recipientPublicKey: generateKeypair().publicKey }).expect(403);
    await editor.get(`${dev}/tokens`).expect(403);
    await editor.post(`${dev}/tokens`).send({ name: 'x', scopes: ['read'] }).expect(403);
    await editor.post(`${dev}/rotate-key`).send({}).expect(403);
    await editor.patch(dev).send({ name: 'Renamed' }).expect(403);
  });

  it('non-member and admin-non-member get 404 on list and reveal', async () => {
    for (const a of [outsider, admin2]) {
      await a.get(`${dev}/secrets`).expect(404);
      const r = await a.post(`${dev}/secrets/${secretId}/reveal`).send({}).expect(404);
      expect(r.text).not.toContain('top-secret');
      await a.get(`${dev}/secrets/${secretId}`).expect(404);
      await a.get(`${dev}/members`).expect(404);
    }
    await outsider.get('/api/projects/app/envs/nope/secrets').expect(404);
    await outsider.get('/api/projects/app/compare').expect(404);
  });

  it('admin self-grant (break-glass) then has access', async () => {
    const staging = '/api/projects/app/envs/staging';
    await admin2.get(`${staging}/secrets`).expect(404);
    await admin2.put(`${staging}/members/${admin2U.id}`).send({ role: 'viewer' }).expect(200);
    await admin2.get(`${staging}/secrets`).expect(200);
    // Owners are notified via one audit notice row each.
    const notices = await h.db.auditLog.findMany({ where: { action: 'member.admin_self_grant.notice' } });
    expect(notices.map((n) => n.meta)).toEqual([{ ownerId: owner.id, adminId: admin2U.id, role: 'viewer' }]);
    await outsider.put(`${staging}/members/${outsiderU.id}`).send({ role: 'owner' }).expect(404);
  });

  it('unknown /api route is 404 even unauthenticated', async () => {
    const r = await h.request().get('/api/nope').expect(404);
    expect(r.body.error?.code).not.toBe('unauthenticated');
    await h.request().get(`${dev}/secrets`).expect(401);
  });
});

// The compare view respects membership.
describe('compare', () => {
  it('only shows envs the caller is a member of', async () => {
    await as.post('/api/projects/app/envs/staging/secrets').send({ key: 'STAGING_ONLY', value: 's' }).expect(201);
    const mine = await viewer.get('/api/projects/app/compare').expect(200);
    expect(mine.body.envs).toEqual(['dev']);
    expect(mine.body.keys.map((k: { key: string }) => k.key)).not.toContain('STAGING_ONLY');
    const asked = await viewer.get('/api/projects/app/compare?envs=dev,staging,prod').expect(200);
    expect(asked.body.envs).toEqual(['dev']);
    const all = await as.get('/api/projects/app/compare').expect(200);
    expect(all.body.envs).toEqual(['dev', 'staging', 'prod']);
    expect(JSON.stringify(all.body)).not.toContain('top-secret');
  });
});

// Requesting and granting temporary access.
describe('access requests', () => {
  it('non-member requests → owner approves → time-boxed access → expiry removes it', async () => {
    const req = await outsider
      .post(`${dev}/access-requests`)
      .send({ role: 'viewer', reason: 'debugging', durationMin: 30 })
      .expect(201);
    const id = req.body.request.id;
    expect(req.body.request.status).toBe('pending');

    // self-decide rejected (even by someone who could approve, the requester is not an owner here)
    await outsider.post(`/api/access-requests/${id}/decide`).send({ approve: true }).expect((r) => expect([403, 404]).toContain(r.status));
    await editor.post(`/api/access-requests/${id}/decide`).send({ approve: true }).expect((r) => expect([403, 404]).toContain(r.status));

    const pending = await as.get('/api/access-requests').expect(200);
    expect(JSON.stringify(pending.body)).toContain(id);

    await as.post(`/api/access-requests/${id}/decide`).send({ approve: true }).expect(200);
    const m = await h.db.environmentMember.findUniqueOrThrow({ where: { envId_userId: { envId: devId, userId: outsiderU.id } } });
    expect(m.role).toBe('viewer');
    expect(m.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 25 * 60_000);
    expect(m.expiresAt!.getTime()).toBeLessThan(Date.now() + 31 * 60_000);
    await outsider.get(`${dev}/secrets`).expect(200);
    await outsider.post(`/api/access-requests/${id}/decide`).send({ approve: false }).expect(404); // not an owner
    await as.post(`/api/access-requests/${id}/decide`).send({ approve: false }).expect(409);

    await h.db.environmentMember.update({
      where: { envId_userId: { envId: devId, userId: outsiderU.id } },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await outsider.get(`${dev}/secrets`).expect(404);
    await outsider.post(`${dev}/secrets/${secretId}/reveal`).send({}).expect(404);
    const after = await as.get(`${dev}/members`).expect(200);
    expect(after.body.members.map((x: { user: { id: string } }) => x.user.id)).not.toContain(outsiderU.id);
  });

  it('an owner cannot approve their own request', async () => {
    // owner of dev requests editor on staging? owner is already owner everywhere; use admin2 who is a staging viewer.
    const staging = '/api/projects/app/envs/staging';
    const r = await admin2.post(`${staging}/access-requests`).send({ role: 'editor', reason: 'x', durationMin: 10 }).expect(201);
    // Make admin2 an owner too, then try to self-approve.
    await as.put(`${staging}/members/${admin2U.id}`).send({ role: 'owner' }).expect(200);
    const res = await admin2.post(`/api/access-requests/${r.body.request.id}/decide`).send({ approve: true }).expect(403);
    expect(res.body.error.message).toMatch(/own request/);
  });
});

// Approvals must not downgrade or expire permanent roles.
describe('access requests never overwrite permanent roles', () => {
  it('lower permanent role → 409 already_member, membership untouched; higher/equal → no-op', async () => {
    const v = await h.createUser();
    await as.put(`${dev}/members/${v.id}`).send({ role: 'viewer' }).expect(200);
    const va = await h.agentFor(v);
    const up = await va.post(`${dev}/access-requests`).send({ role: 'editor', reason: 'x', durationMin: 60 }).expect(201);
    const r = await as.post(`/api/access-requests/${up.body.request.id}/decide`).send({ approve: true }).expect(409);
    expect(r.body.error.code).toBe('already_member');
    const m = await h.db.environmentMember.findUniqueOrThrow({ where: { envId_userId: { envId: devId, userId: v.id } } });
    expect(m).toMatchObject({ role: 'viewer', expiresAt: null });
    await as.post(`/api/access-requests/${up.body.request.id}/decide`).send({ approve: false }).expect(200);

    const down = await va.post(`${dev}/access-requests`).send({ role: 'viewer', reason: 'x', durationMin: 60 }).expect(201);
    await as.post(`/api/access-requests/${down.body.request.id}/decide`).send({ approve: true }).expect(200);
    expect(await h.db.environmentMember.findUniqueOrThrow({ where: { envId_userId: { envId: devId, userId: v.id } } })).toMatchObject({
      role: 'viewer',
      expiresAt: null,
    });
  });
});

// An environment always keeps an owner.
describe('last owner', () => {
  it('disabled owners do not count as the remaining owner', async () => {
    const prod = '/api/projects/app/envs/prod';
    const o2 = await h.createUser();
    await as.put(`${prod}/members/${o2.id}`).send({ role: 'owner' }).expect(200);
    await h.db.user.update({ where: { id: o2.id }, data: { status: 'disabled' } });
    expect((await as.put(`${prod}/members/${owner.id}`).send({ role: 'editor' }).expect(409)).body.error.code).toBe('last_owner');
    // A time-boxed owner doesn't count either.
    await h.db.user.update({ where: { id: o2.id }, data: { status: 'active' } });
    await h.db.environmentMember.update({
      where: { envId_userId: { envId: (await h.db.environment.findFirstOrThrow({ where: { slug: 'prod' } })).id, userId: o2.id } },
      data: { expiresAt: new Date(Date.now() + 3600_000) },
    });
    await as.put(`${prod}/members/${owner.id}`).send({ role: 'editor' }).expect(409);
    await as.delete(`${prod}/members/${owner.id}`).expect(409);
  });
});

// Who may read the audit log.
describe('audit route', () => {
  it('owner must pass envId; non-owner 403; non-member 404; admin sees all', async () => {
    const owners = await h.createUser();
    await as.put(`${dev}/members/${owners.id}`).send({ role: 'owner' }).expect(200);
    const o = await h.agentFor(owners);
    await o.get('/api/audit').expect(403);
    const mine = await o.get(`/api/audit?envId=${devId}`).expect(200);
    expect(mine.body.entries.length).toBeGreaterThan(0);
    expect(mine.body.entries.every((e: { envId: string }) => e.envId === devId)).toBe(true);
    expect(JSON.stringify(mine.body)).not.toContain('top-secret');
    await editor.get(`/api/audit?envId=${devId}`).expect(403);
    await viewer.get(`/api/audit?envId=${devId}`).expect(403);
    await outsider.get(`/api/audit?envId=${devId}`).expect(404);
    await o.get('/api/audit/verify').expect(403);

    const all = await as.get('/api/audit?limit=200').expect(200);
    expect(new Set(all.body.entries.map((e: { envId: string | null }) => e.envId)).size).toBeGreaterThan(1);
    const page = await as.get('/api/audit?limit=2').expect(200);
    expect(page.body.entries).toHaveLength(2);
    const next = await as.get(`/api/audit?limit=2&before=${page.body.nextBefore}`).expect(200);
    expect(BigInt(next.body.entries[0].seq)).toBeLessThan(BigInt(page.body.entries[1].seq));
  });

  it('/api/audit/verify ok at the end', async () => {
    expect((await as.get('/api/audit/verify').expect(200)).body).toMatchObject({ ok: true });
  });
});
