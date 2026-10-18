/**
 * KEK rotation. Procedure:
 *   1. `npm run secrets:edit` — add a new key under master_kek and point _active_kek at it
 *      (keep the old key in the file for now).
 *   2. `npx tsx scripts/rotate-kek.ts` — re-wraps every environment DEK that is still wrapped by a
 *      non-active KEK, and re-seals every TOTP seed with the active KEK's system key. One transaction.
 *   3. Once this reports 0 remaining, remove the old KEK from secrets.ejson and restart.
 * Secret values themselves are untouched (they are encrypted under DEKs, which do not change).
 */
import { initCrypto } from '../src/crypto/index.js';
import { loadConfig } from '../src/config/index.js';
import { createDb } from '../src/core/db.js';
import { rotateKek } from '../src/features/key-rotation/kekRotation.service.js';
import { resolveKeydir } from './_shared.js';

// Load config and crypto with all KEKs, the new one active.
process.env.EJSON_KEYDIR ??= resolveKeydir();
const config = loadConfig();
const active = config.secrets._active_kek;
initCrypto({ masterKeks: config.secrets.master_kek, activeKek: active });
const db = createDb(config.secrets.database_url);

try {
  // Re-wrap everything and print a summary.
  const result = await rotateKek(db, active);
  console.log(`Active KEK: ${active}`);
  console.log(`Re-wrapped ${result.rewrapped} environment DEK(s); re-sealed ${result.totp} TOTP seed(s).`);
  console.log(`Environments still on another KEK: ${result.remaining}.`);
  if (result.remaining === 0) {
    console.log('All data is now protected by the active KEK. You can remove the old KEK(s) from secrets.ejson.');
  }
} finally {
  await db.$disconnect();
}
