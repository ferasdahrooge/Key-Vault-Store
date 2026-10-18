/**
 * Decrypts secrets.<env>.ejson to a 0600 temp file, opens $EDITOR, then re-encrypts and
 * overwrites the original. The plaintext temp file is overwritten with zeros and removed.
 *
 *   npm run secrets:edit -- --env development
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { decryptFile, encryptDocument, stringify, type JsonObject } from '../src/config/ejson.js';
import { secretsPath, secretsSchema } from '../src/config/index.js';
import { arg, resolveKeydir } from './_shared.js';

// Decrypt the secrets file for the chosen env.
const env = arg('env') ?? process.env.NODE_ENV ?? 'development';
const file = secretsPath(env);
const plain = decryptFile(file, { keydir: resolveKeydir() });

// Write the plaintext to a private temp file (mode 0600).
const dir = mkdtempSync(path.join(tmpdir(), 'kv-edit-'));
const tmp = path.join(dir, `secrets.${env}.json`);
writeFileSync(tmp, stringify(plain), { mode: 0o600 });

try {
  // Open the user's editor and wait for it to close.
  const editor = process.env.VISUAL || process.env.EDITOR || 'vi';
  const r = spawnSync(editor, [tmp], { stdio: 'inherit', shell: true });
  if (r.status !== 0) throw new Error(`editor exited with status ${r.status}`);

  // Validate the edited JSON, then re-encrypt over the original file.
  const edited = JSON.parse(readFileSync(tmp, 'utf8')) as JsonObject;
  const check = secretsSchema.safeParse(edited);
  if (!check.success) {
    throw new Error('edited secrets are invalid:\n  ' + check.error.issues.map((i) => i.path.join('.') + ': ' + i.message).join('\n  '));
  }
  writeFileSync(file, stringify(encryptDocument(edited)));
  console.log(`Re-encrypted ${file}`);
} finally {
  // Always zero out and delete the plaintext temp file.
  writeFileSync(tmp, Buffer.alloc(statSync(tmp).size));
  rmSync(dir, { recursive: true, force: true });
}
