/**
 * /api/auth — password or Google login, MFA (TOTP / recovery code / passkey), enrollment, re-auth, logout.
 * See docs/API.md "Auth". Enrollment routes live under /mfa/... so requireAuth admits them while
 * session.mfaEnrollmentRequired is set; GET /me also works during enrollment (requireAuthOrEnrollment).
 */
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import { Router, type Request, type RequestHandler } from 'express';
import { z } from 'zod';
import {
  beginGoogleLogin,
  exchangeGoogleCode,
  findGoogleUser,
  GoogleLoginError,
  googleEnabled,
  linkPendingGoogle,
  takeGoogleFlow,
} from './google.js';
import { requireAuth, requireRecentMfa } from './auth.middleware.js';
import { isLocked, registerFailure, resetFailures } from './lockout.js';
import { dummyVerify, verifyPassword } from './password.js';
import { authLimiterFor } from './rateLimit.js';
import { consumeRecoveryCode, countRecoveryCodes, regenerateRecoveryCodes } from './recovery.js';
import {
  auditAuth,
  availableMethods,
  destroySession,
  issueChallenge,
  publicUser,
  refreshMfa,
  requireAuthOrEnrollment,
  requirePending,
  startEnrollment,
  startFullSession,
  startPending,
  takeChallenge,
} from './session.js';
import {
  newTotpSecret,
  recentUnconfirmedTotp,
  storeUnconfirmedTotp,
  totpEnrollmentPayload,
  verifyAndConsumeTotp,
  type TotpResult,
} from './totp.js';
import { authenticationOptions, registrationOptions, verifyAuthentication, verifyRegistration } from './webauthn.js';
import type { Db } from '../../core/db.js';
import { HttpError, notFound, parse } from '../../core/http.js';
import { auditFromReq } from '../audit/audit.service.js';
import type { AppDeps } from '../../core/types.js';

// Error responses shared by the auth endpoints (kept generic to avoid leaking info).
const invalidCredentials = () => new HttpError(401, 'invalid_credentials', 'Invalid email or password');
const accountLocked = () => new HttpError(423, 'account_locked', 'Account temporarily locked, try again later');
const invalidCode = () => new HttpError(401, 'invalid_code', 'Invalid or expired code');
const googleFailed = () =>
  new HttpError(401, 'google_login_failed', 'This Google account can’t be used to sign in to Key Vault');
const googleFlowExpired = () =>
  new HttpError(400, 'google_flow_expired', 'Google sign-in expired or was started elsewhere, try again');
const codeReused = (status = 401) =>
  new HttpError(status, 'code_already_used', 'That code was already used. Wait for the next one from your app.');
/** Error for a failed TOTP check: a reused code gets its own message, anything else is generic. */
const totpError = (r: TotpResult, status = 401) =>
  r === 'reused' ? codeReused(status) : status === 401 ? invalidCode() : new HttpError(status, 'invalid_code', 'Invalid code');

// Request body schemas.
const loginBody = z.object({ email: z.string().trim().min(3).max(254), password: z.string().min(1).max(1024) });
const googleStartBody = z.object({ next: z.string().max(2048).optional() });
const googleCallbackBody = z.object({ code: z.string().min(1).max(2048), state: z.string().min(1).max(256) });
const codeBody = z.object({ code: z.string().trim().min(6).max(32) });
// WebAuthn credential JSON from the browser, with size caps.
const credentialJson = z.looseObject({
  id: z.string().min(1).max(1024),
  rawId: z.string().min(1).max(1024),
  type: z.literal('public-key'),
  response: z.looseObject({ clientDataJSON: z.string().max(16_384) }),
  clientExtensionResults: z.looseObject({}).default({}),
});
const reauthBody = z.union([
  z.object({ code: z.string().trim().min(6).max(32) }),
  z.object({ passkey: credentialJson }),
]);
const registerVerifyBody = z.object({ response: credentialJson, name: z.string().trim().min(1).max(64).default('Passkey') });

// Builds the /api/auth router.
export function authRouter(deps: AppDeps): Router {
  const { db, config } = deps;
  const r = Router();
  const limiter = authLimiterFor(config);
  const auth = requireAuth(db);
  /** Enrollment mode may add its first factor freely; otherwise adding a factor needs recent MFA. */
  const enrollmentOrRecentMfa: RequestHandler = (req, res, next) =>
    req.session.mfaEnrollmentRequired ? next() : requireRecentMfa(req, res, next);

  // ---------------------------------------------------------------- login (password step)
  // POST /login — check email + password; next step is MFA or enrollment.
  r.post('/login', limiter, async (req, res) => {
    const { email, password } = parse(loginBody, req.body);
    const user = await db.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' } } });

    if (!user || !user.passwordHash) {
      await dummyVerify(password);
      await auditAuth(db, req, 'auth.login.failed', { userId: user?.id, meta: { reason: user ? 'no_password' : 'unknown_user' } });
      throw invalidCredentials();
    }
    // While locked the password is NOT checked: any response that depended on it would be a
    // password oracle that bypasses the lockout. Locked accounts get the same generic 401 as
    // every other failure (no enumeration either); dummyVerify keeps timing uniform.
    if (isLocked(user)) {
      await dummyVerify(password);
      await auditAuth(db, req, 'auth.login.locked', { userId: user.id });
      throw invalidCredentials();
    }
    // Check the password, then reject inactive users and count failures.
    const ok = await verifyPassword(user.passwordHash, password);
    if (user.status !== 'active') {
      await auditAuth(db, req, 'auth.login.failed', { userId: user.id, meta: { reason: user.status } });
      throw invalidCredentials();
    }
    if (!ok) {
      const locked = await registerFailure(db, user.id);
      if (locked) {
        await auditAuth(db, req, 'auth.login.locked', { userId: user.id });
        throw invalidCredentials();
      }
      await auditAuth(db, req, 'auth.login.failed', { userId: user.id, meta: { reason: 'bad_password' } });
      throw invalidCredentials();
    }

    res.json(await firstFactorDone(req, user.id, 'password'));
  });

  /**
   * First factor (password or Google) accepted: on to MFA, or to enrollment when the user has no
   * factor yet. A first Google login queues its sub to be linked once the login completes.
   */
  async function firstFactorDone(req: Request, userId: string, via: 'password' | 'google', googleLinkSub?: string) {
    const extra = via === 'google' ? { via } : {};
    const methods = await availableMethods(db, userId);
    if (methods.length === 0) {
      await resetFailures(db, userId);
      await startEnrollment(req, userId);
      if (googleLinkSub) req.session.googleLinkSub = googleLinkSub;
      await auditAuth(db, req, 'auth.login.success', { userId, meta: { stage: 'enrollment', ...extra } });
      return { mfaEnrollmentRequired: true as const };
    }
    await startPending(req, userId);
    if (googleLinkSub) req.session.googleLinkSub = googleLinkSub;
    await auditAuth(db, req, 'auth.login.success', { userId, meta: { stage: 'password', ...extra } });
    return { mfaRequired: true as const, methods };
  }

  // ---------------------------------------------------------------- login (Google, first step)
  // GET /providers — which optional sign-in methods are enabled.
  r.get('/providers', (_req, res) => {
    res.json({ google: googleEnabled(config) });
  });

  // POST /google/start — returns the Google URL to redirect the browser to.
  r.post('/google/start', limiter, async (req, res) => {
    if (!googleEnabled(config)) throw notFound();
    const { next } = parse(googleStartBody, req.body ?? {});
    res.json({ url: beginGoogleLogin(req, config, next) });
  });

  // POST /google/callback — finish Google sign-in and move on to MFA.
  r.post('/google/callback', limiter, async (req, res) => {
    if (!googleEnabled(config)) throw notFound();
    const { code, state } = parse(googleCallbackBody, req.body);
    const flow = takeGoogleFlow(req, state);
    if (!flow) throw googleFlowExpired();

    const fail = async (reason: string, userId?: string, action = 'auth.login.failed') => {
      await auditAuth(db, req, action, { userId, meta: { via: 'google', reason } });
      return googleFailed();
    };
    let identity;
    try {
      identity = await exchangeGoogleCode(config, code, flow);
    } catch (err) {
      if (err instanceof GoogleLoginError) throw await fail(err.reason);
      throw err;
    }
    const match = await findGoogleUser(db, identity);
    if (!match) throw await fail('no_matching_user');
    const { user, link } = match;
    if (user.status !== 'active') throw await fail(user.status, user.id);
    if (isLocked(user)) throw await fail('locked', user.id, 'auth.login.locked');

    const result = await firstFactorDone(req, user.id, 'google', link ? identity.sub : undefined);
    res.json({ ...result, ...(flow.next ? { next: flow.next } : {}) });
  });

  // ---------------------------------------------------------------- login (MFA step)
  /** Common tail for a failed second factor during login: count towards lockout. */
  async function mfaFailed(req: Request, userId: string, method: string, totp?: TotpResult): Promise<HttpError> {
    const locked = await registerFailure(db, userId);
    if (locked) {
      await destroySession(req);
      await auditAuth(db, req, 'auth.login.locked', { userId, meta: { method } });
      return accountLocked();
    }
    await auditAuth(db, req, 'auth.mfa.failed', { userId, meta: { method, ...(totp === 'reused' ? { reason: 'reused' } : {}) } });
    return totp ? totpError(totp) : invalidCode();
  }

  /** Loads the pending user and re-checks it is still allowed in. */
  async function pendingUser(req: Request) {
    const userId = await requirePending(req);
    const user = await db.user.findUnique({ where: { id: userId } });
    if (!user || user.status !== 'active') {
      await destroySession(req);
      throw invalidCredentials();
    }
    if (isLocked(user)) {
      await destroySession(req);
      throw accountLocked();
    }
    return user;
  }

  // Second factor passed: full session, reset failures, link Google if queued.
  async function completeLogin(req: Request, user: { id: string }, method: string) {
    const googleLinkSub = req.session.googleLinkSub;
    await resetFailures(db, user.id);
    await startFullSession(req, user.id);
    await auditAuth(db, req, 'auth.mfa.success', { userId: user.id, meta: { method } });
    await linkPendingGoogle(db, req, user.id, googleLinkSub);
  }

  // POST /mfa/totp — finish login with an authenticator-app code.
  r.post('/mfa/totp', limiter, async (req, res) => {
    const user = await pendingUser(req);
    const { code } = parse(codeBody, req.body);
    const result = await verifyAndConsumeTotp(db, user.id, code, true);
    if (result !== 'ok') throw await mfaFailed(req, user.id, 'totp', result);
    await completeLogin(req, user, 'totp');
    res.json({ user: publicUser(user) });
  });

  // POST /mfa/recovery — finish login with a one-time recovery code.
  r.post('/mfa/recovery', limiter, async (req, res) => {
    const user = await pendingUser(req);
    const { code } = parse(codeBody, req.body);
    const remaining = await consumeRecoveryCode(db, user.id, code);
    if (remaining === null) throw await mfaFailed(req, user.id, 'recovery');
    await auditAuth(db, req, 'auth.recovery_code_used', { userId: user.id, meta: { remainingCodes: remaining } });
    await completeLogin(req, user, 'recovery');
    res.json({ user: publicUser(user), remainingCodes: remaining });
  });

  // POST /mfa/passkey/options — challenge for a passkey login.
  r.post('/mfa/passkey/options', limiter, async (req, res) => {
    const user = await pendingUser(req);
    const options = await authenticationOptions(db, config, user.id);
    issueChallenge(req, 'login', options.challenge);
    res.json(options);
  });

  // POST /mfa/passkey/verify — finish login with a passkey.
  r.post('/mfa/passkey/verify', limiter, async (req, res) => {
    const user = await pendingUser(req);
    const response = parse(credentialJson, req.body) as unknown as AuthenticationResponseJSON;
    const challenge = await takeChallenge(db, req, 'login');
    const ok = challenge ? await verifyAuthentication(db, config, user.id, response, challenge) : null;
    if (!ok) throw await mfaFailed(req, user.id, 'passkey');
    await completeLogin(req, user, 'passkey');
    res.json({ user: publicUser(user) });
  });

  // ---------------------------------------------------------------- re-auth (step-up)
  // POST /reauth/passkey/options — challenge for a passkey re-auth.
  r.post('/reauth/passkey/options', auth, async (req, res) => {
    const options = await authenticationOptions(db, config, req.user!.id);
    issueChallenge(req, 'reauth', options.challenge);
    res.json(options);
  });

  // POST /reauth — confirm MFA again to unlock sensitive actions for a few minutes.
  r.post('/reauth', limiter, auth, async (req, res) => {
    const body = parse(reauthBody, req.body);
    const userId = req.user!.id;
    let ok: boolean;
    let method: string;
    let totp: TotpResult | undefined;
    if ('code' in body) {
      method = 'totp';
      totp = await verifyAndConsumeTotp(db, userId, body.code, true);
      ok = totp === 'ok';
    } else {
      method = 'passkey';
      const challenge = await takeChallenge(db, req, 'reauth');
      ok = !!challenge && !!(await verifyAuthentication(db, config, userId, body.passkey as unknown as AuthenticationResponseJSON, challenge));
    }
    if (!ok) {
      const locked = await registerFailure(db, userId);
      if (locked) {
        await destroySession(req);
        await auditFromReq(db, req, { action: 'auth.login.locked', meta: { method, stage: 'reauth' } });
        throw accountLocked();
      }
      await auditFromReq(db, req, { action: 'auth.mfa.failed', meta: { method, stage: 'reauth' } });
      throw totp ? totpError(totp) : invalidCode();
    }
    await resetFailures(db, userId);
    const mfaAt = await refreshMfa(req);
    await auditFromReq(db, req, { action: 'auth.reauth', meta: { method } });
    res.json({ ok: true, mfaAt: new Date(mfaAt).toISOString() });
  });

  // ---------------------------------------------------------------- session
  // POST /logout — end this session.
  r.post('/logout', async (req, res) => {
    const userId = req.session?.userId ?? req.session?.pendingUserId;
    await destroySession(req);
    if (userId) await auditAuth(db, req, 'auth.logout', { userId });
    res.clearCookie(config.sessionCookieName, { path: '/' });
    res.json({ ok: true });
  });

  // POST /logout-all — end every session of the current user.
  r.post('/logout-all', auth, async (req, res) => {
    const userId = req.user!.id;
    const n = await killUserSessions(db, userId);
    await destroySession(req);
    await auditFromReq(db, req, { action: 'auth.logout_all', meta: { sessions: n } });
    res.clearCookie(config.sessionCookieName, { path: '/' });
    res.json({ ok: true });
  });

  // GET /me — current user, MFA status and session timestamps.
  r.get('/me', requireAuthOrEnrollment(db), async (req, res) => {
    const u = req.user!;
    const [totp, passkeys, recoveryCodesLeft, google] = await Promise.all([
      db.totpSecret.findFirst({ where: { userId: u.id, confirmed: true }, select: { userId: true } }),
      db.passkey.count({ where: { userId: u.id } }),
      countRecoveryCodes(db, u.id),
      db.user.findUnique({ where: { id: u.id }, select: { googleSub: true } }),
    ]);
    const s = req.session;
    res.json({
      user: publicUser(u),
      mfa: { totp: !!totp, passkeys, recoveryCodesLeft },
      mfaAt: s.mfaAt ? new Date(s.mfaAt).toISOString() : null,
      loginAt: s.loginAt ? new Date(s.loginAt).toISOString() : null,
      mfaEnrollmentRequired: !!s.mfaEnrollmentRequired,
      googleLinked: !!google?.googleSub,
    });
  });

  /** Forgets the linked Google account; the next Google login re-links by verified email. */
  r.delete('/google', auth, requireRecentMfa, async (req, res) => {
    const { count } = await db.user.updateMany({ where: { id: req.user!.id, googleSub: { not: null } }, data: { googleSub: null } });
    if (count === 1) await auditFromReq(db, req, { action: 'auth.google.unlinked' });
    res.json({ ok: true });
  });

  // ---------------------------------------------------------------- TOTP enrollment
  // POST /mfa/totp/enroll — start authenticator-app setup (QR code).
  r.post('/mfa/totp/enroll', auth, enrollmentOrRecentMfa, async (req, res) => {
    const u = req.user!;
    const existing = await db.totpSecret.findUnique({ where: { userId: u.id }, select: { confirmed: true } });
    if (existing?.confirmed) throw new HttpError(409, 'totp_already_enrolled', 'An authenticator app is already enrolled');
    // Reopening setup shows the same seed for a while, so an entry already scanned keeps working.
    let secret = await recentUnconfirmedTotp(db, u.id);
    if (!secret) {
      secret = newTotpSecret();
      await storeUnconfirmedTotp(db, u.id, secret);
    }
    res.json(await totpEnrollmentPayload(secret, config.RP_NAME, u.email));
  });

  // POST /mfa/totp/confirm — confirm setup with a first code.
  r.post('/mfa/totp/confirm', limiter, auth, async (req, res) => {
    const u = req.user!;
    const { code } = parse(codeBody, req.body);
    const factorsBefore = await availableMethods(db, u.id);
    const result = await verifyAndConsumeTotp(db, u.id, code, false);
    if (result !== 'ok') throw totpError(result, 400);
    // Keep an existing code set; issue one only when the user has no usable codes yet.
    const recoveryCodes = factorsBefore.includes('recovery') ? undefined : await regenerateRecoveryCodes(db, u.id);
    if (req.session.mfaEnrollmentRequired) await finishEnrollment(req, db);
    await auditFromReq(db, req, { action: 'auth.mfa.totp_enrolled' });
    res.json(recoveryCodes ? { recoveryCodes } : {});
  });

  // ---------------------------------------------------------------- passkey registration / management
  // POST /mfa/passkey/register/options — challenge for adding a passkey.
  r.post('/mfa/passkey/register/options', auth, enrollmentOrRecentMfa, async (req, res) => {
    const options = await registrationOptions(db, config, req.user!);
    issueChallenge(req, 'register', options.challenge);
    res.json(options);
  });

  // POST /mfa/passkey/register/verify — save a new passkey.
  r.post('/mfa/passkey/register/verify', auth, enrollmentOrRecentMfa, async (req, res) => {
    const u = req.user!;
    const { response, name } = parse(registerVerifyBody, req.body);
    const challenge = await takeChallenge(db, req, 'register');
    if (!challenge) throw new HttpError(400, 'invalid_passkey', 'No registration in progress');
    let cred: Awaited<ReturnType<typeof verifyRegistration>>;
    try {
      cred = await verifyRegistration(config, response as unknown as RegistrationResponseJSON, challenge);
    } catch {
      cred = null;
    }
    if (!cred) throw new HttpError(400, 'invalid_passkey', 'Passkey registration failed');

    const factorsBefore = await availableMethods(db, u.id);
    const pk = await db.passkey.create({
      data: {
        userId: u.id,
        credentialId: cred.credentialId,
        publicKey: Buffer.from(cred.publicKey),
        counter: BigInt(cred.counter),
        transports: cred.transports,
        name,
      },
    });
    let recoveryCodes: string[] | undefined;
    if (!factorsBefore.includes('recovery')) recoveryCodes = await regenerateRecoveryCodes(db, u.id);
    if (req.session.mfaEnrollmentRequired) await finishEnrollment(req, db);
    await auditFromReq(db, req, { action: 'auth.mfa.passkey_added', meta: { passkeyId: pk.id, name } });
    res.json({ id: pk.id, name: pk.name, ...(recoveryCodes ? { recoveryCodes } : {}) });
  });

  /** Not in the original contract: lets the SPA list passkeys for the delete UI. */
  r.get('/mfa/passkeys', auth, async (req, res) => {
    const passkeys = await db.passkey.findMany({
      where: { userId: req.user!.id },
      select: { id: true, name: true, createdAt: true, lastUsedAt: true },
      orderBy: { createdAt: 'asc' },
    });
    res.json({ passkeys });
  });

  // DELETE /mfa/passkeys/:id — remove a passkey (but never the last factor).
  r.delete('/mfa/passkeys/:id', auth, requireRecentMfa, async (req, res) => {
    const u = req.user!;
    const id = parse(z.string().uuid(), req.params.id);
    const pk = await db.passkey.findFirst({ where: { id, userId: u.id } });
    if (!pk) throw notFound();
    const [totp, others] = await Promise.all([
      db.totpSecret.findFirst({ where: { userId: u.id, confirmed: true }, select: { userId: true } }),
      db.passkey.count({ where: { userId: u.id, id: { not: id } } }),
    ]);
    if (!totp && others === 0) throw new HttpError(409, 'last_factor', 'At least one MFA factor must remain');
    await db.passkey.delete({ where: { id } });
    await auditFromReq(db, req, { action: 'auth.mfa.passkey_removed', meta: { passkeyId: id, name: pk.name } });
    res.json({ ok: true });
  });

  return r;
}

/** Enrollment → full session: new session id (no fixation across the privilege change). */
async function finishEnrollment(req: Request, db: Db): Promise<void> {
  const userId = req.user!.id;
  const googleLinkSub = req.session.googleLinkSub;
  await startFullSession(req, userId);
  await resetFailures(db, userId);
  await linkPendingGoogle(db, req, userId, googleLinkSub);
}

/** Deletes every stored session (full, enrollment or pending) belonging to the user. */
export async function killUserSessions(db: Db, userId: string): Promise<number> {
  const a = await db.session.deleteMany({ where: { sess: { path: ['userId'], equals: userId } } });
  const b = await db.session.deleteMany({ where: { sess: { path: ['pendingUserId'], equals: userId } } });
  return a.count + b.count;
}
