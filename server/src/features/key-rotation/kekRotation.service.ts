/**
 * KEK rotation core (used by scripts/rotate-kek.ts). Requires initCrypto() to have been called with
 * the new KEK active and the old KEK(s) still loaded. In ONE transaction:
 *   - re-wraps every environment DEK whose kekId != active (secret ciphertexts are untouched),
 *   - re-seals every TOTP seed with the active KEK's system key (context `totp:<userId>`, matching
 *     src/auth/totp.ts),
 *   - audits system.kek_rotated.
 */
import { rewrapDek, systemDecrypt, systemEncrypt } from '../../crypto/index.js';
import type { Db } from '../../core/db.js';
import { recordAudit } from '../audit/audit.service.js';
import { bytes } from './dekRotation.service.js';

// Counts reported back to the rotate-kek script.
export interface KekRotationResult {
  activeKek: string;
  rewrapped: number;
  totp: number;
  remaining: number;
}

// Re-wraps DEKs and re-seals TOTP seeds under the active KEK, in one transaction.
export async function rotateKek(db: Db, activeKek: string): Promise<KekRotationResult> {
  return db.$transaction(
    async (tx) => {
      // Environments still wrapped by an old KEK.
      const envs = await tx.environment.findMany({
        where: { kekId: { not: activeKek } },
        select: { id: true, wrappedDek: true, dekIv: true, dekTag: true, kekId: true },
      });
      for (const e of envs) {
        const w = rewrapDek(e);
        await tx.environment.update({
          where: { id: e.id },
          data: { wrappedDek: bytes(w.wrappedDek), dekIv: bytes(w.dekIv), dekTag: bytes(w.dekTag), kekId: w.kekId },
        });
      }
      // systemDecrypt tries every configured KEK; systemEncrypt always uses the active one.
      const seeds = await tx.totpSecret.findMany({ select: { userId: true, ciphertext: true, iv: true, tag: true } });
      for (const t of seeds) {
        const ctx = `totp:${t.userId}`;
        const plain = systemDecrypt(t, ctx);
        const sealed = systemEncrypt(plain, ctx);
        plain.fill(0);
        await tx.totpSecret.update({
          where: { userId: t.userId },
          data: { ciphertext: bytes(sealed.ciphertext), iv: bytes(sealed.iv), tag: bytes(sealed.tag) },
        });
      }
      await recordAudit(tx, {
        action: 'system.kek_rotated',
        actorType: 'system',
        meta: { activeKek, rewrappedDeks: envs.length, resealedTotp: seeds.length },
      });
      // Should be 0 after a successful run.
      const remaining = await tx.environment.count({ where: { kekId: { not: activeKek } } });
      return { activeKek, rewrapped: envs.length, totp: seeds.length, remaining };
    },
    { timeout: 120_000 },
  );
}
