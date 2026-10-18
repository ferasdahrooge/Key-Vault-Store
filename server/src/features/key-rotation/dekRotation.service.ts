/**
 * Per-environment DEK rotation: new DEK, every SecretVersion re-encrypted under the same AAD,
 * dekVersion bumped — all in one transaction holding the environment row lock, so no write can
 * slip a version encrypted with the old DEK in between.
 */
import type { Prisma } from '@prisma/client';
import { DEK_ROTATION_THRESHOLD, decryptSecret, encryptSecret, newEnvironmentKey, type EnvKeyMaterial } from '../../crypto/index.js';
import type { Db } from '../../core/db.js';
import { logger } from '../../core/logger.js';
import { recordAudit, type AuditEntry } from '../audit/audit.service.js';

type Tx = Prisma.TransactionClient;

// Current auto-rotation threshold (lowered in tests).
let threshold: bigint = DEK_ROTATION_THRESHOLD;

/** Test hook: lower the auto-rotation threshold. Pass undefined to restore the default. */
export function setDekRotationThreshold(n: bigint | number | undefined): void {
  threshold = n === undefined ? DEK_ROTATION_THRESHOLD : BigInt(n);
}

// Returns the active threshold.
export function dekRotationThreshold(): bigint {
  return threshold;
}

/** Prisma Bytes are Uint8Array<ArrayBuffer>; crypto hands back plain Uint8Array/Buffer. */
export const bytes = (u: Uint8Array) => u as Uint8Array<ArrayBuffer>;

// Environment columns needed to unwrap its DEK.
export const keyMaterialSelect = {
  id: true,
  wrappedDek: true,
  dekIv: true,
  dekTag: true,
  kekId: true,
  dekVersion: true,
} satisfies Prisma.EnvironmentSelect;

/** Takes the environment row lock (FOR UPDATE) for the rest of the transaction. */
export async function lockEnvironment(tx: Tx, envId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM "Environment" WHERE id = ${envId}::uuid FOR UPDATE`;
}

// Who triggered a rotation, for the audit entry.
export interface RotationAudit {
  actorType: AuditEntry['actorType'];
  actorId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

// Generates a new DEK for an env and re-encrypts every secret version with it.
export async function rotateEnvironmentDek(
  db: Db,
  envId: string,
  audit: RotationAudit & { reason: 'manual' | 'threshold' },
): Promise<{ dekVersion: number; reencrypted: number }> {
  return db.$transaction(
    async (tx) => {
      await lockEnvironment(tx, envId);
      const env = await tx.environment.findUniqueOrThrow({ where: { id: envId }, select: { ...keyMaterialSelect, projectId: true } });
      const oldKey: EnvKeyMaterial = env;
      const fresh = newEnvironmentKey();
      const newKey: EnvKeyMaterial = { id: env.id, dekVersion: env.dekVersion + 1, ...fresh };

      // Decrypt each version with the old DEK and re-encrypt with the new one.
      const versions = await tx.secretVersion.findMany({
        where: { secret: { envId } },
        select: { secretId: true, version: true, ciphertext: true, iv: true, tag: true, secret: { select: { key: true } } },
      });
      for (const v of versions) {
        const aad = { secretId: v.secretId, version: v.version, key: v.secret.key };
        const plain = decryptSecret(oldKey, aad, v);
        const sealed = encryptSecret(newKey, aad, plain);
        await tx.secretVersion.update({
          where: { secretId_version: { secretId: v.secretId, version: v.version } },
          data: { ciphertext: bytes(sealed.ciphertext), iv: bytes(sealed.iv), tag: bytes(sealed.tag), dekVersion: newKey.dekVersion },
        });
      }
      await tx.environment.update({
        where: { id: envId },
        data: {
          wrappedDek: bytes(fresh.wrappedDek),
          dekIv: bytes(fresh.dekIv),
          dekTag: bytes(fresh.dekTag),
          kekId: fresh.kekId,
          dekVersion: newKey.dekVersion,
          // Re-encryptions are uses of the new key too.
          encCount: BigInt(versions.length),
        },
      });
      await recordAudit(tx, {
        ...audit,
        action: 'env.dek_rotated',
        projectId: env.projectId,
        envId,
        meta: { dekVersion: newKey.dekVersion, reencrypted: versions.length, reason: audit.reason },
      });
      return { dekVersion: newKey.dekVersion, reencrypted: versions.length };
    },
    { timeout: 120_000, maxWait: 10_000 },
  );
}

/** Called after a write transaction committed; rotates when the encryption counter crossed the threshold. */
export async function maybeAutoRotate(db: Db, envId: string, encCount: bigint): Promise<void> {
  if (encCount < threshold) return;
  try {
    // Re-check under the lock inside rotate? Cheap double-check here avoids a redundant rotation
    // when two writers cross the threshold concurrently.
    const env = await db.environment.findUnique({ where: { id: envId }, select: { encCount: true } });
    if (!env || env.encCount < threshold) return;
    await rotateEnvironmentDek(db, envId, { actorType: 'system', reason: 'threshold' });
  } catch (err) {
    // The write itself succeeded; rotation will be retried on the next write.
    logger.error({ err, envId }, 'automatic DEK rotation failed');
  }
}
