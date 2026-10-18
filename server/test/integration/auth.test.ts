import { randomUUID } from 'node:crypto';
import supertest from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_FAILURES } from '../../src/features/auth/lockout.js';
import { hashPassword } from '../../src/features/auth/password.js';
import { regenerateRecoveryCodes } from '../../src/features/auth/recovery.js';
import { currentTotpCode, newTotpSecret, storeUnconfirmedTotp } from '../../src/features/auth/totp.js';
import { setupTestApp, type TestAgent, type TestHarness } from '../helpers/app.js';

// Shared password and harness for every test in this file.
const PASSWORD = 'correct horse battery staple';
let h: TestHarness;
let passwordHash: string;

beforeAll(async () => {
  h = await setupTestApp();
  passwordHash = await hashPassword(PASSWORD);
});
afterAll(() => h?.teardown());

// ------------------------------------------------------------------ helpers

const email = () => `u-${randomUUID().slice(0, 8)}@test.local`;

/** Anonymous agent with a CSRF header. */
async function anon(): Promise<TestAgent> {
  const agent = supertest.agent(h.app) as TestAgent;
  return refreshCsrf(agent);
}

/** Every login transition regenerates the session, which drops the CSRF token; fetch a new one. */
async function refreshCsrf(agent: TestAgent): Promise<TestAgent> {
  agent.csrf = (await agent.get('/api/csrf').expect(200)).body.token as string;
  agent.set('x-csrf-token', agent.csrf);
  return agent;
}

/** Active user with a password, a confirmed TOTP seed and recovery codes. */
async function enrolledUser(opts: { isAdmin?: boolean } = {}) {
  const user = await h.db.user.create({
    data: { email: email(), name: 'Enrolled', passwordHash, status: 'active', isAdmin: opts.isAdmin ?? false },
  });
  const secret = newTotpSecret();
  await storeUnconfirmedTotp(h.db, user.id, secret);
  await h.db.totpSecret.update({ where: { userId: user.id }, data: { confirmed: true } });
  const recoveryCodes = await regenerateRecoveryCodes(h.db, user.id);
  return { user, secret, recoveryCodes };
}

/**
 * A TOTP code that has not been consumed yet. Each step can be used once, so tests that need several
 * MFA steps in a row rewind the stored lastStep (test-only DB manipulation) instead of waiting 30 s.
 */
async function freshCode(userId: string, secret: string): Promise<string> {
  await h.db.totpSecret.update({ where: { userId }, data: { lastStep: 0n } });
  return currentTotpCode(secret);
}

function passwordStep(agent: TestAgent, mail: string, password = PASSWORD) {
  return agent.post('/api/auth/login').send({ email: mail, password });
}

/** Full login: password, then TOTP. Returns the agent with a refreshed CSRF token. */
async function login(u: { user: { id: string; email: string }; secret: string }): Promise<TestAgent> {
  const agent = await anon();
  const r1 = await passwordStep(agent, u.user.email).expect(200);
  expect(r1.body).toEqual({ mfaRequired: true, methods: ['totp', 'recovery'] });
  await refreshCsrf(agent);
  const r2 = await agent.post('/api/auth/mfa/totp').send({ code: await freshCode(u.user.id, u.secret) }).expect(200);
  expect(r2.body.user).toMatchObject({ id: u.user.id, email: u.user.email });
  return refreshCsrf(agent);
}

const failures = (id: string) => h.db.user.findUniqueOrThrow({ where: { id } }).then((u) => u.failedLogins);

// ------------------------------------------------------------------ tests

// Password + second-factor login flow.
describe('login', () => {
  it('password -> TOTP -> /me', async () => {
    const u = await enrolledUser();
    const agent = await login(u);
    const me = await agent.get('/api/auth/me').expect(200);
    expect(me.body).toMatchObject({
      user: { id: u.user.id, email: u.user.email, name: 'Enrolled', isAdmin: false },
      mfa: { totp: true, passkeys: 0, recoveryCodesLeft: 10 },
      mfaEnrollmentRequired: false,
    });
    expect(Date.parse(me.body.mfaAt)).toBeGreaterThan(Date.now() - 60_000);
    expect(Date.parse(me.body.loginAt)).toBeGreaterThan(Date.now() - 60_000);
  });

  it('pending session (password only) cannot reach /me or other APIs', async () => {
    const u = await enrolledUser();
    const agent = await anon();
    await passwordStep(agent, u.user.email).expect(200);
    await refreshCsrf(agent);
    await agent.get('/api/auth/me').expect(401);
    await agent.get('/api/users/directory?q=en').expect(401);
  });

  it('is case-insensitive on email', async () => {
    const u = await enrolledUser();
    const agent = await anon();
    await passwordStep(agent, u.user.email.toUpperCase()).expect(200);
  });

  it('wrong password and unknown email give the same generic 401', async () => {
    const u = await enrolledUser();
    const agent = await anon();
    const a = await passwordStep(agent, u.user.email, 'not the right password at all').expect(401);
    const b = await passwordStep(agent, 'nobody-here@test.local').expect(401);
    expect(a.body).toEqual(b.body);
    expect(a.body.error.code).toBe('invalid_credentials');
  });

  it('rejects a disabled user with the generic 401 even with the right password', async () => {
    const u = await enrolledUser();
    await h.db.user.update({ where: { id: u.user.id }, data: { status: 'disabled' } });
    const res = await passwordStep(await anon(), u.user.email).expect(401);
    expect(res.body.error.code).toBe('invalid_credentials');
  });

  it('a user with no factor lands in enrollment mode', async () => {
    const user = await h.db.user.create({ data: { email: email(), name: 'NoMfa', passwordHash, status: 'active' } });
    const agent = await anon();
    const res = await passwordStep(agent, user.email).expect(200);
    expect(res.body).toEqual({ mfaEnrollmentRequired: true });
    await refreshCsrf(agent);
    expect((await agent.get('/api/auth/me').expect(200)).body.mfaEnrollmentRequired).toBe(true);
  });

  it('requires a CSRF token on login', async () => {
    await h.request().post('/api/auth/login').send({ email: 'x@test.local', password: PASSWORD }).expect(403);
  });
});

// Account lockout after repeated failures.
describe('lockout', () => {
  it(`locks after ${MAX_FAILURES} failures with no password oracle while locked`, async () => {
    const u = await enrolledUser();
    const agent = await anon();
    for (let i = 1; i <= MAX_FAILURES; i++) await passwordStep(agent, u.user.email, 'wrong wrong wrong').expect(401);
    // While locked, right and wrong passwords must be indistinguishable (else guessing continues past the lock).
    const wrong = await passwordStep(agent, u.user.email, 'wrong wrong wrong').expect(401);
    const right = await passwordStep(agent, u.user.email).expect(401);
    expect(right.body).toEqual(wrong.body);
    expect(right.body.error.code).toBe('invalid_credentials');
    const row = await h.db.user.findUniqueOrThrow({ where: { id: u.user.id } });
    expect(row.lockedUntil!.getTime()).toBeGreaterThan(Date.now());

    // Lock expiry lets the user back in.
    await h.db.user.update({ where: { id: u.user.id }, data: { lockedUntil: new Date(Date.now() - 1000) } });
    await passwordStep(agent, u.user.email).expect(200);
  });

  it('resets the failure counter after a successful login', async () => {
    const u = await enrolledUser();
    const agent = await anon();
    for (let i = 1; i < MAX_FAILURES; i++) await passwordStep(agent, u.user.email, 'wrong wrong wrong').expect(401);
    expect(await failures(u.user.id)).toBe(MAX_FAILURES - 1);
    await login(u);
    expect(await failures(u.user.id)).toBe(0);
  });

  it('failed second factors count towards lockout', async () => {
    const u = await enrolledUser();
    const agent = await anon();
    await passwordStep(agent, u.user.email).expect(200);
    await refreshCsrf(agent);
    for (let i = 1; i < MAX_FAILURES; i++) {
      const r = await agent.post('/api/auth/mfa/totp').send({ code: '000000' }).expect(401);
      expect(r.body.error.code).toBe('invalid_code');
    }
    await agent.post('/api/auth/mfa/totp').send({ code: '000000' }).expect(423);
    // The pending session is gone after locking.
    await refreshCsrf(agent);
    const gone = await agent.post('/api/auth/mfa/totp').send({ code: await freshCode(u.user.id, u.secret) }).expect(401);
    expect(gone.body.error.code).toBe('unauthenticated');
    // And a fresh password attempt is refused while locked.
    await passwordStep(agent, u.user.email).expect(401);
  });
});

// TOTP, recovery codes and passkeys.
describe('second factors', () => {
  it('rejects a replayed TOTP code', async () => {
    const u = await enrolledUser();
    const code = await freshCode(u.user.id, u.secret);

    const a1 = await anon();
    await passwordStep(a1, u.user.email).expect(200);
    await refreshCsrf(a1);
    await a1.post('/api/auth/mfa/totp').send({ code }).expect(200);

    const a2 = await anon();
    await passwordStep(a2, u.user.email).expect(200);
    await refreshCsrf(a2);
    const replay = await a2.post('/api/auth/mfa/totp').send({ code }).expect(401);
    // Distinct from a wrong code, so the UI can say "wait for the next one".
    expect(replay.body.error.code).toBe('code_already_used');
  });

  it('accepts a TOTP code pasted with a space or dash', async () => {
    const u = await enrolledUser();
    const code = await freshCode(u.user.id, u.secret);
    const agent = await anon();
    await passwordStep(agent, u.user.email).expect(200);
    await refreshCsrf(agent);
    await agent.post('/api/auth/mfa/totp').send({ code: `${code.slice(0, 3)} ${code.slice(3)}` }).expect(200);
  });

  it('a recovery code works exactly once', async () => {
    const u = await enrolledUser();
    const code = u.recoveryCodes[0]!;

    const a1 = await anon();
    await passwordStep(a1, u.user.email).expect(200);
    await refreshCsrf(a1);
    const ok = await a1.post('/api/auth/mfa/recovery').send({ code: code.toUpperCase() }).expect(200);
    expect(ok.body.remainingCodes).toBe(9);
    await refreshCsrf(a1);
    expect((await a1.get('/api/auth/me').expect(200)).body.mfa.recoveryCodesLeft).toBe(9);

    const a2 = await anon();
    await passwordStep(a2, u.user.email).expect(200);
    await refreshCsrf(a2);
    await a2.post('/api/auth/mfa/recovery').send({ code }).expect(401);
  });

  it('passkey authentication options store a challenge in the pending session', async () => {
    const u = await enrolledUser();
    const agent = await anon();
    await passwordStep(agent, u.user.email).expect(200);
    await refreshCsrf(agent);
    const opts = await agent.post('/api/auth/mfa/passkey/options').send({}).expect(200);
    expect(opts.body.challenge).toEqual(expect.any(String));
    expect(opts.body.rpId).toBe('localhost');
    expect(await sessionWithChallenge(opts.body.challenge)).toBe(true);

    // A bogus assertion fails (and the challenge is single use).
    const bogus = { id: 'abc', rawId: 'abc', type: 'public-key', response: { clientDataJSON: 'e30' }, clientExtensionResults: {} };
    await agent.post('/api/auth/mfa/passkey/verify').send(bogus).expect(401);
    expect(await sessionWithChallenge(opts.body.challenge)).toBe(false);
  });

  it('passkey registration options store a challenge; a bogus attestation is rejected', async () => {
    const u = await enrolledUser();
    const agent = await h.agentFor(u.user);
    const opts = await agent.post('/api/auth/mfa/passkey/register/options').send({}).expect(200);
    expect(opts.body.challenge).toEqual(expect.any(String));
    expect(opts.body.rp).toMatchObject({ id: 'localhost', name: 'Key Vault Test' });
    expect(await sessionWithChallenge(opts.body.challenge)).toBe(true);
    const bogus = { id: 'abc', rawId: 'abc', type: 'public-key', response: { clientDataJSON: 'e30' }, clientExtensionResults: {} };
    const res = await agent.post('/api/auth/mfa/passkey/register/verify').send({ response: bogus }).expect(400);
    expect(res.body.error.code).toBe('invalid_passkey');
    expect((await agent.get('/api/auth/mfa/passkeys').expect(200)).body.passkeys).toEqual([]);
  });

  it('adding a passkey outside enrollment requires recent MFA', async () => {
    const u = await enrolledUser();
    const agent = await h.agentFor(u.user, { mfaAgoMs: 10 * 60_000 });
    const res = await agent.post('/api/auth/mfa/passkey/register/options').send({}).expect(401);
    expect(res.body.error.code).toBe('reauth_required');
  });
});

async function sessionWithChallenge(challenge: string): Promise<boolean> {
  const rows = await h.db.session.findMany();
  return rows.some((r) => (r.sess as { webauthnChallenge?: { challenge: string } }).webauthnChallenge?.challenge === challenge);
}

// Invite links and first-time MFA setup.
describe('invites and enrollment', () => {
  it('admin invite -> GET -> accept -> enrollment mode -> TOTP enroll -> normal access', async () => {
    const admin = await h.createUser({ isAdmin: true });
    const adminAgent = await h.agentFor(admin);
    const mail = email();
    const created = await adminAgent.post('/api/invites').send({ email: mail.toUpperCase(), name: 'Newbie' }).expect(201);
    expect(created.body.inviteUrl).toMatch(/^http:\/\/localhost:8200\/invite\/[A-Za-z0-9_-]+$/);
    expect(Date.parse(created.body.expiresAt) - Date.now()).toBeGreaterThan(23 * 3600_000);
    const token = created.body.inviteUrl.split('/invite/')[1] as string;

    const agent = await anon();
    expect((await agent.get(`/api/invites/${token}`).expect(200)).body).toEqual({ email: mail, name: 'Newbie' });

    const weak = await agent.post(`/api/invites/${token}/accept`).send({ password: 'password123' }).expect(400);
    expect(weak.body.error.code).toBe('weak_password');
    const withLocal = await agent.post(`/api/invites/${token}/accept`).send({ password: `${mail.split('@')[0]} is my pass` }).expect(400);
    expect(withLocal.body.error.code).toBe('weak_password');

    const accepted = await agent.post(`/api/invites/${token}/accept`).send({ password: PASSWORD }).expect(200);
    expect(accepted.body).toEqual({ mfaEnrollmentRequired: true });
    await refreshCsrf(agent);

    // Enrollment mode: /me and /mfa/* work, everything else is blocked.
    const me = await agent.get('/api/auth/me').expect(200);
    expect(me.body).toMatchObject({ mfaEnrollmentRequired: true, mfa: { totp: false, passkeys: 0, recoveryCodesLeft: 0 } });
    expect((await agent.get('/api/projects').expect(403)).body.error.code).toBe('mfa_enrollment_required');
    expect((await agent.get('/api/users/directory?q=ne').expect(403)).body.error.code).toBe('mfa_enrollment_required');

    const enroll = await agent.post('/api/auth/mfa/totp/enroll').send({}).expect(200);
    expect(enroll.body.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
    expect(enroll.body.qrDataUrl).toMatch(/^data:image\/png;base64,/);
    const secret = enroll.body.secret as string;
    await agent.post('/api/auth/mfa/totp/confirm').send({ code: '000000' }).expect(400);
    const confirm = await agent.post('/api/auth/mfa/totp/confirm').send({ code: await currentTotpCode(secret) }).expect(200);
    // Leaving enrollment is a privilege change: the session id must rotate.
    const sid = (r: { headers: Record<string, unknown> }) =>
      /kv\.sid=([^;]+)/.exec(String(r.headers['set-cookie'] ?? ''))?.[1];
    expect(sid(enroll)).toBeTruthy();
    expect(sid(confirm)).toBeTruthy();
    expect(sid(confirm)).not.toBe(sid(enroll));
    await refreshCsrf(agent);
    expect(confirm.body.recoveryCodes).toHaveLength(10);
    for (const c of confirm.body.recoveryCodes) expect(c).toMatch(/^[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/);

    // Normal access now.
    expect((await agent.get('/api/auth/me').expect(200)).body).toMatchObject({ mfaEnrollmentRequired: false, mfa: { totp: true } });
    await agent.get('/api/users/directory?q=ne').expect(200);
    await agent.post('/api/auth/mfa/totp/enroll').send({}).expect(409);

    const user = await h.db.user.findUniqueOrThrow({ where: { email: mail } });
    expect(user.status).toBe('active');

    // Used token is dead.
    await agent.get(`/api/invites/${token}`).expect(404);
    await (await anon()).post(`/api/invites/${token}/accept`).send({ password: PASSWORD }).expect(404);

    // And the new user can log in with the enrolled TOTP.
    await login({ user, secret });
  });

  it('expired and unknown invite tokens 404', async () => {
    const admin = await h.createUser({ isAdmin: true });
    const adminAgent = await h.agentFor(admin);
    const mail = email();
    const created = await adminAgent.post('/api/invites').send({ email: mail, name: 'Late' }).expect(201);
    const token = created.body.inviteUrl.split('/invite/')[1] as string;
    const user = await h.db.user.findUniqueOrThrow({ where: { email: mail } });
    await h.db.invite.updateMany({ where: { userId: user.id }, data: { expiresAt: new Date(Date.now() - 1000) } });

    const agent = await anon();
    await agent.get(`/api/invites/${token}`).expect(404);
    await agent.post(`/api/invites/${token}/accept`).send({ password: PASSWORD }).expect(404);
    await agent.get(`/api/invites/${'x'.repeat(43)}`).expect(404);
  });

  it('re-inviting revokes the earlier link; inviting an active user is 409', async () => {
    const admin = await h.createUser({ isAdmin: true });
    const adminAgent = await h.agentFor(admin);
    const mail = email();
    const first = await adminAgent.post('/api/invites').send({ email: mail, name: 'Twice' }).expect(201);
    const second = await adminAgent.post('/api/invites').send({ email: mail, name: 'Twice' }).expect(201);
    const agent = await anon();
    await agent.get(`/api/invites/${first.body.inviteUrl.split('/invite/')[1]}`).expect(404);
    await agent.get(`/api/invites/${second.body.inviteUrl.split('/invite/')[1]}`).expect(200);

    const active = await h.createUser({ email: email() });
    expect((await adminAgent.post('/api/invites').send({ email: active.email, name: 'X' }).expect(409)).body.error.code).toBe('user_exists');
  });

  it('only admins can invite; inviting an admin needs recent MFA', async () => {
    const user = await h.createUser();
    await (await h.agentFor(user)).post('/api/invites').send({ email: email(), name: 'Nope' }).expect(403);

    const admin = await h.createUser({ isAdmin: true });
    const stale = await h.agentFor(admin, { mfaAgoMs: 10 * 60_000 });
    await stale.post('/api/invites').send({ email: email(), name: 'Plain' }).expect(201);
    const r = await stale.post('/api/invites').send({ email: email(), name: 'Boss', isAdmin: true }).expect(401);
    expect(r.body.error.code).toBe('reauth_required');
  });
});

// Step-up authentication for sensitive actions.
describe('re-auth and recent MFA', () => {
  it('reauth with TOTP refreshes mfaAt and unlocks requireRecentMfa routes', async () => {
    const u = await enrolledUser({ isAdmin: true });
    const target = await h.createUser();
    const agent = await h.agentFor(u.user, { mfaAgoMs: 10 * 60_000 });
    const before = Date.parse((await agent.get('/api/auth/me').expect(200)).body.mfaAt);

    const blocked = await agent.patch(`/api/admin/users/${target.id}`).send({ isAdmin: true }).expect(401);
    expect(blocked.body.error.code).toBe('reauth_required');

    await agent.post('/api/auth/reauth').send({ code: '000000' }).expect(401);
    const re = await agent.post('/api/auth/reauth').send({ code: await freshCode(u.user.id, u.secret) }).expect(200);
    expect(re.body.ok).toBe(true);
    const mfaAt = Date.parse(re.body.mfaAt);
    expect(mfaAt).toBeGreaterThan(before);
    await refreshCsrf(agent);
    expect(Date.parse((await agent.get('/api/auth/me').expect(200)).body.mfaAt)).toBe(mfaAt);

    const ok = await agent.patch(`/api/admin/users/${target.id}`).send({ isAdmin: true }).expect(200);
    expect(ok.body.user).toMatchObject({ id: target.id, isAdmin: true });
  });

  it('reauth requires a logged-in session', async () => {
    await (await anon()).post('/api/auth/reauth').send({ code: '123456' }).expect(401);
  });
});

// Admin user management.
describe('admin', () => {
  it('non-admins get 403 on /api/admin/users', async () => {
    const user = await h.createUser();
    const res = await (await h.agentFor(user)).get('/api/admin/users').expect(403);
    expect(res.body.error.code).toBe('forbidden');
  });

  it('admins list users without secrets or hashes', async () => {
    const admin = await h.createUser({ isAdmin: true });
    const res = await (await h.agentFor(admin)).get('/api/admin/users').expect(200);
    const me = res.body.users.find((x: { id: string }) => x.id === admin.id);
    expect(me).toMatchObject({ email: admin.email, isAdmin: true, status: 'active' });
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|argon2/);
  });

  it('an admin cannot demote or disable themselves', async () => {
    const admin = await h.createUser({ isAdmin: true });
    const agent = await h.agentFor(admin);
    expect((await agent.patch(`/api/admin/users/${admin.id}`).send({ status: 'disabled' }).expect(409)).body.error.code).toBe(
      'cannot_modify_self',
    );
    await agent.patch(`/api/admin/users/${admin.id}`).send({ isAdmin: false }).expect(409);
  });

  it('disabling a user kills their sessions; unlock clears lockout', async () => {
    const admin = await h.createUser({ isAdmin: true });
    const adminAgent = await h.agentFor(admin);
    const u = await enrolledUser();
    const victim = await login(u);
    await victim.get('/api/auth/me').expect(200);

    await adminAgent.patch(`/api/admin/users/${u.user.id}`).send({ status: 'disabled' }).expect(200);
    await victim.get('/api/auth/me').expect(401);
    await passwordStep(await anon(), u.user.email).expect(401);

    await adminAgent.patch(`/api/admin/users/${u.user.id}`).send({ status: 'active' }).expect(200);
    await h.db.user.update({ where: { id: u.user.id }, data: { lockedUntil: new Date(Date.now() + 60_000), failedLogins: 3 } });
    await passwordStep(await anon(), u.user.email).expect(401);
    await adminAgent.patch(`/api/admin/users/${u.user.id}`).send({ unlock: true }).expect(200);
    await passwordStep(await anon(), u.user.email).expect(200);
  });

  it('an invited user cannot be activated by an admin', async () => {
    const admin = await h.createUser({ isAdmin: true });
    const invited = await h.db.user.create({ data: { email: email(), name: 'Inv', status: 'invited' } });
    const res = await (await h.agentFor(admin)).patch(`/api/admin/users/${invited.id}`).send({ status: 'active' }).expect(409);
    expect(res.body.error.code).toBe('user_invited');
  });
});

// Ending one or all sessions.
describe('logout', () => {
  it('logout ends the session', async () => {
    const u = await enrolledUser();
    const agent = await login(u);
    await agent.post('/api/auth/logout').send({}).expect(200);
    await agent.get('/api/auth/me').expect(401);
  });

  it('logout-all kills every session of the user, not others', async () => {
    const u = await enrolledUser();
    const other = await enrolledUser();
    const a1 = await login(u);
    const a2 = await h.agentFor(u.user);
    const bystander = await login(other);
    await a1.post('/api/auth/logout-all').send({}).expect(200);
    await a1.get('/api/auth/me').expect(401);
    await a2.get('/api/auth/me').expect(401);
    await bystander.get('/api/auth/me').expect(200);
  });
});

// Passkey challenges are single-use, purpose-bound and short-lived.
describe('webauthn challenge binding', () => {
  const bogus = { id: 'abc', rawId: 'abc', type: 'public-key', response: { clientDataJSON: 'e30' }, clientExtensionResults: {} };
  const registerVerify = (agent: TestAgent) =>
    agent.post('/api/auth/mfa/passkey/register/verify').send({ response: bogus }).expect(400);

  it('a challenge issued for one purpose cannot be used for another', async () => {
    const u = await enrolledUser();
    const agent = await h.agentFor(u.user);
    await agent.post('/api/auth/reauth/passkey/options').send({}).expect(200);
    expect((await registerVerify(agent)).body.error.message).toBe('No registration in progress');
  });

  it('a stale challenge is rejected server-side', async () => {
    const u = await enrolledUser();
    const agent = await h.agentFor(u.user);
    const opts = await agent.post('/api/auth/mfa/passkey/register/options').send({}).expect(200);
    await h.db.$executeRaw`UPDATE "session" SET sess = jsonb_set(sess, '{webauthnChallenge,at}', '0'::jsonb)
      WHERE sess->'webauthnChallenge'->>'challenge' = ${opts.body.challenge}`;
    expect((await registerVerify(agent)).body.error.message).toBe('No registration in progress');
    expect(await sessionWithChallenge(opts.body.challenge)).toBe(false);
  });

  it('a fresh challenge for the right purpose reaches verification', async () => {
    const u = await enrolledUser();
    const agent = await h.agentFor(u.user);
    await agent.post('/api/auth/mfa/passkey/register/options').send({}).expect(200);
    expect((await registerVerify(agent)).body.error.message).toBe('Passkey registration failed');
  });
});

describe('recovery codes on adding a factor', () => {
  it('adding TOTP keeps an existing recovery-code set', async () => {
    const user = await h.db.user.create({ data: { email: email(), name: 'Pk', passwordHash, status: 'active' } });
    await h.db.passkey.create({
      data: { userId: user.id, credentialId: randomUUID(), publicKey: Buffer.from('x'), counter: 0n, transports: [], name: 'k' },
    });
    const codes = await regenerateRecoveryCodes(h.db, user.id);
    const agent = await h.agentFor(user);
    const enroll = await agent.post('/api/auth/mfa/totp/enroll').send({}).expect(200);
    const confirm = await agent.post('/api/auth/mfa/totp/confirm').send({ code: await currentTotpCode(enroll.body.secret) }).expect(200);
    expect(confirm.body.recoveryCodes).toBeUndefined();
    // The old codes still work.
    const a2 = await anon();
    await passwordStep(a2, user.email).expect(200);
    await refreshCsrf(a2);
    await a2.post('/api/auth/mfa/recovery').send({ code: codes[0] }).expect(200);
  });
});

describe('admin and invite races', () => {
  it('two admins demoting each other at once leave at least one admin', async () => {
    const a = await h.createUser({ isAdmin: true });
    const b = await h.createUser({ isAdmin: true });
    // Only these two may count as active admins for this test to be meaningful.
    await h.db.user.updateMany({ where: { isAdmin: true, id: { notIn: [a.id, b.id] } }, data: { isAdmin: false } });
    const [asA, asB] = [await h.agentFor(a), await h.agentFor(b)];
    const results = await Promise.all([
      asA.patch(`/api/admin/users/${b.id}`).send({ isAdmin: false }),
      asB.patch(`/api/admin/users/${a.id}`).send({ isAdmin: false }),
    ]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    // The loser is refused by the guard (409), or by requireAuth (403) if it arrived after the demotion.
    expect([403, 409]).toContain(results.find((r) => r.status !== 200)?.status);
    expect(await h.db.user.count({ where: { isAdmin: true, status: 'active' } })).toBe(1);
  });

  it('concurrent invites for the same new email never 500', async () => {
    const admin = await h.createUser({ isAdmin: true });
    const agent = await h.agentFor(admin);
    const mail = email();
    const results = await Promise.all(
      Array.from({ length: 4 }, () => agent.post('/api/invites').send({ email: mail, name: 'Racer' })),
    );
    for (const r of results) expect([201, 409]).toContain(r.status);
    expect(results.some((r) => r.status === 201)).toBe(true);
  });
});

describe('authenticator setup', () => {
  it('reopening setup shows the same unconfirmed seed', async () => {
    const user = await h.createUser();
    const agent = await h.agentFor(user);
    const first = await agent.post('/api/auth/mfa/totp/enroll').send({}).expect(200);
    const again = await agent.post('/api/auth/mfa/totp/enroll').send({}).expect(200);
    expect(again.body.secret).toBe(first.body.secret);
  });

  it('an old unconfirmed seed is replaced', async () => {
    const user = await h.createUser();
    const agent = await h.agentFor(user);
    const first = await agent.post('/api/auth/mfa/totp/enroll').send({}).expect(200);
    await h.db.totpSecret.update({ where: { userId: user.id }, data: { createdAt: new Date(Date.now() - 60 * 60_000) } });
    const again = await agent.post('/api/auth/mfa/totp/enroll').send({}).expect(200);
    expect(again.body.secret).not.toBe(first.body.secret);
  });
});
