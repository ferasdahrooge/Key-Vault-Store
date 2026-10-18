import { createHash, randomUUID } from 'node:crypto';
import supertest from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { GOOGLE_TOKEN_URL } from '../../src/features/auth/google.js';
import { regenerateRecoveryCodes } from '../../src/features/auth/recovery.js';
import { currentTotpCode, newTotpSecret, storeUnconfirmedTotp } from '../../src/features/auth/totp.js';
import { setupTestApp, TEST_GOOGLE_CLIENT_ID, type TestAgent, type TestHarness } from '../helpers/app.js';

let h: TestHarness;
beforeAll(async () => {
  h = await setupTestApp({ google: true });
});
afterAll(() => h?.teardown());
afterEach(() => vi.restoreAllMocks());

// ------------------------------------------------------------------ helpers

const email = () => `g-${randomUUID().slice(0, 8)}@test.local`;
const sub = () => String(Math.floor(Math.random() * 1e15));

async function refreshCsrf(agent: TestAgent): Promise<TestAgent> {
  agent.csrf = (await agent.get('/api/csrf').expect(200)).body.token as string;
  agent.set('x-csrf-token', agent.csrf);
  return agent;
}
const anon = () => refreshCsrf(supertest.agent(h.app) as TestAgent);

async function enrolledUser(data: { email?: string; googleSub?: string; status?: 'active' | 'disabled' } = {}) {
  const user = await h.db.user.create({
    data: { email: data.email ?? email(), name: 'G', status: data.status ?? 'active', googleSub: data.googleSub },
  });
  const secret = newTotpSecret();
  await storeUnconfirmedTotp(h.db, user.id, secret);
  await h.db.totpSecret.update({ where: { userId: user.id }, data: { confirmed: true } });
  await regenerateRecoveryCodes(h.db, user.id);
  return { user, secret };
}

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const idToken = (claims: Record<string, unknown>) => `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(claims)}.sig`;

/** Starts a flow and returns what Google would see in the authorization URL. */
async function start(agent: TestAgent, next?: string) {
  const r = await agent.post('/api/auth/google/start').send(next ? { next } : {}).expect(200);
  const url = new URL(r.body.url as string);
  expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
  const p = url.searchParams;
  return { state: p.get('state')!, nonce: p.get('nonce')!, challenge: p.get('code_challenge')!, params: p };
}

/**
 * Stubs Google's token endpoint once. The ID token carries the given claims on top of valid
 * defaults (the nonce must be passed in, from start()). Returns the captured token request.
 */
function googleReturns(claims: Record<string, unknown>, status = 200) {
  const seen: { body?: URLSearchParams } = {};
  vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async (input, init) => {
    expect(String(input)).toBe(GOOGLE_TOKEN_URL);
    seen.body = new URLSearchParams(String(init?.body));
    const token = idToken({
      iss: 'https://accounts.google.com',
      aud: TEST_GOOGLE_CLIENT_ID,
      exp: Math.floor(Date.now() / 1000) + 300,
      email_verified: true,
      ...claims,
    });
    return new Response(JSON.stringify(status === 200 ? { id_token: token } : { error: 'invalid_grant' }), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  });
  return seen;
}

/** Google step for `who`; returns the agent (CSRF refreshed) and the callback response. */
async function googleStep(who: { email: string; sub: string }, opts: { next?: string; claims?: Record<string, unknown> } = {}) {
  const agent = await anon();
  const s = await start(agent, opts.next);
  const seen = googleReturns({ sub: who.sub, email: who.email, nonce: s.nonce, ...opts.claims });
  const res = await agent.post('/api/auth/google/callback').send({ code: 'auth-code', state: s.state });
  await refreshCsrf(agent);
  return { agent, res, seen, s };
}

const googleSubOf = (id: string) => h.db.user.findUniqueOrThrow({ where: { id } }).then((u) => u.googleSub);
const auditActions = async (userId: string) =>
  (await h.db.auditLog.findMany({ where: { actorId: userId }, orderBy: { seq: 'asc' } })).map((a) => a.action);

// ------------------------------------------------------------------ tests

// Google OAuth flow with a stubbed token endpoint.
describe('Google sign-in', () => {
  it('advertises the provider', async () => {
    const r = await h.request().get('/api/auth/providers').expect(200);
    expect(r.body).toEqual({ google: true });
  });

  it('sends PKCE, state and nonce, and redeems the code with the matching verifier', async () => {
    const { user } = await enrolledUser();
    const { res, seen, s } = await googleStep({ email: user.email, sub: sub() });
    expect(res.status).toBe(200);
    expect(s.params.get('client_id')).toBe(TEST_GOOGLE_CLIENT_ID);
    expect(s.params.get('redirect_uri')).toBe('http://localhost:8200/login/google/callback');
    expect(s.params.get('scope')).toBe('openid email');
    expect(s.params.get('code_challenge_method')).toBe('S256');
    const verifier = seen.body!.get('code_verifier')!;
    expect(createHash('sha256').update(verifier).digest('base64url')).toBe(s.challenge);
    expect(seen.body!.get('code')).toBe('auth-code');
    expect(seen.body!.get('redirect_uri')).toBe('http://localhost:8200/login/google/callback');
  });

  it('matches by verified email, still requires MFA, and links the Google account only after MFA', async () => {
    const u = await enrolledUser();
    const gsub = sub();
    const { agent, res } = await googleStep({ email: u.user.email.toUpperCase(), sub: gsub }, { next: '/p/app/prod' });
    expect(res.body).toEqual({ mfaRequired: true, methods: ['totp', 'recovery'], next: '/p/app/prod' });
    await agent.get('/api/auth/me').expect(401); // pending, not logged in
    expect(await googleSubOf(u.user.id)).toBeNull();

    await agent.post('/api/auth/mfa/totp').send({ code: await currentTotpCode(u.secret) }).expect(200);
    expect(await googleSubOf(u.user.id)).toBe(gsub);
    const me = await (await refreshCsrf(agent)).get('/api/auth/me').expect(200);
    expect(me.body.googleLinked).toBe(true);
    expect(await auditActions(u.user.id)).toEqual(
      expect.arrayContaining(['auth.login.success', 'auth.mfa.success', 'auth.google.linked']),
    );
  });

  it('once linked, matches by sub even if the Google email changed', async () => {
    const gsub = sub();
    const u = await enrolledUser({ googleSub: gsub });
    const { res } = await googleStep({ email: 'renamed@elsewhere.example', sub: gsub });
    expect(res.status).toBe(200);
    expect(res.body.mfaRequired).toBe(true);
  });

  it('refuses unknown users, users linked to another Google account and disabled users, generically', async () => {
    const r1 = await googleStep({ email: email(), sub: sub() });
    expect(r1.res.status).toBe(401);
    expect(r1.res.body.error.code).toBe('google_login_failed');

    const linked = await enrolledUser({ googleSub: sub() });
    const r2 = await googleStep({ email: linked.user.email, sub: sub() });
    expect(r2.res.status).toBe(401);
    expect(r2.res.body.error.code).toBe('google_login_failed');

    const disabled = await enrolledUser({ status: 'disabled' });
    const r3 = await googleStep({ email: disabled.user.email, sub: sub() });
    expect(r3.res.status).toBe(401);
    expect(r3.res.body.error.code).toBe('google_login_failed');
  });

  it('refuses locked accounts', async () => {
    const u = await enrolledUser();
    await h.db.user.update({ where: { id: u.user.id }, data: { lockedUntil: new Date(Date.now() + 60_000) } });
    const { res } = await googleStep({ email: u.user.email, sub: sub() });
    expect(res.status).toBe(401);
    expect(await auditActions(u.user.id)).toContain('auth.login.locked');
  });

  it('refuses bad ID tokens and failed code exchanges', async () => {
    const u = await enrolledUser();
    for (const claims of [{ nonce: 'wrong' }, { email_verified: false }, { aud: 'x.apps.googleusercontent.com' }, { iss: 'https://evil' }]) {
      const { res } = await googleStep({ email: u.user.email, sub: sub() }, { claims });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('google_login_failed');
    }

    const agent = await anon();
    const s = await start(agent);
    googleReturns({}, 400);
    const r = await agent.post('/api/auth/google/callback').send({ code: 'bad', state: s.state });
    expect(r.status).toBe(401);
    expect(await googleSubOf(u.user.id)).toBeNull();
  });

  it('rejects a wrong or replayed state without calling Google', async () => {
    const agent = await anon();
    const s = await start(agent);
    const spy = vi.spyOn(globalThis, 'fetch');
    const bad = await agent.post('/api/auth/google/callback').send({ code: 'c', state: 'not-the-state' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('google_flow_expired');
    // The failed attempt consumed the flow, so even the right state is now refused.
    const replay = await agent.post('/api/auth/google/callback').send({ code: 'c', state: s.state });
    expect(replay.status).toBe(400);
    // A callback from a browser that never started the flow is refused too.
    const other = await anon();
    expect((await other.post('/api/auth/google/callback').send({ code: 'c', state: s.state })).status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });

  it('sends a user with no MFA factor to enrollment and links after enrollment completes', async () => {
    const user = await h.db.user.create({ data: { email: email(), name: 'New', status: 'active' } });
    const gsub = sub();
    const { agent, res } = await googleStep({ email: user.email, sub: gsub });
    expect(res.body).toEqual({ mfaEnrollmentRequired: true });
    expect(await googleSubOf(user.id)).toBeNull();

    const enroll = await agent.post('/api/auth/mfa/totp/enroll').expect(200);
    await agent.post('/api/auth/mfa/totp/confirm').send({ code: await currentTotpCode(enroll.body.secret) }).expect(200);
    expect(await googleSubOf(user.id)).toBe(gsub);
  });

  it('unlinks with recent MFA', async () => {
    const u = await enrolledUser({ googleSub: sub() });
    const stale = await h.agentFor(u.user, { mfaAgoMs: 60 * 60 * 1000 });
    await stale.delete('/api/auth/google').expect(401);
    const fresh = await h.agentFor(u.user);
    await fresh.delete('/api/auth/google').expect(200);
    expect(await googleSubOf(u.user.id)).toBeNull();
    expect(await auditActions(u.user.id)).toContain('auth.google.unlinked');
  });
});

// Without OAuth credentials, Google endpoints are off.
describe('Google sign-in when not configured', () => {
  let plain: TestHarness;
  beforeAll(async () => {
    plain = await setupTestApp();
  });
  afterAll(() => plain?.teardown());

  it('hides the provider and refuses the endpoints', async () => {
    expect((await plain.request().get('/api/auth/providers').expect(200)).body).toEqual({ google: false });
    const agent = supertest.agent(plain.app) as TestAgent;
    const csrf = (await agent.get('/api/csrf').expect(200)).body.token as string;
    await agent.post('/api/auth/google/start').set('x-csrf-token', csrf).expect(404);
  });
});
