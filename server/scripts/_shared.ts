/** Small helpers shared by the secrets:* CLI scripts (argument parsing, private-key file writing). */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export { resolveKeydir } from '../src/config/index.js';

// Saves a private key file named after its public key in the keydir.
export function writePrivateKey(dir: string, publicKey: string, privateKey: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, publicKey);
  // 0400 and 'wx': owner read-only, and never overwrite an existing key (that would orphan its vault).
  writeFileSync(file, privateKey + '\n', { mode: 0o400, flag: 'wx' });
  return file;
}

/** Value of `--name <value>` on the command line, if present. */
export function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
