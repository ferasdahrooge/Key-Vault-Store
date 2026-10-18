import { pino } from 'pino';

/** Redacts anything that could carry secret material. */
export const logger = pino({
  // Silent in tests unless LOG_LEVEL overrides it.
  level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'test' ? 'silent' : 'info'),
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["x-csrf-token"]',
      'res.headers["set-cookie"]',
      '*.password',
      '*.value',
      '*.values',
      '*.token',
      '*.secret',
      '*.code',
    ],
    censor: '[redacted]',
  },
});

/**
 * Bearer material that travels in the URL (invite tokens: /invite/<t>, /api/invites/<t>[/accept];
 * the Google authorization code and state on /login/google/callback?...) is replaced before the
 * request line is logged. Header/body redaction above doesn't cover URLs.
 */
export function redactUrl(url: string): string {
  return url
    .replace(/^(\/(?:api\/)?invites?\/)[^/?#]+/, '$1[redacted]')
    .replace(/^(\/login\/google\/callback\?).+/, '$1[redacted]');
}
