/**
 * CONTRACT — public crypto API used by the rest of the server. Implementation lives in
 * envelope.ts / keyring.ts / dekCache.ts; this file only re-exports. Do not change signatures
 * without updating every caller.
 *
 * Model: ejson-protected KEK(s) → per-environment DEK (AES-256-GCM wrapped) → secret values
 * (AES-256-GCM, 96-bit random IV, AAD = "kv1|envId|secretId|version|key").
 */
export {
  initCrypto,
  newEnvironmentKey,
  encryptSecret,
  decryptSecret,
  rewrapDek,
  systemEncrypt,
  systemDecrypt,
  clearDekCache,
  DEK_ROTATION_THRESHOLD,
} from './envelope.js';
export { sha256hex, randomToken, timingSafeEqualStr } from './random.js';
export type { EnvKeyMaterial, WrappedDek, SealedValue, SecretAad, CryptoInit } from './types.js';
