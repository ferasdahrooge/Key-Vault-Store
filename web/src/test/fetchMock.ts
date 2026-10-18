/** fetch stub for component and client tests. */
import { vi } from 'vitest';

// A canned response; routes can be one reply, a sequence, or a function.
export interface Reply {
  status?: number;
  body?: unknown;
}
type Route = Reply | Reply[] | ((init: RequestInit, url: string) => Reply);

// A recorded request, for assertions.
export interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * Test-only fetch stub. Keys are "METHOD /path" (query string ignored). An array replies in order
 * and repeats its last element. Unmatched requests get 404. `/api/csrf` defaults to a counter token.
 */
export function mockFetch(routes: Record<string, Route>) {
  const calls: Call[] = [];
  let csrf = 0;
  const fn = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = (init.method ?? 'GET').toUpperCase();
    const path = url.split('?')[0] ?? url;
    calls.push({
      method,
      url,
      headers: (init.headers ?? {}) as Record<string, string>,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    // Find the matching route (CSRF is answered automatically).
    let r = routes[`${method} ${path}`];
    if (!r && method === 'GET' && path === '/api/csrf') r = { body: { token: `csrf-${++csrf}` } };
    if (Array.isArray(r)) r = r.length > 1 ? r.shift() : r[0];
    if (typeof r === 'function') r = r(init, url);
    const reply: Reply = r ?? { status: 404, body: { error: { code: 'not_found', message: 'Not found' } } };
    const status = reply.status ?? 200;
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fn);
  return { fn, calls, callsTo: (key: string) => calls.filter((c) => `${c.method} ${c.url.split('?')[0]}` === key) };
}

// Builds an error reply in the server's error format.
export const apiError = (status: number, code: string, message = code): Reply => ({ status, body: { error: { code, message } } });
