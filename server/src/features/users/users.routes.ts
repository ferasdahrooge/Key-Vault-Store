/** /api/users — directory lookup for the member picker (any authenticated user). */
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../auth/auth.middleware.js';
import { parse } from '../../core/http.js';
import type { AppDeps } from '../../core/types.js';

// Search text must be at least 2 characters.
const query = z.object({ q: z.string().trim().min(2).max(100) });

export function usersRouter(deps: AppDeps): Router {
  const { db } = deps;
  const r = Router();

  // GET /directory — find active users by name or email (max 20).
  r.get('/directory', requireAuth(db), async (req, res) => {
    const { q } = parse(query, req.query);
    const users = await db.user.findMany({
      where: {
        status: 'active',
        OR: [{ email: { contains: q, mode: 'insensitive' } }, { name: { contains: q, mode: 'insensitive' } }],
      },
      select: { id: true, email: true, name: true },
      orderBy: [{ name: 'asc' }, { email: 'asc' }],
      take: 20,
    });
    res.json({ users });
  });

  return r;
}
