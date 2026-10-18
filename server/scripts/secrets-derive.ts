/**
 * Creates config/secrets.<to>.ejson from secrets.<from>.ejson with a different database_url and
 * everything else (KEKs, session secret, import keypair) unchanged. The data stays readable because
 * the master KEK is the same. Values are re-encrypted to the same ejson public key, so the same
 * private key decrypts both files.
 *
 *   npm run secrets:derive -- --from development --to compose \
 *     --database-url postgresql://keyvault:keyvault@db:5432/keyvault [--force]
 *
 * Intended for local stacks (docker compose). Real deployments should use their own secrets:init.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { decryptFile, encryptDocument, stringify, type JsonObject } from '../src/config/ejson.js';
import { secretsPath, secretsSchema } from '../src/config/index.js';
import { arg, resolveKeydir } from './_shared.js';

// Parse arguments.
const from = arg('from') ?? 'development';
const to = arg('to');
const databaseUrl = arg('database-url');
if (!to || !databaseUrl) {
  console.error('usage: npm run secrets:derive -- --from development --to compose --database-url <url> [--force]');
  process.exit(2);
}

// Refuse to overwrite an existing target unless --force.
const src = secretsPath(from);
const dest = secretsPath(to);
if (existsSync(dest) && !process.argv.includes('--force')) {
  console.error(`${dest} already exists; pass --force to overwrite.`);
  process.exit(1);
}

// Decrypt the source, swap the database URL, validate, re-encrypt and write.
const plain = decryptFile(src, { strict: true, keydir: resolveKeydir() }) as JsonObject;
const derived = { ...plain, database_url: databaseUrl };
const check = secretsSchema.safeParse(derived);
if (!check.success) {
  console.error('derived secrets are invalid:\n  ' + check.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n  '));
  process.exit(1);
}
writeFileSync(dest, stringify(encryptDocument(derived)));
console.log(`Wrote ${dest} (encrypted to ${String(plain._public_key).slice(0, 12)}…; same private key as ${from}).`);
