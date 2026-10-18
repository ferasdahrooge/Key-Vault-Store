/** Shapes shared by the envelope-encryption code (KEK config, wrapped DEKs, sealed values, AAD). */
export interface CryptoInit {
  /** kid → base64 32-byte key, from secrets.master_kek */
  masterKeks: Readonly<Record<string, string>>;
  activeKek: string;
}

/** Columns stored on Environment. Prisma `Bytes` are Uint8Array. */
export interface WrappedDek {
  wrappedDek: Uint8Array;
  dekIv: Uint8Array;
  dekTag: Uint8Array;
  kekId: string;
}

// A wrapped DEK plus the environment id and DEK version it belongs to.
export interface EnvKeyMaterial extends WrappedDek {
  id: string;
  dekVersion: number;
}

// AES-GCM output: ciphertext, IV and auth tag.
export interface SealedValue {
  ciphertext: Uint8Array;
  iv: Uint8Array;
  tag: Uint8Array;
}

// Row identity bound into each secret's ciphertext.
export interface SecretAad {
  secretId: string;
  version: number;
  key: string;
}
