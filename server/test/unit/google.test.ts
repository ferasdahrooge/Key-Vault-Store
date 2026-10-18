import { describe, expect, it } from 'vitest';
import { checkClaims, GoogleLoginError } from '../../src/features/auth/google.js';
import type { AppConfig } from '../../src/config/index.js';

// Fixed client id and clock for deterministic claim checks.
const CLIENT_ID = 'kv-test.apps.googleusercontent.com';
const NOW = 1_800_000_000;
const config = (hd?: string) =>
  ({ secrets: { google_oauth: { client_id: CLIENT_ID, client_secret: 's' } }, GOOGLE_HOSTED_DOMAIN: hd }) as unknown as AppConfig;

const claims = (over: Record<string, unknown> = {}) => ({
  iss: 'https://accounts.google.com',
  aud: CLIENT_ID,
  exp: NOW + 300,
  sub: '1234567890',
  nonce: 'n0nce',
  email: 'a@example.com',
  email_verified: true,
  ...over,
});

const reason = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof GoogleLoginError) return e.reason;
    throw e;
  }
  return 'ok';
};

// ID-token claim validation for Google sign-in.
describe('checkClaims', () => {
  it('accepts a valid token and returns sub + email', () => {
    expect(checkClaims(config(), claims(), 'n0nce', NOW)).toEqual({ sub: '1234567890', email: 'a@example.com' });
    expect(reason(() => checkClaims(config(), claims({ iss: 'accounts.google.com' }), 'n0nce', NOW))).toBe('ok');
  });

  it('rejects wrong issuer, audience, nonce, expiry or shape', () => {
    expect(reason(() => checkClaims(config(), claims({ iss: 'https://evil.example' }), 'n0nce', NOW))).toBe('invalid_id_token');
    expect(reason(() => checkClaims(config(), claims({ aud: 'other.apps.googleusercontent.com' }), 'n0nce', NOW))).toBe('invalid_id_token');
    expect(reason(() => checkClaims(config(), claims(), 'other', NOW))).toBe('invalid_id_token');
    expect(reason(() => checkClaims(config(), claims({ exp: NOW - 120 }), 'n0nce', NOW))).toBe('invalid_id_token');
    expect(reason(() => checkClaims(config(), claims({ exp: NOW - 30 }), 'n0nce', NOW))).toBe('ok'); // clock skew
    expect(reason(() => checkClaims(config(), { ...claims(), sub: undefined }, 'n0nce', NOW))).toBe('invalid_id_token');
  });

  it('accepts an audience list only when azp is our client', () => {
    const aud = [CLIENT_ID, 'other'];
    expect(reason(() => checkClaims(config(), claims({ aud, azp: CLIENT_ID }), 'n0nce', NOW))).toBe('ok');
    expect(reason(() => checkClaims(config(), claims({ aud, azp: 'other' }), 'n0nce', NOW))).toBe('invalid_id_token');
  });

  it('requires a verified email', () => {
    expect(reason(() => checkClaims(config(), claims({ email_verified: false }), 'n0nce', NOW))).toBe('email_unverified');
    expect(reason(() => checkClaims(config(), claims({ email_verified: undefined }), 'n0nce', NOW))).toBe('email_unverified');
  });

  it('enforces the hosted domain when configured', () => {
    expect(reason(() => checkClaims(config('corp.example'), claims({ hd: 'corp.example' }), 'n0nce', NOW))).toBe('ok');
    expect(reason(() => checkClaims(config('corp.example'), claims({ hd: 'other.example' }), 'n0nce', NOW))).toBe('wrong_domain');
    expect(reason(() => checkClaims(config('corp.example'), claims(), 'n0nce', NOW))).toBe('wrong_domain');
  });
});
