import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, resetClientHandlers, resetCsrfToken, setClientHandlers } from './client';
import { apiError, mockFetch } from '@/test/fetchMock';

afterEach(() => {
  resetClientHandlers();
  resetCsrfToken();
  vi.unstubAllGlobals();
});

// CSRF retry, re-auth retry and auth redirects in the fetch wrapper.
describe('api client', () => {
  it('refetches the CSRF token and retries once on EBADCSRFTOKEN', async () => {
    const m = mockFetch({ 'POST /api/thing': [apiError(403, 'EBADCSRFTOKEN'), { body: { ok: true } }] });
    await expect(api.post('/api/thing', { a: 1 })).resolves.toEqual({ ok: true });
    const posts = m.callsTo('POST /api/thing');
    expect(posts).toHaveLength(2);
    expect(posts[0]?.headers['x-csrf-token']).toBe('csrf-1');
    expect(posts[1]?.headers['x-csrf-token']).toBe('csrf-2');
  });

  it('does not loop on repeated CSRF failures', async () => {
    const m = mockFetch({ 'POST /api/thing': [apiError(403, 'EBADCSRFTOKEN')] });
    await expect(api.post('/api/thing')).rejects.toBeInstanceOf(ApiError);
    expect(m.callsTo('POST /api/thing')).toHaveLength(2);
  });

  it('asks for re-auth on reauth_required and retries the request', async () => {
    const requestReauth = vi.fn(async () => true);
    setClientHandlers({ requestReauth });
    const m = mockFetch({ 'DELETE /api/x': [apiError(401, 'reauth_required'), { body: { ok: true } }] });
    await expect(api.del('/api/x')).resolves.toEqual({ ok: true });
    expect(requestReauth).toHaveBeenCalledTimes(1);
    expect(m.callsTo('DELETE /api/x')).toHaveLength(2);
  });

  it('coalesces concurrent re-auth prompts', async () => {
    let resolve!: (ok: boolean) => void;
    const requestReauth = vi.fn(() => new Promise<boolean>((r) => (resolve = r)));
    setClientHandlers({ requestReauth });
    mockFetch({ 'POST /api/a': [apiError(401, 'reauth_required'), { body: 1 }], 'POST /api/b': [apiError(401, 'reauth_required'), { body: 2 }] });
    const both = Promise.all([api.post('/api/a'), api.post('/api/b')]);
    await vi.waitFor(() => expect(requestReauth).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    resolve(true);
    await expect(both).resolves.toEqual([1, 2]);
    expect(requestReauth).toHaveBeenCalledTimes(1);
  });

  it('throws when re-auth is cancelled', async () => {
    setClientHandlers({ requestReauth: async () => false });
    mockFetch({ 'POST /api/x': [apiError(401, 'reauth_required')] });
    await expect(api.post('/api/x')).rejects.toMatchObject({ code: 'reauth_required' });
  });

  it('calls onUnauthenticated on 401 and onEnrollmentRequired on enrollment mode', async () => {
    const onUnauthenticated = vi.fn();
    const onEnrollmentRequired = vi.fn();
    setClientHandlers({ onUnauthenticated, onEnrollmentRequired });
    mockFetch({ 'GET /api/a': apiError(401, 'unauthenticated'), 'GET /api/b': apiError(403, 'mfa_enrollment_required') });
    await expect(api.get('/api/a')).rejects.toBeInstanceOf(ApiError);
    await expect(api.get('/api/b')).rejects.toBeInstanceOf(ApiError);
    expect(onUnauthenticated).toHaveBeenCalledWith('unauthenticated');
    expect(onEnrollmentRequired).toHaveBeenCalledTimes(1);
  });
});
