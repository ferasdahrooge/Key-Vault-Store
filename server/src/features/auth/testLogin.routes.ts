/** TEST ONLY. Mounted solely when deps.enableTestLogin (createApp refuses it in production). */
import { Router } from 'express';
import { z } from 'zod';
import { parse } from '../../core/http.js';
import type { AppDeps } from '../../core/types.js';

export function testLoginRouter(_deps: AppDeps): Router {
  const r = Router();
  // POST /login — instantly log in as any user, optionally with an old MFA time.
  r.post('/login', (req, res) => {
    const { userId, mfaAgoMs } = parse(z.object({ userId: z.string().uuid(), mfaAgoMs: z.number().optional() }), req.body);
    req.session.regenerate((err) => {
      if (err) throw err;
      req.session.userId = userId;
      req.session.loginAt = Date.now();
      req.session.mfaAt = Date.now() - (mfaAgoMs ?? 0);
      res.json({ ok: true });
    });
  });
  return r;
}
