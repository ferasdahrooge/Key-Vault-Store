/**
 * Fetch wrapper for the browser API.
 *
 * - same-origin cookies, JSON bodies
 * - lazily fetched CSRF token sent as `x-csrf-token` on every non-GET request
 * - 403 EBADCSRFTOKEN: refetch the token and retry once
 * - 401 reauth_required: ask the registered re-auth handler (global modal), then retry
 * - 401 unauthenticated / session_expired: notify (redirect to /login)
 * - 403 mfa_enrollment_required: notify (redirect to /enroll)
 */

// A field-level validation error from the server.
export interface ApiErrorField {
  path: string;
  message: string;
}

// Error thrown for every non-2xx API response.
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fields?: ApiErrorField[];

  constructor(status: number, code: string, message: string, fields?: ApiErrorField[]) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}

// Type guard, optionally matching a specific error code.
export function isApiError(e: unknown, code?: string): e is ApiError {
  return e instanceof ApiError && (code === undefined || e.code === code);
}

// Callbacks the app registers so the client can redirect or prompt.
export interface ClientHandlers {
  /** Session missing or expired. */
  onUnauthenticated: (code: string) => void;
  /** Session is in MFA enrollment mode. */
  onEnrollmentRequired: () => void;
  /** Show the re-auth UI. Resolve true when the user re-authenticated, false if they cancelled. */
  requestReauth: () => Promise<boolean>;
}

// Defaults until the app registers real handlers.
const noopHandlers: ClientHandlers = {
  onUnauthenticated: () => {},
  onEnrollmentRequired: () => {},
  requestReauth: async () => false,
};

let handlers: ClientHandlers = noopHandlers;

// Registers (some of) the handlers.
export function setClientHandlers(h: Partial<ClientHandlers>): void {
  handlers = { ...handlers, ...h };
}

// Restores the no-op handlers (used in tests).
export function resetClientHandlers(): void {
  handlers = noopHandlers;
}

// ---------------------------------------------------------------- CSRF

// Cached CSRF token and the in-flight request for it.
let csrfToken: string | null = null;
let csrfInflight: Promise<string> | null = null;

/** Forget the CSRF token. Call after login, logout, re-auth and invite accept (the session is regenerated). */
export function resetCsrfToken(): void {
  csrfToken = null;
  csrfInflight = null;
}

// Returns the cached token or fetches one (concurrent callers share one request).
async function getCsrfToken(): Promise<string> {
  if (csrfToken) return csrfToken;
  if (!csrfInflight) {
    const p = (async () => {
      const res = await fetch('/api/csrf', {
        method: 'GET',
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
        cache: 'no-store',
      });
      if (!res.ok) throw await toApiError(res);
      const data = (await res.json()) as { token?: unknown };
      if (typeof data.token !== 'string') throw new ApiError(res.status, 'bad_csrf_response', 'Could not get CSRF token');
      return data.token;
    })();
    csrfInflight = p;
    p.then(
      (t) => {
        if (csrfInflight === p) {
          csrfToken = t;
          csrfInflight = null;
        }
      },
      () => {
        if (csrfInflight === p) csrfInflight = null;
      },
    );
  }
  return csrfInflight;
}

// ---------------------------------------------------------------- request

// Query-string values; empty ones are dropped.
export type Query = Record<string, string | number | boolean | undefined | null>;

export interface RequestOptions {
  body?: unknown;
  query?: Query;
  /**
   * When false, auth-related errors (401/403 special codes) are thrown to the caller
   * without redirects or the re-auth modal. Used by the login/MFA/re-auth endpoints themselves.
   */
  auth?: boolean;
  /** Response handling. Defaults to json. */
  responseType?: 'json' | 'blob' | 'text';
  signal?: AbortSignal;
}

// Appends non-empty query params to a path.
export function buildUrl(path: string, query?: Query): string {
  if (!query) return path;
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue;
    sp.set(k, String(v));
  }
  const qs = sp.toString();
  return qs ? `${path}${path.includes('?') ? '&' : '?'}${qs}` : path;
}

// Converts an error response into an ApiError.
async function toApiError(res: Response): Promise<ApiError> {
  let code = `http_${res.status}`;
  let message = res.statusText || 'Request failed';
  let fields: ApiErrorField[] | undefined;
  try {
    const data = (await res.json()) as { error?: { code?: unknown; message?: unknown; fields?: unknown } };
    if (data?.error) {
      if (typeof data.error.code === 'string') code = data.error.code;
      if (typeof data.error.message === 'string') message = data.error.message;
      if (Array.isArray(data.error.fields)) fields = data.error.fields as ApiErrorField[];
    }
  } catch {
    // non-JSON error body
  }
  return new ApiError(res.status, code, message, fields);
}

// Shared promise while the re-auth modal is open.
let reauthInflight: Promise<boolean> | null = null;

/** Coalesces concurrent re-auth prompts into one modal. */
function reauthOnce(): Promise<boolean> {
  if (!reauthInflight) {
    reauthInflight = handlers.requestReauth().finally(() => {
      reauthInflight = null;
    });
  }
  return reauthInflight;
}

// Core request function with CSRF, re-auth and redirect handling.
export async function request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
  const { body, query, auth = true, responseType = 'json', signal } = opts;
  const url = buildUrl(path, query);
  const upper = method.toUpperCase();
  const needsCsrf = upper !== 'GET' && upper !== 'HEAD';

  let csrfRetried = false;
  let reauthRetried = false;

  for (;;) {
    const headers: Record<string, string> = { accept: responseType === 'json' ? 'application/json' : '*/*' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (needsCsrf) headers['x-csrf-token'] = await getCsrfToken();

    const res = await fetch(url, {
      method: upper,
      credentials: 'same-origin',
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      cache: 'no-store',
      signal,
    });

    // Success: parse the body according to responseType.
    if (res.ok) {
      if (res.status === 204) return undefined as T;
      if (responseType === 'blob') return (await res.blob()) as T;
      if (responseType === 'text') return (await res.text()) as T;
      const text = await res.text();
      return (text ? JSON.parse(text) : undefined) as T;
    }

    const err = await toApiError(res);

    // Stale CSRF token: fetch a new one and retry once.
    if (err.status === 403 && err.code === 'EBADCSRFTOKEN' && !csrfRetried) {
      csrfRetried = true;
      resetCsrfToken();
      continue;
    }

    if (auth) {
      // Needs recent MFA: show the re-auth modal, then retry.
      if (err.status === 401 && err.code === 'reauth_required' && !reauthRetried) {
        reauthRetried = true;
        const ok = await reauthOnce();
        if (ok) {
          resetCsrfToken();
          continue;
        }
        throw err;
      }
      if (err.status === 401 && (err.code === 'unauthenticated' || err.code === 'session_expired')) {
        resetCsrfToken();
        handlers.onUnauthenticated(err.code);
      } else if (err.status === 403 && err.code === 'mfa_enrollment_required') {
        handlers.onEnrollmentRequired();
      }
    }
    throw err;
  }
}

// Convenience methods per HTTP verb.
export const api = {
  get: <T>(path: string, opts?: Omit<RequestOptions, 'body'>) => request<T>('GET', path, opts),
  post: <T>(path: string, body?: unknown, opts?: Omit<RequestOptions, 'body'>) =>
    request<T>('POST', path, { ...opts, body }),
  put: <T>(path: string, body?: unknown, opts?: Omit<RequestOptions, 'body'>) =>
    request<T>('PUT', path, { ...opts, body }),
  patch: <T>(path: string, body?: unknown, opts?: Omit<RequestOptions, 'body'>) =>
    request<T>('PATCH', path, { ...opts, body }),
  del: <T>(path: string, opts?: Omit<RequestOptions, 'body'>) => request<T>('DELETE', path, opts),
};

/** Encode a route segment (project/env slugs, ids). */
export const seg = (s: string) => encodeURIComponent(s);

/** Friendly copy for the error codes in docs/API.md. */
export const ERROR_MESSAGES: Record<string, string> = {
  invalid_credentials: 'Invalid email or password. Repeated failures temporarily lock the account.',
  account_locked: 'This account is temporarily locked after too many failed attempts. Try again later or ask an admin to unlock it.',
  invalid_code: 'That code is not valid. Check it and try again.',
  code_already_used: 'That code was just used. Wait for your app to show the next one.',
  invalid_passkey: 'Passkey verification failed.',
  google_login_failed: 'That Google account can’t be used to sign in here. Ask an admin to check that your Key Vault account uses the same email.',
  google_flow_expired: 'Google sign-in expired. Please try again.',
  rate_limited: 'Too many requests. Please wait a moment and try again.',
  weak_password: 'That password does not meet the password policy.',
  user_exists: 'An account with that email already exists.',
  totp_already_enrolled: 'An authenticator app is already set up.',
  last_factor: 'You cannot remove your only sign-in factor. Add another one first.',
  cannot_modify_self: 'You cannot disable or demote your own account.',
  last_admin: 'At least one active admin must remain.',
  user_invited: 'This user has not accepted their invite yet.',
  reauth_required: 'Please confirm it is you to continue.',
  forbidden: 'You do not have permission to do that.',
  not_found: 'Not found.',
  EBADCSRFTOKEN: 'Your session token expired. Please retry.',
};

/** Human readable message for an error; never includes request values. */
export function errorMessage(e: unknown, fallback = 'Something went wrong. Please try again.'): string {
  if (e instanceof ApiError) {
    const known = ERROR_MESSAGES[e.code];
    if (known) return known;
    if (e.code === 'validation_error' && e.fields?.length) {
      return e.fields.map((f) => (f.path ? `${f.path}: ${f.message}` : f.message)).join('; ');
    }
    if (e.status >= 500) return fallback;
    return e.message || fallback;
  }
  return fallback;
}
