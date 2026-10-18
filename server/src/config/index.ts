/**
 * Boot-time configuration. Secrets come exclusively from config/secrets.<env>.ejson, decrypted
 * in memory with the private key from the ejson keydir. If anything is missing or fails to
 * decrypt the process refuses to start (fail closed). Plaintext never touches disk or env vars.
 */
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { DEFAULT_KEYDIR, decryptFile } from './ejson.js';

// Validation helpers for hex public keys and base64 32-byte keys.
const HEX32 = /^[0-9a-f]{64}$/;
const b64Key = z
  .string()
  .refine((s) => Buffer.from(s, 'base64').length === 32, 'must be 32 bytes, base64-encoded');

// Shape the decrypted secrets.<env>.ejson file must have.
export const secretsSchema = z.object({
  _public_key: z.string().regex(HEX32),
  _active_kek: z.string().min(1),
  master_kek: z.record(z.string(), b64Key),
  session_secret: z.string().min(32),
  database_url: z.string().url(),
  import_keypair: z.object({
    _public: z.string().regex(HEX32),
    private: z.string().regex(HEX32),
  }),
  /** Optional: enables "Sign in with Google" (an OAuth 2.0 web client from Google Cloud console). */
  google_oauth: z
    .object({
      client_id: z.string().regex(/^[\w.-]+\.apps\.googleusercontent\.com$/, 'must be a Google OAuth client id'),
      client_secret: z.string().min(1),
    })
    .optional(),
}).refine((s) => s._active_kek in s.master_kek, { message: '_active_kek must name a key in master_kek' });

export type Secrets = z.infer<typeof secretsSchema>;

// Non-secret settings read from environment variables, with defaults.
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(8200),
  APP_ORIGIN: z.string().url().default('http://localhost:8200'),
  RP_ID: z.string().default('localhost'),
  RP_NAME: z.string().default('Key Vault'),
  SECRETS_FILE: z.string().optional(),
  TRUST_PROXY: z.coerce.number().int().default(0),
  /** Restricts Google sign-in to one Google Workspace domain (the ID token's `hd` claim). */
  GOOGLE_HOSTED_DOMAIN: z.preprocess((v) => (v === '' ? undefined : v), z.string().trim().toLowerCase().min(1).optional()),
});

// Final frozen config object passed throughout the app.
export type AppConfig = Readonly<
  z.infer<typeof envSchema> & {
    secrets: Readonly<Secrets>;
    isProd: boolean;
    secretsFile: string;
    /** APP_ORIGIN is https: Secure + __Host- cookies, HSTS, upgrade-insecure-requests. */
    secureTransport: boolean;
    sessionCookieName: string;
  }
>;

// Absolute path of the repository root (three levels up from this file).
export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

// Location of the ejson secrets file for an environment.
export function secretsPath(env: string, override?: string): string {
  return override ? path.resolve(override) : path.join(repoRoot, 'config', `secrets.${env}.ejson`);
}

/** EJSON_KEYDIR wins; otherwise /opt/ejson/keys in production and ~/.ejson/keys elsewhere. */
export function resolveKeydir(nodeEnv = process.env.NODE_ENV, environ: NodeJS.ProcessEnv = process.env): string {
  if (environ.EJSON_KEYDIR) return environ.EJSON_KEYDIR;
  return nodeEnv === 'production' ? DEFAULT_KEYDIR : path.join(homedir(), '.ejson', 'keys');
}

// Reads env vars, decrypts secrets, validates both and returns a frozen config.
export function loadConfig(environ: NodeJS.ProcessEnv = process.env): AppConfig {
  const env = envSchema.parse(environ);
  const secretsFile = secretsPath(env.NODE_ENV, env.SECRETS_FILE);
  const raw = decryptFile(secretsFile, { strict: true, keydir: resolveKeydir(env.NODE_ENV, environ) });
  const parsed = secretsSchema.safeParse(raw);
  if (!parsed.success) {
    // Report only paths, never values.
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(`invalid secrets in ${secretsFile}:\n  ${issues.join('\n  ')}`);
  }
  const isProd = env.NODE_ENV === 'production';
  const secureTransport = transportIsSecure(env.APP_ORIGIN, isProd);
  return deepFreeze({
    ...env,
    secrets: parsed.data,
    isProd,
    secretsFile,
    secureTransport,
    sessionCookieName: secureTransport ? '__Host-kv.sid' : 'kv.sid',
  });
}

// Hosts where plain HTTP is acceptable.
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Cookie/HSTS security follows the origin's scheme. Plain HTTP is only tolerated on loopback
 * (local docker compose); a production origin on any other host must be https or we refuse to start.
 */
export function transportIsSecure(appOrigin: string, isProd: boolean): boolean {
  const url = new URL(appOrigin);
  if (url.protocol === 'https:') return true;
  if (isProd && !LOOPBACK.has(url.hostname)) {
    throw new Error(`APP_ORIGIN ${appOrigin} must use https in production (plain http is allowed only on localhost)`);
  }
  return false;
}

// Recursively freezes the config so nothing can mutate it at runtime.
function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object') {
    for (const v of Object.values(o)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
}
