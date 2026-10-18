import type { NextFunction, Request, Response } from 'express';
import { ZodError, type ZodType } from 'zod';

// Error carrying an HTTP status and a stable machine-readable code.
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}

// Shorthand constructors for the most common HTTP errors.
export const notFound = () => new HttpError(404, 'not_found', 'Not found');
export const forbidden = (msg = 'Forbidden') => new HttpError(403, 'forbidden', msg);
export const badRequest = (msg = 'Bad request') => new HttpError(400, 'bad_request', msg);

/** Parses and validates input; throws 400 with field paths (never echoes values). */
export function parse<T>(schema: ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input);
  if (!r.success) {
    const fields = r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    const err = new HttpError(400, 'validation_error', 'Invalid request');
    (err as HttpError & { fields: unknown }).fields = fields;
    throw err;
  }
  return r.data;
}

/** Final error handler. Returns { error: { code, message, fields? } }. */
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  // Known application errors: return their status and code as-is.
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message, fields: (err as any).fields } });
    return;
  }
  // Stray validation errors: generic 400 without echoing input.
  if (err instanceof ZodError) {
    res.status(400).json({ error: { code: 'validation_error', message: 'Invalid request' } });
    return;
  }
  // Client errors raised by middleware (e.g. body-parser, CSRF) keep their 4xx status.
  const status = (err as { status?: number }).status;
  if (status && status >= 400 && status < 500) {
    res.status(status).json({ error: { code: (err as { code?: string }).code ?? 'bad_request', message: 'Request rejected' } });
    return;
  }
  // Anything else is a bug: log it and return a generic 500.
  req.log?.error({ err }, 'unhandled error');
  res.status(500).json({ error: { code: 'internal', message: 'Internal error' } });
}
