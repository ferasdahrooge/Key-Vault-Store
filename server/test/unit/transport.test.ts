import { describe, expect, it } from 'vitest';
import { transportIsSecure } from '../../src/config/index.js';

// When cookies/HSTS must be secure, and when startup is refused.
describe('transportIsSecure', () => {
  it('https origins always get secure cookies/HSTS', () => {
    expect(transportIsSecure('https://vault.example.com', true)).toBe(true);
    expect(transportIsSecure('https://localhost:8443', false)).toBe(true);
  });

  it('plain http is allowed on loopback, in any mode', () => {
    for (const o of ['http://localhost:8200', 'http://127.0.0.1:8200', 'http://[::1]:8200']) {
      expect(transportIsSecure(o, true)).toBe(false);
      expect(transportIsSecure(o, false)).toBe(false);
    }
  });

  it('refuses plain http for a non-loopback production origin', () => {
    expect(() => transportIsSecure('http://vault.example.com', true)).toThrow(/must use https/);
    expect(transportIsSecure('http://vault.example.com', false)).toBe(false);
  });
});
