/**
 * Native implementation of Shopify's ejson format (https://github.com/Shopify/ejson).
 *
 * Wire format of an encrypted value:  EJ[1:<encrypterPub b64>:<nonce b64>:<box b64>]
 *   - NaCl box (Curve25519 + XSalsa20-Poly1305), standard base64 with padding.
 *   - One ephemeral keypair per encryption session; a fresh 24-byte nonce per value.
 *   - Keys are 32 bytes, written as 64-char lowercase hex. Private key files live in
 *     <keydir>/<publicKeyHex> (default /opt/ejson/keys, override with EJSON_KEYDIR).
 *
 * Walk rules (mirrors json/walker.go):
 *   - Only string values are encrypted; keys, numbers, booleans and null never are.
 *   - A string whose object key starts with "_" is left as plaintext.
 *   - Arrays inherit the "_" flag of their key; nested objects reset it.
 *   - Strings are encrypted in their JSON-unescaped form.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import nacl from 'tweetnacl';

// Plain JSON value types.
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

// Matches an encrypted value; and a 32-byte hex key.
const BOXED_RE = /^EJ\[(\d):([A-Za-z0-9+=/]{44}):([A-Za-z0-9+=/]{32}):([A-Za-z0-9+=/]+)\]$/;
const HEX_KEY_RE = /^[0-9a-f]{64}$/;

// Where private keys live in production.
export const DEFAULT_KEYDIR = '/opt/ejson/keys';

// Error type for every ejson failure.
export class EjsonError extends Error {
  override name = 'EjsonError';
}

// An ejson keypair as hex strings.
export interface Keypair {
  publicKey: string; // hex
  privateKey: string; // hex
}

// Creates a new random Curve25519 keypair.
export function generateKeypair(): Keypair {
  const kp = nacl.box.keyPair();
  return { publicKey: toHex(kp.publicKey), privateKey: toHex(kp.secretKey) };
}

// True when a string is already an ejson-encrypted value.
export function isBoxed(value: string): boolean {
  return BOXED_RE.test(value);
}

// Key directory from EJSON_KEYDIR, or the default.
export function keydir(): string {
  return process.env.EJSON_KEYDIR || DEFAULT_KEYDIR;
}

/** Reads the private key for `publicKeyHex` from `<dir>/<publicKeyHex>`. */
export function loadPrivateKey(publicKeyHex: string, dir = keydir()): string {
  assertHexKey(publicKeyHex, 'public key');
  let contents: string;
  try {
    contents = readFileSync(path.join(dir, publicKeyHex), 'utf8').trim();
  } catch {
    throw new EjsonError(`couldn't read private key for ${publicKeyHex} in ${dir}`);
  }
  assertHexKey(contents, 'private key');
  // Make sure the private key really belongs to this public key.
  const derived = toHex(nacl.box.keyPair.fromSecretKey(fromHex(contents)).publicKey);
  if (derived !== publicKeyHex) {
    throw new EjsonError(`private key in ${dir} does not match public key ${publicKeyHex}`);
  }
  return contents;
}

// ---------------------------------------------------------------------------
// Value-level primitives
// ---------------------------------------------------------------------------

// Encrypts values to a recipient public key using one ephemeral keypair.
export class Encrypter {
  private readonly ephemeral = nacl.box.keyPair();
  private readonly shared: Uint8Array;
  private readonly encrypterPub: string;

  constructor(recipientPublicKeyHex: string) {
    assertHexKey(recipientPublicKeyHex, 'public key');
    this.shared = nacl.box.before(fromHex(recipientPublicKeyHex), this.ephemeral.secretKey);
    this.encrypterPub = b64(this.ephemeral.publicKey);
  }

  // Encrypts one string as EJ[1:pub:nonce:box].
  encrypt(plaintext: string): string {
    if (isBoxed(plaintext)) return plaintext; // same as the CLI: never double-encrypt
    const nonce = nacl.randomBytes(nacl.box.nonceLength);
    const box = nacl.box.after(new TextEncoder().encode(plaintext), nonce, this.shared);
    return `EJ[1:${this.encrypterPub}:${b64(nonce)}:${b64(box)}]`;
  }
}

// Decrypts EJ[...] values with our private key.
export class Decrypter {
  private readonly secretKey: Uint8Array;

  constructor(privateKeyHex: string) {
    assertHexKey(privateKeyHex, 'private key');
    this.secretKey = fromHex(privateKeyHex);
  }

  // Decrypts one value; plaintext is returned unchanged.
  decrypt(value: string): string {
    const m = BOXED_RE.exec(value);
    if (!m) return value; // plaintext passes through, like the CLI
    const [, version, pub, nonce, box] = m as unknown as [string, string, string, string, string];
    if (version !== '1') throw new EjsonError(`unsupported ejson schema version ${version}`);
    const opened = nacl.box.open(unb64(box), unb64(nonce), unb64(pub), this.secretKey);
    if (!opened) throw new EjsonError('couldn\'t decrypt message (wrong key or tampered value)');
    return new TextDecoder('utf-8', { fatal: true }).decode(opened);
  }
}

// ---------------------------------------------------------------------------
// Document-level operations
// ---------------------------------------------------------------------------

/** Encrypts every eligible string in `doc` to the document's `_public_key`. */
export function encryptDocument<T extends JsonObject>(doc: T): T {
  const enc = new Encrypter(publicKeyOf(doc));
  return walk(doc, (s) => enc.encrypt(s)) as T;
}

// Options for decrypting a whole document.
export interface DecryptOptions {
  /** Throw if an eligible string is not encrypted (catches secrets committed in plaintext). */
  strict?: boolean;
  keydir?: string;
  privateKey?: string;
}

// Decrypts every eligible string in a document.
export function decryptDocument<T extends JsonObject>(doc: T, opts: DecryptOptions = {}): T {
  const pub = publicKeyOf(doc);
  const dec = new Decrypter(opts.privateKey ?? loadPrivateKey(pub, opts.keydir));
  return walk(doc, (s, at) => {
    if (opts.strict && !isBoxed(s)) {
      throw new EjsonError(`plaintext value at ${at}; run \`ejson encrypt\` before committing`);
    }
    return dec.decrypt(s);
  }) as T;
}

// Reads and decrypts an ejson file from disk.
export function decryptFile<T extends JsonObject = JsonObject>(file: string, opts: DecryptOptions = {}): T {
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new EjsonError(`couldn't read ejson file ${file}: ${(e as Error).message}`);
  }
  if (!isObject(doc)) throw new EjsonError(`${file} must contain a JSON object`);
  return decryptDocument(doc as T, opts);
}

/** Serialises an ejson document the way it should be written to disk. */
export function stringify(doc: JsonObject): string {
  return JSON.stringify(doc, null, 2) + '\n';
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

// Callback applied to each eligible string during a walk.
type Action = (value: string, at: string) => string;

// Recursively applies `action` to strings, skipping ones under `_` keys.
function walk(node: Json, action: Action, at = '$', skip = false): Json {
  if (typeof node === 'string') return skip ? node : action(node, at);
  if (Array.isArray(node)) return node.map((v, i) => walk(v, action, `${at}[${i}]`, skip));
  if (isObject(node)) {
    const out: JsonObject = {};
    for (const [k, v] of Object.entries(node)) {
      out[k] = walk(v, action, `${at}.${k}`, k.startsWith('_'));
    }
    return out;
  }
  return node;
}

// Reads and validates the document's _public_key.
function publicKeyOf(doc: JsonObject): string {
  const pub = doc._public_key;
  if (typeof pub !== 'string') throw new EjsonError('public key not present in ejson file');
  assertHexKey(pub, 'public key');
  return pub;
}

// True for plain JSON objects.
function isObject(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// Throws unless the value is a 64-char lowercase hex key.
function assertHexKey(v: string, what: string): void {
  if (!HEX_KEY_RE.test(v)) throw new EjsonError(`invalid ${what}: expected 64 lowercase hex chars`);
}

// Hex/base64 conversion helpers.
const toHex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const fromHex = (s: string) => new Uint8Array(Buffer.from(s, 'hex'));
const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));
