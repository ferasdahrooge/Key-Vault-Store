import { describe, expect, it } from 'vitest';
import {
  assertPasswordPolicy,
  checkPasswordPolicy,
  dummyVerify,
  hashPassword,
  PASSWORD_HASH_OPTIONS,
  verifyPassword,
} from '../../src/features/auth/password.js';

// A password that satisfies the policy.
const STRONG = 'correct horse battery staple';

// Rules for acceptable passwords.
describe('password policy', () => {
  it('accepts a long, varied passphrase', () => {
    expect(checkPasswordPolicy(STRONG, 'alice@example.com')).toEqual([]);
  });

  it('rejects too short and too long', () => {
    expect(checkPasswordPolicy('Ab1!xyz9Qw', undefined).join()).toMatch(/at least 12/);
    expect(checkPasswordPolicy('a1b2c3d4e5f6'.repeat(30)).join()).toMatch(/at most 256/);
  });

  it('counts code points, not UTF-16 units', () => {
    // 11 emoji = 22 UTF-16 units but only 11 characters.
    expect(checkPasswordPolicy('😀😁😂🤣😃😄😅😆😉😊😋').join()).toMatch(/at least 12/);
  });

  it('rejects passwords containing the email local part', () => {
    expect(checkPasswordPolicy('xx-AliceSmith-2024!', 'alicesmith@example.com').join()).toMatch(/email/);
    // short local parts (<3 chars) are ignored
    expect(checkPasswordPolicy(STRONG + ' al', 'al@example.com')).toEqual([]);
  });

  it('rejects common passwords and common words with trailing digits/symbols', () => {
    expect(checkPasswordPolicy('password1234').join()).toMatch(/too common/);
    expect(checkPasswordPolicy('Password2024!!!').join()).toMatch(/too common/);
    expect(checkPasswordPolicy('qwertyuiop123').join()).toMatch(/too common/);
  });

  it('rejects low-variety passwords', () => {
    expect(checkPasswordPolicy('abababababababab').join()).toMatch(/variety/);
  });

  it('assertPasswordPolicy throws 400 weak_password with fields', () => {
    let err: unknown;
    try {
      assertPasswordPolicy('short');
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({ status: 400, code: 'weak_password' });
    expect((err as { fields: unknown[] }).fields[0]).toMatchObject({ path: 'password' });
    expect(() => assertPasswordPolicy(STRONG)).not.toThrow();
  });
});

// Argon2id hashing and verification.
describe('password hashing', () => {
  it('uses Argon2id with the configured parameters embedded in the hash', async () => {
    const h = await hashPassword(STRONG);
    expect(h).toMatch(
      new RegExp(`^\\$argon2id\\$v=19\\$m=${PASSWORD_HASH_OPTIONS.memoryCost},t=${PASSWORD_HASH_OPTIONS.timeCost},p=${PASSWORD_HASH_OPTIONS.parallelism}\\$`),
    );
    expect(PASSWORD_HASH_OPTIONS.memoryCost).toBeGreaterThanOrEqual(19456);
    expect(h).not.toContain(STRONG);
  });

  it('round-trips and rejects wrong passwords', async () => {
    const h = await hashPassword(STRONG);
    expect(await verifyPassword(h, STRONG)).toBe(true);
    expect(await verifyPassword(h, STRONG + 'x')).toBe(false);
    expect(await hashPassword(STRONG)).not.toBe(h); // random salt
  });

  it('NFKC-normalises before hashing', async () => {
    const composed = 'café au lait 2024 x';
    const decomposed = 'café au lait 2024 x';
    const fullwidth = 'ｃａｆé au lait 2024 x'; // fullwidth "caf"
    const h = await hashPassword(composed);
    expect(await verifyPassword(h, decomposed)).toBe(true);
    expect(await verifyPassword(h, fullwidth)).toBe(true);
  });

  it('verifyPassword returns false for a malformed hash; dummyVerify resolves', async () => {
    expect(await verifyPassword('not-a-hash', STRONG)).toBe(false);
    await expect(dummyVerify('anything')).resolves.toBeUndefined();
  });
});
