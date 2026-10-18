/**
 * Integration-test harness. Requires the db-test container:  docker compose up -d db-test
 * Each test file gets a fresh schema (migrations via `prisma db push` into a unique schema).
 *
 *   const h = await setupTestApp();
 *   const alice = await h.createUser({ email: 'a@x.io' });
 *   const as = await h.agentFor(alice);           // logged in, MFA fresh, CSRF header set
 *   await as.post('/api/projects').send({...}).expect(201);
 *   afterAll(h.teardown);
 */
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import supertest from 'supertest';
import { generateKeypair } from '../../src/config/ejson.js';
import type { AppConfig } from '../../src/config/index.js';
import { clearDekCache, initCrypto } from '../../src/crypto/index.js';
import { createApp } from '../../src/app.js';
import { createDb, type Db } from '../../src/core/db.js';

// Server package folder and the test database URL.
const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BASE_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://keyvault:keyvault@localhost:54329/keyvault_test';

// A supertest agent that already carries a CSRF token.
export type TestAgent = ReturnType<typeof supertest.agent> & { csrf: string };

export const TEST_GOOGLE_CLIENT_ID = 'kv-test.apps.googleusercontent.com';

/** `google: true` configures a Google OAuth client (tests stub fetch for its token endpoint). */
export async function setupTestApp(opts: { google?: boolean } = {}) {
  // Create an isolated schema for this test file and push the Prisma schema into it.
  const schema = `t_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const databaseUrl = `${BASE_URL}?schema=${schema}`;
  execFileSync('npx', ['prisma', 'db', 'push', '--skip-generate', '--accept-data-loss'], {
    cwd: serverDir,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'pipe',
  });

  // Build an in-memory config with random keys (no ejson files needed).
  const importKp = generateKeypair();
  const masterKeks = { v1: randomBytes(32).toString('base64') };
  const config = {
    NODE_ENV: 'test',
    PORT: 0,
    APP_ORIGIN: 'http://localhost:8200',
    RP_ID: 'localhost',
    RP_NAME: 'Key Vault Test',
    TRUST_PROXY: 0,
    isProd: false,
    secureTransport: false,
    sessionCookieName: 'kv.sid',
    secretsFile: '(test)',
    secrets: {
      _public_key: generateKeypair().publicKey,
      _active_kek: 'v1',
      master_kek: masterKeks,
      session_secret: randomBytes(48).toString('base64url'),
      database_url: databaseUrl,
      import_keypair: { _public: importKp.publicKey, private: importKp.privateKey },
      ...(opts.google ? { google_oauth: { client_id: TEST_GOOGLE_CLIENT_ID, client_secret: 'test-secret' } } : {}),
    },
  } as AppConfig;

  // Start crypto and the app with the test-login route enabled.
  clearDekCacheSafe();
  initCrypto({ masterKeks, activeKek: 'v1' });
  const db = createDb(databaseUrl);
  const { app, close } = createApp({ config, db, enableTestLogin: true });

  // Returns an agent logged in as `user` (optionally with an older MFA time).
  async function agentFor(user: { id: string }, opts: { mfaAgoMs?: number } = {}): Promise<TestAgent> {
    const agent = supertest.agent(app) as TestAgent;
    let csrf = (await agent.get('/api/csrf').expect(200)).body.token as string;
    await agent.post('/api/__test/login').set('x-csrf-token', csrf).send({ userId: user.id, mfaAgoMs: opts.mfaAgoMs }).expect(200);
    csrf = (await agent.get('/api/csrf').expect(200)).body.token as string; // session regenerated
    agent.set('x-csrf-token', csrf);
    agent.csrf = csrf;
    return agent;
  }

  // Inserts an active user directly in the database.
  async function createUser(data: { email?: string; name?: string; isAdmin?: boolean } = {}) {
    return db.user.create({
      data: {
        email: data.email ?? `${randomUUID()}@test.local`,
        name: data.name ?? 'Test User',
        isAdmin: data.isAdmin ?? false,
        status: 'active',
      },
    });
  }

  // Closes the app and drops the test schema.
  async function teardown() {
    await close();
    await db.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await db.$disconnect();
  }

  return { app, db, config, importKp, agentFor, createUser, teardown, request: () => supertest(app) };
}

// Clears cached DEKs if crypto was already initialised.
function clearDekCacheSafe() {
  try {
    clearDekCache();
  } catch {
    /* not initialised yet */
  }
}

// Type of the object returned by setupTestApp.
export type TestHarness = Awaited<ReturnType<typeof setupTestApp>>;
export type { Db };
