import express from 'express';
import supertest from 'supertest';
import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../../src/config/index.js';
import { AUTH_RATE_LIMIT_PER_MIN, authLimiterFor, makeAuthLimiter } from '../../src/features/auth/rateLimit.js';

// Minimal app with one rate-limited route.
function appWith(limiter: express.RequestHandler) {
  const app = express();
  app.post('/login', limiter, (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

// Per-IP limiter on login-style endpoints.
describe('auth rate limiter', () => {
  it('returns 429 rate_limited once the limit is exceeded', async () => {
    const app = appWith(makeAuthLimiter(2));
    await supertest(app).post('/login').expect(200);
    await supertest(app).post('/login').expect(200);
    const res = await supertest(app).post('/login').expect(429);
    expect(res.body).toEqual({ error: { code: 'rate_limited', message: expect.any(String) } });
    expect(res.headers['ratelimit-policy'] ?? res.headers['ratelimit']).toBeDefined();
  });

  it('applies the production limit outside NODE_ENV=test', async () => {
    expect(AUTH_RATE_LIMIT_PER_MIN).toBe(10);
    const app = appWith(authLimiterFor({ NODE_ENV: 'production' } as AppConfig));
    for (let i = 0; i < AUTH_RATE_LIMIT_PER_MIN; i++) await supertest(app).post('/login').expect(200);
    await supertest(app).post('/login').expect(429);
  });

  it('is relaxed under NODE_ENV=test', async () => {
    const app = appWith(authLimiterFor({ NODE_ENV: 'test' } as AppConfig));
    for (let i = 0; i < AUTH_RATE_LIMIT_PER_MIN + 2; i++) await supertest(app).post('/login').expect(200);
  });
});
