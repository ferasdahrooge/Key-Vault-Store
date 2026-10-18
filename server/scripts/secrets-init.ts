/**
 * Creates config/secrets.<env>.ejson with freshly generated master KEK, session secret and
 * import keypair, encrypted to a new ejson keypair whose private key goes to the keydir.
 *
 *   npm run secrets:init -- --env development --database-url postgres://...
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { encryptDocument, generateKeypair, stringify } from '../src/config/ejson.js';
import { secretsPath } from '../src/config/index.js';
import { arg, resolveKeydir, writePrivateKey } from './_shared.js';

// Target env and database URL (defaults suit local development).
const env = arg('env') ?? process.env.NODE_ENV ?? 'development';
const databaseUrl = arg('database-url') ?? 'postgresql://keyvault:keyvault@localhost:54320/keyvault';
const file = secretsPath(env);

// Never overwrite existing secrets.
if (existsSync(file)) {
  console.error(`${file} already exists; refusing to overwrite. Use secrets:edit instead.`);
  process.exit(1);
}

// New ejson keypair (private key saved to keydir) and import keypair.
const dir = resolveKeydir();
const ejsonKey = generateKeypair();
const importKey = generateKeypair();
writePrivateKey(dir, ejsonKey.publicKey, ejsonKey.privateKey);

// Fresh random KEK and session secret, encrypted to the new public key.
const doc = encryptDocument({
  _public_key: ejsonKey.publicKey,
  _active_kek: 'v1',
  master_kek: { v1: randomBytes(32).toString('base64') },
  session_secret: randomBytes(48).toString('base64url'),
  database_url: databaseUrl,
  import_keypair: { _public: importKey.publicKey, private: importKey.privateKey },
});
mkdirSync(path.dirname(file), { recursive: true });
writeFileSync(file, stringify(doc));

console.log(`Wrote ${file} (safe to commit — values are encrypted).`);
console.log(`ejson public key: ${ejsonKey.publicKey}`);
console.log(`Private key stored in ${dir}. Back it up offline; it is the root of trust for this environment.`);
