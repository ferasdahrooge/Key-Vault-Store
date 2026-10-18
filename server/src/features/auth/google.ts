/**
 * Sign in with Google: OpenID Connect authorization-code flow with PKCE, state and nonce.
 *
 * Google stands in for the PASSWORD step only. A verified Google identity puts the session in the
 * same pending (or enrollment) state as a correct password, and the user must still pass MFA.
 * There is no self-signup: only existing active users can sign in this way.
 *
 * Account matching: by stored `googleSub` first. A user without one is matched once by verified
 * email; the sub is remembered only after that login completes MFA (see linkPendingGoogle), so a
 * half-finished login never binds a Google account to a user.
 *
 * The ID token comes straight from Google's token endpoint over TLS, in a request authenticated with
 * our client secret, so (OIDC Core 3.1.3.7) the TLS server check stands in for its signature. The
 * claims (iss, aud, azp, exp, nonce, email_verified, hd) are still checked.
 *
 * Google redirects the browser to the SPA route /login/google/callback, which POSTs code + state to
 * /api/auth/google/callback. That request is same-site, so the SameSite=Strict session cookie and
 * the CSRF token keep working without being loosened for a cross-site redirect.
 */
import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { Request } from 'express';
import { z } from 'zod';
import type { AppConfig } from '../../config/index.js';
import { randomToken, timingSafeEqualStr } from '../../crypto/index.js';
import type { Db } from '../../core/db.js';
import { auditAuth } from './session.js';

// Extra session fields used only during Google sign-in.
declare module 'express-session' {
  interface SessionData {
    /** In-flight Google sign-in (between /google/start and /google/callback). */
    googleOAuth?: { state: string; nonce: string; verifier: string; at: number; next?: string };
    /** Google `sub` to remember on the user once this login completes MFA (first Google login). */
    googleLinkSub?: string;
  }
}

// Google OAuth endpoints and the issuers its ID tokens may carry.
export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);
/** How long the user may spend on Google's pages before the callback is refused. */
export const GOOGLE_FLOW_TTL_MS = 10 * 60 * 1000;
// Allowed clock drift for exp, and how long to wait for Google's token endpoint.
const CLOCK_SKEW_S = 60;
const TOKEN_TIMEOUT_MS = 10_000;

// Reasons a Google login can fail (mapped to user-facing messages by the route).
export type GoogleFailure = 'exchange_failed' | 'invalid_id_token' | 'email_unverified' | 'wrong_domain';

export class GoogleLoginError extends Error {
  constructor(public readonly reason: GoogleFailure) {
    super(reason);
  }
}

// The verified identity we take from Google's ID token.
export interface GoogleIdentity {
  sub: string;
  email: string;
}

export type GoogleFlow = NonNullable<Request['session']['googleOAuth']>;

// Google sign-in is on only when OAuth client credentials exist in secrets.
export const googleEnabled = (config: AppConfig): boolean => !!config.secrets.google_oauth;

// SPA route Google redirects back to after the user picks an account.
export const googleRedirectUri = (config: AppConfig): string =>
  `${config.APP_ORIGIN.replace(/\/$/, '')}/login/google/callback`;

/** Stores a fresh state/nonce/PKCE verifier in the session and returns Google's authorization URL. */
export function beginGoogleLogin(req: Request, config: AppConfig, next?: string): string {
  const { client_id } = config.secrets.google_oauth!;
  const state = randomToken();
  const nonce = randomToken();
  const verifier = randomToken('', 48); // 64 chars; RFC 7636 allows 43-128
  req.session.googleOAuth = { state, nonce, verifier, at: Date.now(), ...(next ? { next } : {}) };

  const url = new URL(GOOGLE_AUTH_URL);
  url.search = new URLSearchParams({
    client_id,
    redirect_uri: googleRedirectUri(config),
    response_type: 'code',
    scope: 'openid email',
    state,
    nonce,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    prompt: 'select_account',
    // Only a hint for Google's account chooser; the hd claim is what's enforced (checkClaims).
    ...(config.GOOGLE_HOSTED_DOMAIN ? { hd: config.GOOGLE_HOSTED_DOMAIN } : {}),
  }).toString();
  return url.toString();
}

/** Consumes the session's in-flight flow. Null when it is missing, stale or `state` doesn't match. */
export function takeGoogleFlow(req: Request, state: string): GoogleFlow | null {
  const f = req.session.googleOAuth;
  delete req.session.googleOAuth;
  if (!f || typeof f !== 'object' || Date.now() - f.at > GOOGLE_FLOW_TTL_MS) return null;
  return timingSafeEqualStr(f.state, state) ? f : null;
}

/** Redeems the authorization code and returns the checked identity, or throws GoogleLoginError. */
export async function exchangeGoogleCode(config: AppConfig, code: string, flow: GoogleFlow): Promise<GoogleIdentity> {
  const { client_id, client_secret } = config.secrets.google_oauth!;
  let body: unknown;
  try {
    // Exchange the one-time code (plus PKCE verifier) for tokens.
    const res = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id,
        client_secret,
        redirect_uri: googleRedirectUri(config),
        code_verifier: flow.verifier,
      }),
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
    if (!res.ok) throw new GoogleLoginError('exchange_failed');
    body = await res.json();
  } catch (err) {
    throw err instanceof GoogleLoginError ? err : new GoogleLoginError('exchange_failed');
  }
  // Pull out the ID token and validate its claims.
  const idToken = (body as { id_token?: unknown } | null)?.id_token;
  if (typeof idToken !== 'string') throw new GoogleLoginError('invalid_id_token');
  return checkClaims(config, decodeJwtPayload(idToken), flow.nonce);
}

// ID-token claims we require, with sane length limits.
const claimsSchema = z.object({
  iss: z.string(),
  aud: z.union([z.string(), z.array(z.string())]),
  azp: z.string().optional(),
  exp: z.number(),
  sub: z.string().min(1).max(255),
  nonce: z.string(),
  email: z.string().min(3).max(254),
  email_verified: z.boolean().optional(),
  hd: z.string().optional(),
});

// Decodes the JWT's middle (payload) segment; the signature is covered by TLS (see top).
function decodeJwtPayload(jwt: string): unknown {
  const parts = jwt.split('.');
  if (parts.length !== 3 || !parts[1]) throw new GoogleLoginError('invalid_id_token');
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    throw new GoogleLoginError('invalid_id_token');
  }
}

/** Exported for unit tests. */
export function checkClaims(config: AppConfig, raw: unknown, nonce: string, nowS = Date.now() / 1000): GoogleIdentity {
  const { client_id } = config.secrets.google_oauth!;
  const parsed = claimsSchema.safeParse(raw);
  if (!parsed.success) throw new GoogleLoginError('invalid_id_token');
  const c = parsed.data;
  // Token must be issued by Google, for our client, unexpired, and for this login's nonce.
  const audOk = Array.isArray(c.aud) ? c.aud.includes(client_id) && c.azp === client_id : c.aud === client_id;
  if (!ISSUERS.has(c.iss) || !audOk || c.exp + CLOCK_SKEW_S < nowS || !timingSafeEqualStr(c.nonce, nonce)) {
    throw new GoogleLoginError('invalid_id_token');
  }
  // Only verified emails, and (if configured) only our Workspace domain.
  if (c.email_verified !== true) throw new GoogleLoginError('email_unverified');
  if (config.GOOGLE_HOSTED_DOMAIN && c.hd?.toLowerCase() !== config.GOOGLE_HOSTED_DOMAIN) {
    throw new GoogleLoginError('wrong_domain');
  }
  return { sub: c.sub, email: c.email };
}

/**
 * The user this Google identity may sign in as, plus whether the sub still has to be linked.
 * A user already linked to a different Google account is never matched by email.
 */
export async function findGoogleUser(db: Db, id: GoogleIdentity) {
  // Prefer the stable Google subject id; fall back to email for first-time linking.
  const linked = await db.user.findUnique({ where: { googleSub: id.sub } });
  if (linked) return { user: linked, link: false };
  const byEmail = await db.user.findFirst({ where: { email: { equals: id.email, mode: 'insensitive' } } });
  if (!byEmail || byEmail.googleSub) return null;
  return { user: byEmail, link: true };
}

/**
 * Called once a login reached a full session: remembers the Google sub queued by the callback.
 * Conditional on the user still having no sub, and a sub already taken by another user is skipped.
 */
export async function linkPendingGoogle(db: Db, req: Request, userId: string, sub: string | undefined): Promise<void> {
  if (!sub) return;
  try {
    const { count } = await db.user.updateMany({ where: { id: userId, googleSub: null }, data: { googleSub: sub } });
    if (count === 1) await auditAuth(db, req, 'auth.google.linked', { userId });
  } catch (err) {
    // P2002 = another user already owns this Google sub; skip silently.
    if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) throw err;
  }
}
