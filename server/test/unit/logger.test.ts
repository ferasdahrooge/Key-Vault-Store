import { describe, expect, it } from 'vitest';
import { redactUrl } from '../../src/core/logger.js';

// Sensitive URL parts must never reach the logs.
describe('redactUrl', () => {
  it('hides invite tokens in API and SPA paths', () => {
    expect(redactUrl('/api/invites/abcDEF_123-xyz')).toBe('/api/invites/[redacted]');
    expect(redactUrl('/api/invites/abcDEF_123-xyz/accept')).toBe('/api/invites/[redacted]/accept');
    expect(redactUrl('/invite/abcDEF_123-xyz?x=1')).toBe('/invite/[redacted]?x=1');
  });

  it('hides the Google authorization code and state', () => {
    expect(redactUrl('/login/google/callback?state=s&code=4/0Abc')).toBe('/login/google/callback?[redacted]');
    expect(redactUrl('/login/google/callback')).toBe('/login/google/callback');
  });

  it('leaves other URLs alone', () => {
    expect(redactUrl('/api/invites')).toBe('/api/invites');
    expect(redactUrl('/api/projects/p/envs/e')).toBe('/api/projects/p/envs/e');
    expect(redactUrl('/healthz')).toBe('/healthz');
  });
});
