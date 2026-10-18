import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SERVICE_API_AUTH_FAILURES_PER_IP } from '../../src/features/service-api/serviceApi.routes.js';
import { setupTestApp, type TestAgent, type TestHarness } from '../helpers/app.js';

let h: TestHarness;
let as: TestAgent;

beforeAll(async () => {
  h = await setupTestApp();
  const owner = await h.createUser({ isAdmin: true });
  as = await h.agentFor(owner);
  await as.post('/api/projects').send({ slug: 'app', name: 'App' }).expect(201);
  await as.post('/api/projects/app/envs/dev/secrets').send({ key: 'K', value: 'v' }).expect(201);
}, 60_000);
afterAll(() => h?.teardown());

const v1 = (token: string) => h.request().get('/api/v1/secrets').set('Authorization', `Bearer ${token}`);

// Brute-forcing service tokens from one IP gets blocked.
describe('per-IP limiter for failed bearer auth', () => {
  it('successful calls do not count; distinct bad tokens from one IP hit 429', async () => {
    const good = (await as.post('/api/projects/app/envs/dev/tokens').send({ name: 'ci', scopes: ['read'] }).expect(201)).body.token as string;
    for (let i = 0; i < 40; i++) await v1(good).expect(200); // successes are not counted
    for (let i = 0; i < SERVICE_API_AUTH_FAILURES_PER_IP; i++) {
      await v1('kv_st_' + randomBytes(20).toString('hex')).expect(401);
    }
    const blocked = await v1('kv_st_' + randomBytes(20).toString('hex')).expect(429);
    expect(blocked.body.error.code).toBe('rate_limited');
    await h.request().get('/api/v1/secrets').expect(429); // no bearer either
    await v1(good).expect(429); // the whole IP is blocked for the window
  }, 60_000);
});
