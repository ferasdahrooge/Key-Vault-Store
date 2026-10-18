import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Decrypter, Encrypter, encryptDocument, generateKeypair } from '../../src/config/ejson.js';
import { verifyAuditChain } from '../../src/features/audit/audit.service.js';
import { setupTestApp, type TestAgent, type TestHarness } from '../helpers/app.js';

let h: TestHarness;
let as: TestAgent;
let editor: TestAgent;
const env = '/api/projects/app/envs/dev';

beforeAll(async () => {
  h = await setupTestApp();
  const owner = await h.createUser({ isAdmin: true });
  as = await h.agentFor(owner);
  await as.post('/api/projects').send({ slug: 'app', name: 'App' }).expect(201);
  const ed = await h.createUser();
  await as.put(`${env}/members/${ed.id}`).send({ role: 'editor' }).expect(200);
  editor = await h.agentFor(ed);
  for (const [key, value] of [['A', 'alpha'], ['B', 'bravo'], ['_UNDERSCORE', 'under']]) {
    await as.post(`${env}/secrets`).send({ key, value }).expect(201);
  }
}, 60_000);
afterAll(() => h?.teardown());

const importDoc = (doc: Record<string, unknown>) =>
  JSON.stringify(encryptDocument({ _public_key: h.importKp.publicKey, ...doc } as never));

// Downloading secrets as ejson.
describe('ejson export', () => {
  it('owner + recent MFA exports a doc decryptable by the recipient', async () => {
    const kp = generateKeypair();
    const res = await as.post(`${env}/export`).send({ recipientPublicKey: kp.publicKey }).expect(200);
    expect(res.get('content-disposition')).toContain('secrets.dev.ejson');
    expect(res.body._public_key).toBe(kp.publicKey);
    expect(res.text).not.toMatch(/alpha|bravo/);
    const d = new Decrypter(kp.privateKey);
    expect(d.decrypt(res.body.A)).toBe('alpha');
    expect(d.decrypt(res.body.B)).toBe('bravo');
    expect(d.decrypt(res.body._UNDERSCORE)).toBe('under');
    const row = await h.db.auditLog.findFirst({ where: { action: 'export.ejson' } });
    expect(JSON.stringify(row?.meta)).not.toMatch(/alpha|bravo/);

    const only = await as.post(`${env}/export`).send({ recipientPublicKey: kp.publicKey, keys: ['A'] }).expect(200);
    expect(Object.keys(only.body).filter((k) => !k.startsWith('_'))).toEqual(['A']);
  });

  it('requires owner and recent MFA', async () => {
    const kp = generateKeypair();
    await editor.post(`${env}/export`).send({ recipientPublicKey: kp.publicKey }).expect(403);
    const owner = await h.db.user.findFirstOrThrow({ where: { isAdmin: true } });
    const stale = await h.agentFor(owner, { mfaAgoMs: 600_000 });
    expect((await stale.post(`${env}/export`).send({ recipientPublicKey: kp.publicKey }).expect(401)).body.error.code).toBe('reauth_required');
    await as.post(`${env}/export`).send({ recipientPublicKey: 'nothex' }).expect(400);
  });

  it('export → import roundtrip keeps underscore-prefixed secrets', async () => {
    // Re-encrypt the export to the import key, as a user would with `ejson` after editing.
    const kp = generateKeypair();
    const exp = (await as.post(`${env}/export`).send({ recipientPublicKey: kp.publicKey }).expect(200)).body;
    const d = new Decrypter(kp.privateKey);
    const enc = new Encrypter(h.importKp.publicKey);
    const doc: Record<string, unknown> = { _public_key: h.importKp.publicKey, _kv_meta: exp._kv_meta };
    for (const k of ['A', 'B', '_UNDERSCORE']) doc[k] = enc.encrypt(d.decrypt(exp[k]));
    const p = await editor.post(`${env}/import/preview`).send({ ejson: JSON.stringify(doc) }).expect(200);
    expect(p.body.changes).toEqual([
      { key: 'A', status: 'unchanged' },
      { key: 'B', status: 'unchanged' },
      { key: '_UNDERSCORE', status: 'unchanged' },
    ]);
    expect(p.body.rejected).toEqual([]);
  });
});

// Uploading ejson files into an environment.
describe('ejson import', () => {
  it('GET /api/import-key returns the server import key', async () => {
    expect((await editor.get('/api/import-key').expect(200)).body.publicKey).toBe(h.importKp.publicKey);
  });

  it('preview classifies new/changed/unchanged, flattens nesting with __, rejects plaintext', async () => {
    const ejson = JSON.parse(importDoc({ A: 'alpha', B: 'bravo-2', DB: { HOST: 'db.local', PORT: '5432' }, _comment: 'note' }));
    ejson.PLAIN = 'not-encrypted';
    const res = await editor.post(`${env}/import/preview`).send({ ejson: JSON.stringify(ejson) }).expect(200);
    expect(res.body.changes).toEqual([
      { key: 'A', status: 'unchanged' },
      { key: 'B', status: 'changed' },
      { key: 'DB__HOST', status: 'new' },
      { key: 'DB__PORT', status: 'new' },
    ]);
    expect(res.body.rejected).toEqual([{ path: 'PLAIN', reason: 'value is not ejson-encrypted' }]);
    expect(res.text).not.toMatch(/bravo-2|db\.local|not-encrypted/);
    // Preview writes nothing.
    expect(await h.db.secret.count({ where: { key: 'DB__HOST' } })).toBe(0);
  });

  it('rejects nesting deeper than 8 levels with too_deep (no stack overflow)', async () => {
    const leaf = new Encrypter(h.importKp.publicKey).encrypt('deep');
    const nest = (n: number): Record<string, unknown> => (n === 0 ? { X: leaf } : { L: nest(n - 1) });
    const ok = await editor.post(`${env}/import/preview`).send({ ejson: JSON.stringify({ _public_key: h.importKp.publicKey, ...nest(7) }) }).expect(200);
    expect(ok.body.changes).toEqual([{ key: 'L__L__L__L__L__L__L__X', status: 'new' }]);
    const deep = await editor.post(`${env}/import/preview`).send({ ejson: JSON.stringify({ _public_key: h.importKp.publicKey, ...nest(8) }) }).expect(200);
    expect(deep.body.changes).toEqual([]);
    expect(deep.body.rejected).toEqual([{ path: 'L.L.L.L.L.L.L.L', reason: 'too_deep' }]);
    let huge = '"x"';
    for (let i = 0; i < 20_000; i++) huge = `{"a":${huge}}`;
    const r = await editor.post(`${env}/import/preview`).send({ ejson: `{"_public_key":"${h.importKp.publicKey}","a":${huge}}` }).expect(200);
    expect(r.body.rejected[0].reason).toBe('too_deep');
  });

  it('commit applies changes as new versions and audits without values', async () => {
    const ejson = importDoc({ A: 'alpha', B: 'bravo-2', DB: { HOST: 'db.local' } });
    const res = await editor.post(`${env}/import/commit`).send({ ejson }).expect(200);
    expect(res.body).toEqual({ created: 1, updated: 1, unchanged: 1, rejected: [] });
    const b = await h.db.secret.findFirstOrThrow({ where: { key: 'B' } });
    expect(b.currentVersion).toBe(2);
    const host = await h.db.secret.findFirstOrThrow({ where: { key: 'DB__HOST' } });
    expect((await as.post(`${env}/secrets/${host.id}/reveal`).send({}).expect(200)).body.value).toBe('db.local');
    expect((await as.post(`${env}/secrets/${b.id}/reveal`).send({}).expect(200)).body.value).toBe('bravo-2');
    const row = await h.db.auditLog.findFirst({ where: { action: 'import.ejson' } });
    expect(row?.meta).toMatchObject({ created: 1, updated: 1, unchanged: 1, rejected: 0 });
    expect(JSON.stringify(row?.meta)).not.toMatch(/bravo-2|db\.local/);
  });

  it('wrong import key → 400 wrong_import_key; viewer cannot import; protected env needs confirm', async () => {
    const other = generateKeypair();
    const bad = JSON.stringify(encryptDocument({ _public_key: other.publicKey, A: 'x' }));
    expect((await editor.post(`${env}/import/preview`).send({ ejson: bad }).expect(400)).body.error.code).toBe('wrong_import_key');
    expect((await editor.post(`${env}/import/commit`).send({ ejson: bad }).expect(400)).body.error.code).toBe('wrong_import_key');
    expect((await editor.post(`${env}/import/preview`).send({ ejson: '{nope' }).expect(400)).body.error.code).toBe('invalid_ejson');

    const v = await h.createUser();
    await as.put(`${env}/members/${v.id}`).send({ role: 'viewer' }).expect(200);
    await (await h.agentFor(v)).post(`${env}/import/preview`).send({ ejson: importDoc({ A: 'x' }) }).expect(403);

    const prod = '/api/projects/app/envs/prod';
    expect((await as.post(`${prod}/import/commit`).send({ ejson: importDoc({ P: 'x' }) }).expect(400)).body.error.code).toBe('confirm_required');
    await as.post(`${prod}/import/commit`).send({ ejson: importDoc({ P: 'x' }), confirm: 'prod' }).expect(200);
  });

  it('audit chain verifies', async () => {
    expect(await verifyAuditChain(h.db)).toMatchObject({ ok: true });
  });
});
