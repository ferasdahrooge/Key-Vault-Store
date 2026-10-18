/**
 * Envelope encryption.
 *   KEK (from ejson, kid-versioned) ──AES-256-GCM──► per-environment DEK ──AES-256-GCM──► values
 * Every value is bound to its row with AAD "kv1|envId|secretId|version|key", so ciphertext
 * copied to another row, environment or key name fails authentication.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { DekCache } from './dekCache.js';
import type { CryptoInit, EnvKeyMaterial, SealedValue, SecretAad, WrappedDek } from './types.js';

/** Auto-rotate an environment's DEK after this many encryptions (NIST 2^32 cap for random IVs). */
export const DEK_ROTATION_THRESHOLD = 2n ** 30n;

// AES-256-GCM with a 96-bit IV and 256-bit keys.
const ALG = 'aes-256-gcm';
const IV_LEN = 12;
const KEY_LEN = 32;

// In-memory key material loaded by initCrypto.
interface State {
  keks: Map<string, Buffer>;
  activeKek: string;
  /** HKDF(KEK, "kv-system") per KEK id; active first. */
  systemKeys: [string, Buffer][];
  cache: DekCache;
}

let state: State | undefined;

// Returns the crypto state or throws if initCrypto was never called.
function s(): State {
  if (!state) throw new Error('crypto not initialised: call initCrypto() first');
  return state;
}

/** Must be called once at boot (and in tests) before any other function. */
export function initCrypto(init: CryptoInit): void {
  const keks = new Map<string, Buffer>();
  for (const [kid, b64] of Object.entries(init.masterKeks)) {
    const k = Buffer.from(b64, 'base64');
    if (k.length !== KEY_LEN) throw new Error(`master_kek.${kid} must be 32 bytes`);
    keks.set(kid, k);
  }
  const active = keks.get(init.activeKek);
  if (!active) throw new Error(`active KEK "${init.activeKek}" not found`);
  state?.cache.clear();
  state = {
    keks,
    activeKek: init.activeKek,
    systemKeys: [...keks]
      .sort(([a], [b]) => (a === init.activeKek ? -1 : b === init.activeKek ? 1 : 0))
      .map(([kid, k]) => [kid, Buffer.from(hkdfSync('sha256', k, Buffer.alloc(0), 'kv-system', KEY_LEN))]),
    cache: new DekCache(60_000),
  };
}

/** Generates a fresh random DEK and returns it wrapped with the active KEK. */
export function newEnvironmentKey(): WrappedDek {
  const dek = randomBytes(KEY_LEN);
  try {
    return wrap(dek);
  } finally {
    dek.fill(0);
  }
}

/** Encrypts a secret value with the environment DEK. Result also carries dekVersion. */
export function encryptSecret(env: EnvKeyMaterial, aad: SecretAad, plaintext: string): SealedValue & { dekVersion: number } {
  const sealed = seal(dekFor(env), Buffer.from(plaintext, 'utf8'), aadBytes(env.id, aad));
  return { ...sealed, dekVersion: env.dekVersion };
}

/** Decrypts; throws on any authentication failure (tampering, wrong row, wrong key). */
export function decryptSecret(env: EnvKeyMaterial, aad: SecretAad, sealed: SealedValue): string {
  const pt = open(dekFor(env), sealed, aadBytes(env.id, aad));
  try {
    return pt.toString('utf8');
  } finally {
    pt.fill(0);
  }
}

/** Unwraps with its current KEK and re-wraps the same DEK with the active KEK (KEK rotation). */
export function rewrapDek(env: WrappedDek): WrappedDek {
  const dek = unwrap(env);
  try {
    return wrap(dek);
  } finally {
    dek.fill(0);
  }
}

/** Encrypts internal data (TOTP seeds…) with HKDF(active KEK, "kv-system"). `context` is bound as AAD. */
export function systemEncrypt(plaintext: Uint8Array | string, context: string): SealedValue {
  const buf = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : Buffer.from(plaintext);
  return seal(s().systemKeys[0]![1], buf, Buffer.from(`kv1-sys|${context}`));
}

/** Tries the active KEK's system key first, then older ones (so KEK rotation never orphans data). */
export function systemDecrypt(sealed: SealedValue, context: string): Buffer {
  const aad = Buffer.from(`kv1-sys|${context}`);
  for (const [, key] of s().systemKeys) {
    try {
      return open(key, sealed, aad);
    } catch {
      /* try next */
    }
  }
  throw new Error('decryption failed');
}

/** Drops (and zeroes) all cached plaintext DEKs. */
export function clearDekCache(): void {
  s().cache.clear();
}

// ---------------------------------------------------------------------------

// Gets the plaintext DEK for an environment, using the short-lived cache.
function dekFor(env: EnvKeyMaterial): Buffer {
  const cacheKey = `${env.id}:${env.dekVersion}:${env.kekId}:${Buffer.from(env.wrappedDek).toString('base64')}`;
  return s().cache.get(cacheKey, () => unwrap(env));
}

// Encrypts a DEK with the active KEK.
function wrap(dek: Buffer): WrappedDek {
  const { activeKek, keks } = s();
  const { ciphertext, iv, tag } = seal(keks.get(activeKek)!, dek, Buffer.from(`kv1-dek|${activeKek}`));
  return { wrappedDek: ciphertext, dekIv: iv, dekTag: tag, kekId: activeKek };
}

// Decrypts a DEK with the KEK it was wrapped under.
function unwrap(w: WrappedDek): Buffer {
  const kek = s().keks.get(w.kekId);
  if (!kek) throw new Error(`KEK "${w.kekId}" not available; was it removed from secrets.ejson too early?`);
  const dek = open(kek, { ciphertext: w.wrappedDek, iv: w.dekIv, tag: w.dekTag }, Buffer.from(`kv1-dek|${w.kekId}`));
  if (dek.length !== KEY_LEN) throw new Error('unwrapped DEK has invalid length');
  return dek;
}

// Builds the AAD that binds a ciphertext to its exact secret row.
function aadBytes(envId: string, a: SecretAad): Buffer {
  return Buffer.from(`kv1|${envId}|${a.secretId}|${a.version}|${a.key}`, 'utf8');
}

// AES-GCM encrypt with a fresh random IV.
function seal(key: Buffer, plaintext: Buffer, aad: Buffer): SealedValue {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALG, key, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ciphertext, iv, tag: cipher.getAuthTag() };
}

// AES-GCM decrypt; any failure becomes the same generic error.
function open(key: Buffer, sealed: SealedValue, aad: Buffer): Buffer {
  if (sealed.iv.length !== IV_LEN || sealed.tag.length !== 16) throw new Error('decryption failed');
  try {
    const d = createDecipheriv(ALG, key, Buffer.from(sealed.iv));
    d.setAAD(aad);
    d.setAuthTag(Buffer.from(sealed.tag));
    return Buffer.concat([d.update(Buffer.from(sealed.ciphertext)), d.final()]);
  } catch {
    throw new Error('decryption failed'); // uniform error: no oracle about which part was wrong
  }
}
