/**
 * TOTP (RFC 6238) via otplib v13: SHA-1, 6 digits, 30 s step, ±1 step tolerance.
 * Seeds are stored sealed with the system key (context `totp:<userId>`); replay protection persists
 * the last accepted time-step and rejects any code for a step <= it (atomically, so two concurrent
 * requests with the same code cannot both succeed).
 */
import { generate, generateSecret, generateURI, verify } from 'otplib';
import QRCode from 'qrcode';
import { systemDecrypt, systemEncrypt } from '../../crypto/index.js';
import type { Db } from '../../core/db.js';

// Standard authenticator-app settings: 6 digits every 30 s.
export const TOTP_PERIOD = 30;
export const TOTP_DIGITS = 6;
const TOLERANCE_S = TOTP_PERIOD; // ±1 step

// AAD context binding a sealed seed to its user.
const context = (userId: string) => `totp:${userId}`;

/** Reopening setup within this window shows the same seed, so an entry the user already scanned keeps working. */
export const UNCONFIRMED_REUSE_MS = 15 * 60 * 1000;

/** Apps display and copy codes as "123 456" or "123-456"; accept those spellings. */
export const normaliseTotpCode = (code: string) => code.replace(/[\s-]/g, '');

// Outcome of a code check: accepted, wrong, or already used.
export type TotpResult = 'ok' | 'invalid' | 'reused';

// Random 160-bit TOTP seed.
export function newTotpSecret(): string {
  return generateSecret({ length: 20 });
}

// otpauth:// URL and QR image for the authenticator app to scan.
export async function totpEnrollmentPayload(secret: string, issuer: string, label: string) {
  const otpauthUrl = generateURI({ issuer, label, secret, digits: TOTP_DIGITS, period: TOTP_PERIOD });
  const qrDataUrl = await QRCode.toDataURL(otpauthUrl, { errorCorrectionLevel: 'M', margin: 1, width: 240 });
  return { otpauthUrl, qrDataUrl, secret };
}

/** Stores (or replaces) the user's UNCONFIRMED TOTP seed. Callers must not overwrite a confirmed one. */
export async function storeUnconfirmedTotp(db: Db, userId: string, secret: string): Promise<void> {
  const sealed = systemEncrypt(secret, context(userId));
  const data = {
    ciphertext: Buffer.from(sealed.ciphertext),
    iv: Buffer.from(sealed.iv),
    tag: Buffer.from(sealed.tag),
    confirmed: false,
    lastStep: 0n,
    createdAt: new Date(), // a replaced seed starts a new reuse window
  };
  await db.totpSecret.upsert({ where: { userId }, create: { userId, ...data }, update: data });
}

/** The user's recent UNCONFIRMED seed, if any (see UNCONFIRMED_REUSE_MS); null when there is none to reuse. */
export async function recentUnconfirmedTotp(db: Db, userId: string): Promise<string | null> {
  const row = await db.totpSecret.findUnique({ where: { userId } });
  if (!row || row.confirmed || Date.now() - row.createdAt.getTime() > UNCONFIRMED_REUSE_MS) return null;
  try {
    return systemDecrypt({ ciphertext: row.ciphertext, iv: row.iv, tag: row.tag }, context(userId)).toString('utf8');
  } catch {
    return null;
  }
}

/** Pure check of a code against a seed. Returns the accepted time-step or null. */
export async function checkTotpCode(secret: string, rawCode: string, afterTimeStep = 0): Promise<number | null> {
  const code = normaliseTotpCode(rawCode);
  if (!/^\d{6}$/.test(code)) return null;
  try {
    const r = await verify({
      secret,
      token: code,
      digits: TOTP_DIGITS,
      period: TOTP_PERIOD,
      epochTolerance: TOLERANCE_S,
      ...(afterTimeStep > 0 ? { afterTimeStep } : {}),
    });
    // otplib's functional verify returns a TOTP|HOTP union; only the TOTP variant carries timeStep.
    return r.valid && 'timeStep' in r ? r.timeStep : null;
  } catch {
    return null;
  }
}

/**
 * Verifies a code for the user and consumes its time-step.
 * 'reused' means the code is genuine but its time-step was already used (e.g. logging straight back
 * in within the same 30 s); callers still count it as a failure, but can tell the user to wait.
 * @param requireConfirmed true for login/re-auth, false for the enrollment confirmation.
 */
export async function verifyAndConsumeTotp(db: Db, userId: string, code: string, requireConfirmed: boolean): Promise<TotpResult> {
  const row = await db.totpSecret.findUnique({ where: { userId } });
  if (!row || row.confirmed !== requireConfirmed) return 'invalid';
  let secret: string;
  try {
    secret = systemDecrypt({ ciphertext: row.ciphertext, iv: row.iv, tag: row.tag }, context(userId)).toString('utf8');
  } catch {
    return 'invalid';
  }
  // Reject codes whose time-step is not newer than the last accepted one.
  const step = await checkTotpCode(secret, code);
  if (step === null) return 'invalid';
  if (BigInt(step) <= row.lastStep) return 'reused';
  // Compare-and-set: only one request can advance lastStep past this step.
  const { count } = await db.totpSecret.updateMany({
    where: { userId, lastStep: { lt: BigInt(step) }, confirmed: requireConfirmed },
    data: { lastStep: BigInt(step), ...(requireConfirmed ? {} : { confirmed: true }) },
  });
  return count === 1 ? 'ok' : 'reused';
}

/** Test/helper: current code for a seed. */
export function currentTotpCode(secret: string, epochSeconds?: number): Promise<string> {
  return generate({ secret, digits: TOTP_DIGITS, period: TOTP_PERIOD, ...(epochSeconds ? { epoch: epochSeconds } : {}) });
}
