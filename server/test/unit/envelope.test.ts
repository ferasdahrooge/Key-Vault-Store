import { randomBytes, randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  decryptSecret,
  encryptSecret,
  initCrypto,
  newEnvironmentKey,
  rewrapDek,
  systemDecrypt,
  systemEncrypt,
  type EnvKeyMaterial,
} from '../../src/crypto/index.js';

const k1 = randomBytes(32).toString('base64');
const k2 = randomBytes(32).toString('base64');

function env(): EnvKeyMaterial {
  return { id: randomUUID(), dekVersion: 1, ...newEnvironmentKey() };
}

// KEK → DEK → value encryption, AAD binding and KEK rotation.
describe('envelope encryption', () => {
  beforeEach(() => initCrypto({ masterKeks: { v1: k1 }, activeKek: 'v1' }));

  it('round-trips values', () => {
    const e = env();
    const aad = { secretId: randomUUID(), version: 1, key: 'DB_PASSWORD' };
    for (const v of ['', 'hunter2', 'é🔐\n'.repeat(1000)]) {
      expect(decryptSecret(e, aad, encryptSecret(e, aad, v))).toBe(v);
    }
  });

  it('uses unique IVs', () => {
    const e = env();
    const aad = { secretId: 's', version: 1, key: 'K' };
    const ivs = new Set(Array.from({ length: 200 }, () => Buffer.from(encryptSecret(e, aad, 'x').iv).toString('hex')));
    expect(ivs.size).toBe(200);
  });

  it.each(['ciphertext', 'iv', 'tag'] as const)('detects a flipped bit in %s', (field) => {
    const e = env();
    const aad = { secretId: 's', version: 1, key: 'K' };
    const sealed = encryptSecret(e, aad, 'value');
    const bad = { ...sealed, [field]: Buffer.from(sealed[field]) };
    bad[field][0]! ^= 1;
    expect(() => decryptSecret(e, aad, bad)).toThrow('decryption failed');
  });

  it('binds ciphertext to env, secret, version and key name (AAD)', () => {
    const e = env();
    const aad = { secretId: 's', version: 1, key: 'K' };
    const sealed = encryptSecret(e, aad, 'value');
    expect(() => decryptSecret(e, { ...aad, secretId: 'other' }, sealed)).toThrow();
    expect(() => decryptSecret(e, { ...aad, version: 2 }, sealed)).toThrow();
    expect(() => decryptSecret(e, { ...aad, key: 'K2' }, sealed)).toThrow();
    expect(() => decryptSecret({ ...e, id: randomUUID() }, aad, sealed)).toThrow();
  });

  it('cannot decrypt with another environment DEK', () => {
    const a = env();
    const b = { ...env(), id: a.id };
    const aad = { secretId: 's', version: 1, key: 'K' };
    expect(() => decryptSecret(b, aad, encryptSecret(a, aad, 'v'))).toThrow();
  });

  it('KEK rotation re-wraps the DEK without touching data', () => {
    const e = env();
    const aad = { secretId: 's', version: 1, key: 'K' };
    const sealed = encryptSecret(e, aad, 'survives rotation');

    initCrypto({ masterKeks: { v1: k1, v2: k2 }, activeKek: 'v2' });
    const rewrapped = { ...e, ...rewrapDek(e) };
    expect(rewrapped.kekId).toBe('v2');

    initCrypto({ masterKeks: { v2: k2 }, activeKek: 'v2' }); // v1 retired
    expect(decryptSecret(rewrapped, aad, sealed)).toBe('survives rotation');
    expect(() => decryptSecret(e, aad, sealed)).toThrow(/KEK "v1" not available/);
  });

  it('system encryption is context-bound and survives KEK rotation', () => {
    const sealed = systemEncrypt('JBSWY3DPEHPK3PXP', 'totp:user-1');
    expect(systemDecrypt(sealed, 'totp:user-1').toString()).toBe('JBSWY3DPEHPK3PXP');
    expect(() => systemDecrypt(sealed, 'totp:user-2')).toThrow();
    initCrypto({ masterKeks: { v1: k1, v2: k2 }, activeKek: 'v2' });
    expect(systemDecrypt(sealed, 'totp:user-1').toString()).toBe('JBSWY3DPEHPK3PXP');
  });

  it('refuses to start with a bad KEK', () => {
    expect(() => initCrypto({ masterKeks: { v1: 'short' }, activeKek: 'v1' })).toThrow(/32 bytes/);
    expect(() => initCrypto({ masterKeks: { v1: k1 }, activeKek: 'v9' })).toThrow(/not found/);
  });
});
