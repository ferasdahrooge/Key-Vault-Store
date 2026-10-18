import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  Decrypter,
  EjsonError,
  Encrypter,
  decryptDocument,
  decryptFile,
  encryptDocument,
  generateKeypair,
  isBoxed,
  loadPrivateKey,
  stringify,
} from '../../src/config/ejson.js';

// Fixture from Shopify/ejson's own ejson_test.go — proves interop with the Go implementation.
const UPSTREAM = {
  pub: '8d8647e2eeb6d2e31228e6df7da3df921ec3b799c3f66a171cd37a1ed3004e7d',
  priv: 'c5caa31a5b8cb2be0074b37c56775f533b368b81d8fd33b94181f79bd6e47f87',
  boxed: 'EJ[1:KR1IxNZnTZQMP3OR1NdOpDQ1IcLD83FSuE7iVNzINDk=:XnYW1HOxMthBFMnxWULHlnY4scj5mNmX:ls1+kvwwu2ETz5C6apgWE7Q=]',
  plain: 'b',
};

function tempKeydir(kp = generateKeypair()) {
  const dir = mkdtempSync(path.join(tmpdir(), 'kv-ejson-'));
  writeFileSync(path.join(dir, kp.publicKey), kp.privateKey + '\n', { mode: 0o400 });
  return { dir, kp };
}

// Our ejson implementation must match the official format and CLI.
describe('ejson codec', () => {
  it('decrypts the upstream Go test vector', () => {
    expect(new Decrypter(UPSTREAM.priv).decrypt(UPSTREAM.boxed)).toBe(UPSTREAM.plain);
  });

  it('round-trips unicode, newlines and escapes', () => {
    const kp = generateKeypair();
    const enc = new Encrypter(kp.publicKey);
    const dec = new Decrypter(kp.privateKey);
    for (const s of ['', 'plain', 'é 🔐 日本', '-----BEGIN KEY-----\nabc\n-----END KEY-----\n', '"q"\\\t']) {
      const boxed = enc.encrypt(s);
      expect(isBoxed(boxed)).toBe(true);
      expect(dec.decrypt(boxed)).toBe(s);
    }
  });

  it('uses a fresh nonce per value and never double-encrypts', () => {
    const enc = new Encrypter(generateKeypair().publicKey);
    const a = enc.encrypt('same');
    expect(enc.encrypt('same')).not.toBe(a);
    expect(enc.encrypt(a)).toBe(a);
  });

  it('follows the walker rules for underscores, nesting, arrays and non-strings', () => {
    const kp = generateKeypair();
    const doc = encryptDocument({
      _public_key: kp.publicKey,
      _comment: 'plain',
      secret: 's',
      n: 1,
      b: true,
      z: null,
      _list: ['plain-in-underscore-array'],
      list: ['enc'],
      _nested: { inner: 'enc-because-nested-resets', _inner: 'plain' },
      objs: [{ _x: 'plain', y: 'enc' }],
    });
    expect(doc._public_key).toBe(kp.publicKey);
    expect(doc._comment).toBe('plain');
    expect(isBoxed(doc.secret as string)).toBe(true);
    expect([doc.n, doc.b, doc.z]).toEqual([1, true, null]);
    expect(doc._list).toEqual(['plain-in-underscore-array']);
    expect(isBoxed((doc.list as string[])[0]!)).toBe(true);
    expect(isBoxed((doc._nested as Record<string, string>).inner!)).toBe(true);
    expect((doc._nested as Record<string, string>)._inner).toBe('plain');
    const obj = (doc.objs as Record<string, string>[])[0]!;
    expect(obj._x).toBe('plain');
    expect(isBoxed(obj.y!)).toBe(true);

    const back = decryptDocument(doc, { privateKey: kp.privateKey });
    expect(back.secret).toBe('s');
    expect((back._nested as Record<string, string>).inner).toBe('enc-because-nested-resets');
  });

  it('rejects tampered ciphertext and wrong keys', () => {
    const kp = generateKeypair();
    const boxed = new Encrypter(kp.publicKey).encrypt('secret');
    const body = boxed.slice(boxed.lastIndexOf(':') + 1, -1);
    const flipped = Buffer.from(body, 'base64');
    flipped[0]! ^= 1;
    const tampered = boxed.replace(body, flipped.toString('base64'));
    expect(() => new Decrypter(kp.privateKey).decrypt(tampered)).toThrow(EjsonError);
    expect(() => new Decrypter(generateKeypair().privateKey).decrypt(boxed)).toThrow(EjsonError);
  });

  it('strict mode refuses plaintext secrets', () => {
    const kp = generateKeypair();
    expect(() =>
      decryptDocument({ _public_key: kp.publicKey, oops: 'plain' }, { privateKey: kp.privateKey, strict: true }),
    ).toThrow(/plaintext value at \$\.oops/);
  });

  it('loads keys from a keydir and verifies they match the public key', () => {
    const { dir, kp } = tempKeydir();
    expect(loadPrivateKey(kp.publicKey, dir)).toBe(kp.privateKey);
    const other = generateKeypair();
    writeFileSync(path.join(dir, other.publicKey), kp.privateKey);
    expect(() => loadPrivateKey(other.publicKey, dir)).toThrow(/does not match/);
    expect(() => loadPrivateKey(generateKeypair().publicKey, dir)).toThrow(/couldn't read/);
  });

  it('decrypts files from disk', () => {
    const { dir, kp } = tempKeydir();
    const file = path.join(dir, 'secrets.ejson');
    writeFileSync(file, stringify(encryptDocument({ _public_key: kp.publicKey, a: 'b' })));
    expect(decryptFile(file, { keydir: dir })).toEqual({ _public_key: kp.publicKey, a: 'b' });
  });
});

const hasCli = spawnSync('ejson', ['--version']).status === 0;

describe.skipIf(!hasCli)('interop with the ejson CLI', () => {
  it('CLI decrypts what we encrypt', () => {
    const { dir, kp } = tempKeydir();
    const file = path.join(dir, 'ours.ejson');
    writeFileSync(file, stringify(encryptDocument({ _public_key: kp.publicKey, k: 'v\né', arr: ['x'] })));
    const out = execFileSync('ejson', ['--keydir', dir, 'decrypt', file], { encoding: 'utf8' });
    expect(JSON.parse(out)).toEqual({ _public_key: kp.publicKey, k: 'v\né', arr: ['x'] });
  });

  it('we decrypt what the CLI encrypts', () => {
    const { dir, kp } = tempKeydir();
    const file = path.join(dir, 'theirs.ejson');
    writeFileSync(file, stringify({ _public_key: kp.publicKey, k: 'v\né', _c: 'p', nested: { a: 'b' } }));
    execFileSync('ejson', ['encrypt', file]);
    const encrypted = JSON.parse(readFileSync(file, 'utf8'));
    expect(isBoxed(encrypted.k)).toBe(true);
    expect(decryptFile(file, { keydir: dir, strict: true })).toEqual({
      _public_key: kp.publicKey,
      k: 'v\né',
      _c: 'p',
      nested: { a: 'b' },
    });
  });
});
