import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { storeUnconfirmedTotp } from '../../src/features/auth/totp.js';
import { clearDekCache, initCrypto, systemDecrypt } from '../../src/crypto/index.js';
import { rotateKek } from '../../src/features/key-rotation/kekRotation.service.js';
import { setupTestApp, type TestAgent, type TestHarness } from '../helpers/app.js';

let h: TestHarness;
let as: TestAgent;
let userId: string;
const ids: Record<string, string> = {};

beforeAll(async () => {
  h = await setupTestApp();
  const owner = await h.createUser({ isAdmin: true });
  userId = owner.id;
  as = await h.agentFor(owner);
  await as.post('/api/projects').send({ slug: 'app', name: 'App' }).expect(201);
  for (const env of ['dev', 'staging']) {
    const s = await as.post(`/api/projects/app/envs/${env}/secrets`).send({ key: 'K', value: `${env}-v1` }).expect(201);
    ids[env] = s.body.secret.id;
    await as.patch(`/api/projects/app/envs/${env}/secrets/${ids[env]}`).send({ value: `${env}-v2` }).expect(200);
  }
  await storeUnconfirmedTotp(h.db, userId, 'JBSWY3DPEHPK3PXP');
}, 60_000);
afterAll(() => h?.teardown());

// Rotating the master key keeps all data readable.
describe('KEK rotation (features/key-rotation/kekRotation.service, used by scripts/rotate-kek.ts)', () => {
  it('re-wraps all DEKs and TOTP seeds; works with only the new KEK loaded', async () => {
    expect(await h.db.environment.count({ where: { kekId: { not: 'v1' } } })).toBe(0);
    const v1 = h.config.secrets.master_kek.v1!;
    const v2 = randomBytes(32).toString('base64');

    initCrypto({ masterKeks: { v1, v2 }, activeKek: 'v2' });
    clearDekCache();
    const res = await rotateKek(h.db, 'v2');
    expect(res).toEqual({ activeKek: 'v2', rewrapped: 3, totp: 1, remaining: 0 });
    expect(await h.db.environment.count({ where: { kekId: { not: 'v2' } } })).toBe(0);
    expect(await h.db.auditLog.count({ where: { action: 'system.kek_rotated' } })).toBe(1);

    // Drop v1 entirely.
    initCrypto({ masterKeks: { v2 }, activeKek: 'v2' });
    clearDekCache();
    for (const env of ['dev', 'staging']) {
      const base = `/api/projects/app/envs/${env}/secrets/${ids[env]}/reveal`;
      expect((await as.post(base).send({}).expect(200)).body.value).toBe(`${env}-v2`);
      expect((await as.post(base).send({ version: 1 }).expect(200)).body.value).toBe(`${env}-v1`);
    }
    const t = await h.db.totpSecret.findUniqueOrThrow({ where: { userId } });
    expect(systemDecrypt(t, `totp:${userId}`).toString('utf8')).toBe('JBSWY3DPEHPK3PXP');

    // Idempotent second run.
    expect(await rotateKek(h.db, 'v2')).toMatchObject({ rewrapped: 0, remaining: 0 });
  });
});
