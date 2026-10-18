/**
 * Secret storage on top of the envelope crypto.
 *
 * Every write runs inside withEnvKey(): one transaction that takes the environment row lock,
 * loads the DEK material, counts encryptions and adds them to Environment.encCount atomically.
 * After commit, crossing DEK_ROTATION_THRESHOLD triggers an automatic DEK rotation.
 *
 * Soft-delete + recreate: creating a key that exists only as a soft-deleted secret HARD-deletes
 * the old row (and its versions) first, so the new secret starts at v1 with a fresh id. The old
 * history stays in the audit log (key names and versions only).
 */
import { randomUUID } from 'node:crypto';
import type { Prisma, Secret, SecretType } from '@prisma/client';
import { decryptSecret, encryptSecret, type EnvKeyMaterial, type SealedValue, type SecretAad } from '../../crypto/index.js';
import type { Db } from '../../core/db.js';
import { HttpError } from '../../core/http.js';
import { bytes, keyMaterialSelect, lockEnvironment, maybeAutoRotate } from '../key-rotation/dekRotation.service.js';

type Tx = Prisma.TransactionClient;

// Allowed secret key names, max value size, and secret types.
export const KEY_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/;
export const MAX_VALUE_BYTES = 64 * 1024;
export const SECRET_TYPES = ['password', 'apikey', 'connstr', 'cert', 'note', 'json'] as const satisfies readonly SecretType[];

// True when a value exceeds the 64 KB limit.
export function valueTooLarge(v: string): boolean {
  return Buffer.byteLength(v, 'utf8') > MAX_VALUE_BYTES;
}

// Encrypt/decrypt helper bound to one environment's DEK.
export interface Sealer {
  readonly env: EnvKeyMaterial;
  encrypt(aad: SecretAad, plaintext: string): SealedValue & { dekVersion: number };
  decrypt(aad: SecretAad, sealed: SealedValue): string;
}

/** Decrypt-only access to an environment's DEK (reads: reveal, export, machine API). */
export async function envKey(db: Db | Tx, envId: string): Promise<Sealer> {
  const env = await db.environment.findUniqueOrThrow({ where: { id: envId }, select: keyMaterialSelect });
  return {
    env,
    encrypt: () => {
      throw new Error('read-only sealer');
    },
    decrypt: (aad, sealed) => decryptOrThrow(env, aad, sealed),
  };
}

// Turns a crypto failure into a clean 500 instead of a stack trace.
function decryptOrThrow(env: EnvKeyMaterial, aad: SecretAad, sealed: SealedValue): string {
  try {
    return decryptSecret(env, aad, sealed);
  } catch {
    throw new HttpError(500, 'decryption_failed', 'Stored value failed integrity check');
  }
}

/**
 * Read-only access to an environment's values under a FOR SHARE lock on the env row, so a
 * concurrent DEK rotation (which holds FOR UPDATE while re-encrypting every version) can't commit
 * between reading the wrapped DEK and reading the ciphertexts (which would fail with a 500).
 */
export async function withEnvRead<T>(db: Db, envId: string, fn: (tx: Tx, k: Sealer) => Promise<T>): Promise<T> {
  return db.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Environment" WHERE id = ${envId}::uuid FOR SHARE`;
      return fn(tx, await envKey(tx, envId));
    },
    { timeout: 60_000, maxWait: 10_000 },
  );
}

// Runs a write under the env row lock, counting encryptions for auto-rotation.
export async function withEnvKey<T>(db: Db, envId: string, fn: (tx: Tx, k: Sealer) => Promise<T>): Promise<T> {
  const { result, encCount } = await db.$transaction(
    async (tx) => {
      await lockEnvironment(tx, envId);
      const env = await tx.environment.findUniqueOrThrow({ where: { id: envId }, select: keyMaterialSelect });
      let count = 0;
      const sealer: Sealer = {
        env,
        encrypt: (aad, pt) => {
          count++;
          return encryptSecret(env, aad, pt);
        },
        decrypt: (aad, sealed) => decryptOrThrow(env, aad, sealed),
      };
      const result = await fn(tx, sealer);
      let encCount = 0n;
      if (count > 0) {
        const updated = await tx.environment.update({
          where: { id: envId },
          data: { encCount: { increment: count } },
          select: { encCount: true },
        });
        encCount = updated.encCount;
      }
      return { result, encCount };
    },
    { timeout: 60_000, maxWait: 10_000 },
  );
  // After commit, rotate the DEK if it has been used too many times.
  if (encCount > 0n) await maybeAutoRotate(db, envId, encCount);
  return result;
}

// Fields for creating a secret.
export interface NewSecretInput {
  envId: string;
  key: string;
  value: string;
  type?: SecretType;
  description?: string;
  tags?: string[];
  expiresAt?: Date | null;
  userId: string | null;
  comment?: string;
}

// Creates a secret at version 1 with its encrypted value.
export async function createSecret(tx: Tx, k: Sealer, input: NewSecretInput): Promise<Secret> {
  const existing = await tx.secret.findUnique({ where: { envId_key: { envId: input.envId, key: input.key } }, select: { id: true, deletedAt: true } });
  if (existing && !existing.deletedAt) throw new HttpError(409, 'key_exists', 'A secret with this key already exists');
  if (existing) await tx.secret.delete({ where: { id: existing.id } }); // see header: hard-delete on recreate

  const id = randomUUID();
  const sealed = k.encrypt({ secretId: id, version: 1, key: input.key }, input.value);
  return tx.secret.create({
    data: {
      id,
      envId: input.envId,
      key: input.key,
      type: input.type ?? 'password',
      description: input.description ?? '',
      tags: input.tags ?? [],
      expiresAt: input.expiresAt ?? null,
      currentVersion: 1,
      updatedBy: input.userId,
      versions: {
        create: {
          version: 1,
          ciphertext: bytes(sealed.ciphertext),
          iv: bytes(sealed.iv),
          tag: bytes(sealed.tag),
          dekVersion: sealed.dekVersion,
          comment: input.comment ?? '',
          createdBy: input.userId,
        },
      },
    },
  });
}

/** Appends version currentVersion+1 holding `value`. Caller passes the row read inside the same tx. */
export async function addVersion(
  tx: Tx,
  k: Sealer,
  secret: { id: string; key: string; currentVersion: number },
  value: string,
  userId: string | null,
  comment = '',
  extra: Prisma.SecretUpdateInput = {},
): Promise<Secret> {
  const version = secret.currentVersion + 1;
  const sealed = k.encrypt({ secretId: secret.id, version, key: secret.key }, value);
  await tx.secretVersion.create({
    data: {
      secretId: secret.id,
      version,
      ciphertext: bytes(sealed.ciphertext),
      iv: bytes(sealed.iv),
      tag: bytes(sealed.tag),
      dekVersion: sealed.dekVersion,
      comment,
      createdBy: userId,
    },
  });
  return tx.secret.update({ where: { id: secret.id }, data: { ...extra, currentVersion: version, updatedBy: userId } });
}

// Decrypts one specific version of a secret.
export async function decryptVersion(db: Db | Tx, k: Sealer, secret: { id: string; key: string }, version: number): Promise<string> {
  const v = await db.secretVersion.findUnique({ where: { secretId_version: { secretId: secret.id, version } } });
  if (!v) throw new HttpError(404, 'not_found', 'Version not found');
  return k.decrypt({ secretId: secret.id, version, key: secret.key }, v);
}

/** Current plaintext of every live secret in the env (optionally limited to `keys`). */
export async function currentValues(db: Db | Tx, k: Sealer, envId: string, keys?: string[]) {
  const secrets = await db.secret.findMany({
    where: { envId, deletedAt: null, ...(keys ? { key: { in: keys } } : {}) },
    orderBy: { key: 'asc' },
    include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
  });
  const out = new Map<string, { secret: Secret; value: string }>();
  for (const s of secrets) {
    const v = s.versions[0];
    if (!v || v.version !== s.currentVersion) throw new HttpError(500, 'decryption_failed', 'Version chain inconsistent');
    out.set(s.key, { secret: s, value: k.decrypt({ secretId: s.id, version: v.version, key: s.key }, v) });
  }
  return out;
}

// Loads a non-deleted secret in the env, or 404.
export async function findLiveSecret(db: Db | Tx, envId: string, id: string): Promise<Secret> {
  const s = await db.secret.findFirst({ where: { id, envId, deletedAt: null } });
  if (!s) throw new HttpError(404, 'not_found', 'Not found');
  return s;
}

// Minimal user info shown next to secrets (who changed it).
export type UserRef = { id: string; name: string } | null;

// Looks up names for a list of user ids in one query.
export async function userRefs(db: Db | Tx, ids: (string | null | undefined)[]): Promise<Map<string, { id: string; name: string }>> {
  const uniq = [...new Set(ids.filter((x): x is string => !!x))];
  if (uniq.length === 0) return new Map();
  const users = await db.user.findMany({ where: { id: { in: uniq } }, select: { id: true, name: true } });
  return new Map(users.map((u) => [u.id, u]));
}

// Secret metadata returned by the API (never the value).
export interface SecretMeta {
  id: string;
  key: string;
  type: SecretType;
  description: string;
  tags: string[];
  currentVersion: number;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  updatedBy: UserRef;
}

// Builds SecretMeta from a row and preloaded user names.
export function toSecretMeta(s: Secret, users: Map<string, { id: string; name: string }>): SecretMeta {
  return {
    id: s.id,
    key: s.key,
    type: s.type,
    description: s.description,
    tags: s.tags,
    currentVersion: s.currentVersion,
    expiresAt: s.expiresAt,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    updatedBy: s.updatedBy ? (users.get(s.updatedBy) ?? null) : null,
  };
}

// Builds SecretMeta for a single secret.
export async function secretMeta(db: Db | Tx, s: Secret): Promise<SecretMeta> {
  return toSecretMeta(s, await userRefs(db, [s.updatedBy]));
}
