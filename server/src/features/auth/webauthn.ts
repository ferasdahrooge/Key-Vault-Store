/**
 * Passkeys via @simplewebauthn/server v14. User verification is required; resident keys preferred.
 * The challenge lives in the session; issueChallenge/takeChallenge (session.ts) make it single use,
 * purpose-bound and short-lived.
 */
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import type { AppConfig } from '../../config/index.js';
import type { Db } from '../../core/db.js';

// How long the browser may wait for the user to touch their authenticator.
const TIMEOUT_MS = 120_000;

// Options for adding a new passkey; excludes ones the user already has.
export async function registrationOptions(
  db: Db,
  config: AppConfig,
  user: { id: string; email: string; name: string },
): Promise<PublicKeyCredentialCreationOptionsJSON> {
  const existing = await db.passkey.findMany({ where: { userId: user.id }, select: { credentialId: true, transports: true } });
  return generateRegistrationOptions({
    rpName: config.RP_NAME,
    rpID: config.RP_ID,
    userName: user.email,
    userDisplayName: user.name,
    userID: new TextEncoder().encode(user.id),
    attestationType: 'none',
    timeout: TIMEOUT_MS,
    excludeCredentials: existing.map((p) => ({ id: p.credentialId, transports: p.transports })),
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
  });
}

// Checks a new passkey's attestation and returns what we store about it.
export async function verifyRegistration(
  config: AppConfig,
  response: RegistrationResponseJSON,
  expectedChallenge: string,
) {
  const v = await verifyRegistrationResponse({
    response,
    expectedChallenge,
    expectedOrigin: config.APP_ORIGIN,
    expectedRPID: config.RP_ID,
    requireUserVerification: true,
  });
  if (!v.verified) return null;
  const c = v.registrationInfo.credential;
  return { credentialId: c.id, publicKey: c.publicKey, counter: c.counter, transports: c.transports ?? [] };
}

// Options for a passkey login/re-auth, limited to the user's registered keys.
export async function authenticationOptions(db: Db, config: AppConfig, userId: string): Promise<PublicKeyCredentialRequestOptionsJSON> {
  const keys = await db.passkey.findMany({ where: { userId }, select: { credentialId: true, transports: true } });
  return generateAuthenticationOptions({
    rpID: config.RP_ID,
    timeout: TIMEOUT_MS,
    userVerification: 'required',
    allowCredentials: keys.map((k) => ({ id: k.credentialId, transports: k.transports })),
  });
}

/**
 * Verifies an assertion against one of the user's passkeys and updates its signature counter.
 * Returns the passkey id on success, null otherwise (never throws for bad client input).
 */
export async function verifyAuthentication(
  db: Db,
  config: AppConfig,
  userId: string,
  response: AuthenticationResponseJSON,
  expectedChallenge: string,
): Promise<string | null> {
  // The credential must belong to this user.
  const pk = await db.passkey.findFirst({ where: { userId, credentialId: response.id } });
  if (!pk) return null;
  let v;
  try {
    v = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: config.APP_ORIGIN,
      expectedRPID: config.RP_ID,
      requireUserVerification: true,
      credential: {
        id: pk.credentialId,
        publicKey: new Uint8Array(pk.publicKey),
        counter: Number(pk.counter),
        transports: pk.transports,
      },
    });
  } catch {
    return null; // includes counter regression (possible cloned authenticator)
  }
  if (!v.verified) return null;
  const newCounter = BigInt(v.authenticationInfo.newCounter);
  // Compare-and-set on the counter so a replayed assertion racing the original cannot both win.
  const { count } = await db.passkey.updateMany({
    where: { id: pk.id, counter: pk.counter },
    data: { counter: newCounter, lastUsedAt: new Date() },
  });
  return count === 1 ? pk.id : null;
}
