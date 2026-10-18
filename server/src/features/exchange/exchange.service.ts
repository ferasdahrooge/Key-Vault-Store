/**
 * ejson export / import mapping.
 *   Export: flat document { _public_key, _kv_meta: {project, env, exportedAt}, KEY: "EJ[...]" }.
 *   Import: top-level strings become secrets; nested objects flatten with "__"; keys starting
 *           with "_" are ignored at every level; arrays and non-strings are rejected; every value
 *           must be ejson-boxed (plaintext is rejected, never stored).
 */
import { Decrypter, Encrypter, isBoxed, type Json, type JsonObject } from '../../config/ejson.js';
import { HttpError } from '../../core/http.js';
import { KEY_RE, valueTooLarge } from '../secrets/secrets.service.js';

// ejson public keys are 64 lowercase hex characters.
export const HEX_KEY_RE = /^[0-9a-f]{64}$/;

/** Max nesting of objects in an import file (deeper → rejected `too_deep`, never recursed into). */
export const MAX_IMPORT_DEPTH = 8;

// Document fields that are never treated as secrets.
export const RESERVED_DOC_KEYS = new Set(['_public_key', '_kv_meta']);

// Builds an ejson document with every value encrypted to the recipient's key.
export function buildExportDoc(
  recipientPublicKey: string,
  meta: { project: string; env: string },
  values: Iterable<[string, string]>,
): JsonObject {
  const enc = new Encrypter(recipientPublicKey);
  const doc: JsonObject = {
    _public_key: recipientPublicKey,
    _kv_meta: { project: meta.project, env: meta.env, exportedAt: new Date().toISOString() },
  };
  // KEY_RE allows a leading underscore, so a secret could be named like a document field; never let
  // it overwrite _public_key/_kv_meta (that would make the file undecryptable or mislabelled).
  for (const [k, v] of values) if (!RESERVED_DOC_KEYS.has(k)) doc[k] = enc.encrypt(v);
  return doc;
}

// A decrypted key/value ready to store, and a skipped field with its reason.
export interface ImportEntry {
  key: string;
  value: string;
}
export interface Rejected {
  path: string;
  reason: string;
}

// Parses and decrypts an uploaded ejson file into entries plus rejected fields.
export function parseImportDoc(text: string, importPublicKey: string, importPrivateKey: string): { entries: ImportEntry[]; rejected: Rejected[] } {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'invalid_ejson', 'File is not valid JSON');
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) throw new HttpError(400, 'invalid_ejson', 'File must contain a JSON object');
  // The file must be encrypted to this server's import key.
  const pub = (doc as JsonObject)._public_key;
  if (pub !== importPublicKey) {
    throw new HttpError(400, 'wrong_import_key', 'File is not encrypted to this server\'s import key (GET /api/import-key)');
  }

  const dec = new Decrypter(importPrivateKey);
  const entries: ImportEntry[] = [];
  const rejected: Rejected[] = [];
  const seen = new Set<string>();

  // Walks the document, flattening nested objects into KEY__SUB names.
  const visit = (node: JsonObject, prefix: string[]) => {
    for (const [k, v] of Object.entries(node)) {
      // `_`-prefixed fields are ejson metadata (plaintext) — but an exported secret whose key starts
      // with `_` is an encrypted string, so only skip reserved names and non-encrypted `_` fields.
      if (k.startsWith('_') && (RESERVED_DOC_KEYS.has(k) || typeof v !== 'string' || !isBoxed(v))) continue;
      const path = [...prefix, k];
      const key = path.join('__');
      if (isPlainObject(v)) {
        if (path.length >= MAX_IMPORT_DEPTH) {
          rejected.push({ path: path.join('.'), reason: 'too_deep' });
          continue;
        }
        visit(v, path);
        continue;
      }
      const at = path.join('.');
      if (Array.isArray(v)) {
        rejected.push({ path: at, reason: 'arrays are not supported' });
        continue;
      }
      if (typeof v !== 'string') {
        rejected.push({ path: at, reason: 'value must be an encrypted string' });
        continue;
      }
      if (!isBoxed(v)) {
        rejected.push({ path: at, reason: 'value is not ejson-encrypted' });
        continue;
      }
      if (!KEY_RE.test(key)) {
        rejected.push({ path: at, reason: 'invalid key name' });
        continue;
      }
      if (seen.has(key)) {
        rejected.push({ path: at, reason: 'duplicate key after flattening' });
        continue;
      }
      let value: string;
      try {
        value = dec.decrypt(v);
      } catch {
        rejected.push({ path: at, reason: 'could not decrypt' });
        continue;
      }
      if (valueTooLarge(value)) {
        rejected.push({ path: at, reason: 'value exceeds 64 KB' });
        continue;
      }
      seen.add(key);
      entries.push({ key, value });
    }
  };
  visit(doc as JsonObject, []);
  return { entries, rejected };
}

// True for JSON objects (not arrays or null).
function isPlainObject(v: Json): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
