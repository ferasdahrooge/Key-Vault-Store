/**
 * One-time recovery codes: 10 codes of the form xxxx-xxxx-xxxx (31-symbol alphabet without
 * look-alikes, ~59 bits each), Argon2id-hashed. Shown once at generation; each is single-use.
 * They carry far more entropy than a password, so they use the lighter OWASP-minimum Argon2 cost.
 */
import { randomInt } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import type { Db } from '../../core/db.js';

// Characters used in codes (no 0/o, 1/l/i look-alikes).
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const RECOVERY_HASH_OPTIONS = { algorithm: 2 /* Argon2id */, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;
export const RECOVERY_CODE_COUNT = 10;

// Builds one random code: three groups of four characters.
export function generateRecoveryCode(): string {
  const groups: string[] = [];
  for (let g = 0; g < 3; g++) {
    let s = '';
    for (let i = 0; i < 4; i++) s += ALPHABET[randomInt(ALPHABET.length)];
    groups.push(s);
  }
  return groups.join('-');
}

/** Lowercases, drops whitespace/dashes and re-groups. Returns null when it cannot be a valid code. */
export function normaliseRecoveryCode(input: string): string | null {
  const raw = input.toLowerCase().replace(/[\s-]/g, '');
  if (raw.length !== 12 || ![...raw].every((c) => ALPHABET.includes(c))) return null;
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8)}`;
}

/** Replaces all of the user's recovery codes with a fresh set and returns the plaintext codes (show once). */
export async function regenerateRecoveryCodes(db: Db, userId: string): Promise<string[]> {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, generateRecoveryCode);
  const hashes = await Promise.all(codes.map((c) => hash(c, RECOVERY_HASH_OPTIONS)));
  await db.$transaction([
    db.recoveryCode.deleteMany({ where: { userId } }),
    db.recoveryCode.createMany({ data: hashes.map((codeHash) => ({ userId, codeHash })) }),
  ]);
  return codes;
}

/** Verifies and burns one code. Returns the number of unused codes left, or null when invalid. */
export async function consumeRecoveryCode(db: Db, userId: string, input: string): Promise<number | null> {
  const code = normaliseRecoveryCode(input);
  const rows = await db.recoveryCode.findMany({ where: { userId, usedAt: null }, select: { id: true, codeHash: true } });
  if (!code) return null;
  // Try each unused code's hash; the first match is burned atomically.
  for (const row of rows) {
    let ok = false;
    try {
      ok = await verify(row.codeHash, code);
    } catch {
      ok = false;
    }
    if (!ok) continue;
    const { count } = await db.recoveryCode.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: new Date() } });
    if (count !== 1) return null; // lost a race with a concurrent use
    return db.recoveryCode.count({ where: { userId, usedAt: null } });
  }
  return null;
}

// Number of unused recovery codes the user still has.
export function countRecoveryCodes(db: Db, userId: string): Promise<number> {
  return db.recoveryCode.count({ where: { userId, usedAt: null } });
}
