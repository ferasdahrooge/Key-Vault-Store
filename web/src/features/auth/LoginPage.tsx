/**
 * Sign-in: password (or Google) step, then a second factor (authenticator code, passkey or recovery
 * code). After Google, GoogleCallbackPage navigates back here with the MFA methods in router state.
 */
import { useState, type FormEvent } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getAuthProviders, googleStart, login, mfaPasskeyOptions, mfaPasskeyVerify, mfaRecovery, mfaTotp } from './auth.api';
import { errorMessage, isApiError } from '@/shared/api/client';
import type { MfaMethod } from '@/shared/api/types';
import { AuthCard } from './AuthCard';
import { useToast } from '@/shared/components/Toast';
import { Alert, Button, Input, cx } from '@/shared/components/ui';
import { externalRedirect, safeNext } from '@/shared/lib/navigation';
import { otpDigits } from './otp';
import { authenticate, webauthnErrorMessage, webauthnSupported } from './webauthn';

// Tab labels for each second-factor method.
const METHOD_LABEL: Record<MfaMethod, string> = { passkey: 'Passkey', totp: 'Authenticator app', recovery: 'Recovery code' };

/** Router state GoogleCallbackPage hands over: the MFA step to show, or an error. */
export interface LoginLocationState {
  mfaMethods?: MfaMethod[];
  error?: string;
}

/** Methods this browser can use, and the one to preselect (passkey, then TOTP). */
function usableMethods(methods: MfaMethod[]): { list: MfaMethod[]; initial: MfaMethod } {
  const usable = methods.filter((m) => m !== 'passkey' || webauthnSupported());
  const list = usable.length ? usable : methods;
  return { list, initial: list.includes('passkey') ? 'passkey' : list.includes('totp') ? 'totp' : (list[0] ?? 'recovery') };
}

/** Login-specific wording for lockout and rate limiting; everything else uses errorMessage. */
function loginError(e: unknown): string {
  if (isApiError(e, 'account_locked') || (isApiError(e) && e.status === 423)) {
    return 'This account is temporarily locked after too many failed attempts. Try again later or ask an admin to unlock it.';
  }
  if (isApiError(e, 'rate_limited')) return 'Too many attempts. Please wait a moment and try again.';
  if (isApiError(e) && e.status < 500) return 'Invalid email or password. Repeated failures temporarily lock the account.';
  return 'Could not sign in right now. Please try again.';
}

// Two-step sign-in page.
export function LoginPage() {
  const [sp] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const qc = useQueryClient();
  const toast = useToast();
  // If we arrived from Google, start directly at the MFA step.
  const handoff = (location.state ?? {}) as LoginLocationState;
  const fromGoogle = handoff.mfaMethods?.length ? usableMethods(handoff.mfaMethods) : null;
  const [step, setStep] = useState<'credentials' | 'mfa'>(fromGoogle ? 'mfa' : 'credentials');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [methods, setMethods] = useState<MfaMethod[]>(fromGoogle?.list ?? []);
  const [method, setMethod] = useState<MfaMethod>(fromGoogle?.initial ?? 'totp');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(handoff.error ?? null);
  // Why the user landed here (idle / expired) and which providers are enabled.
  const reason = sp.get('reason');
  const providers = useQuery({ queryKey: ['auth-providers'], queryFn: getAuthProviders, staleTime: Infinity, retry: false });

  // Logged in: clear cached data and go to ?next (or home).
  const done = () => {
    qc.clear();
    void navigate(safeNext(sp.get('next')), { replace: true });
  };

  // Step 1: email + password.
  const onCredentials = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await login(email.trim(), password);
      setPassword('');
      if ('mfaEnrollmentRequired' in r) {
        qc.clear();
        void navigate('/enroll', { replace: true });
        return;
      }
      const { list, initial } = usableMethods(r.methods);
      setMethods(list);
      setMethod(initial);
      setStep('mfa');
    } catch (err) {
      setError(loginError(err));
    } finally {
      setBusy(false);
    }
  };

  // Step 1 alternative: redirect to Google.
  const onGoogle = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = sp.get('next');
      const { url } = await googleStart(next ? safeNext(next) : undefined);
      externalRedirect(url);
    } catch (err) {
      setBusy(false);
      setError(loginError(err));
    }
  };

  // Step 2: authenticator or recovery code.
  const onCode = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (method === 'recovery') {
        const r = await mfaRecovery(code.trim());
        toast.info(`Recovery code used. ${r.remainingCodes} left.`);
      } else {
        await mfaTotp(code.trim());
      }
      done();
    } catch (err) {
      setBusy(false);
      setError(isApiError(err, 'account_locked') ? loginError(err) : errorMessage(err, 'That code is not valid.'));
    }
  };

  // Step 2: passkey.
  const onPasskey = async () => {
    setBusy(true);
    setError(null);
    try {
      const opts = await mfaPasskeyOptions();
      await mfaPasskeyVerify(await authenticate(opts));
      done();
    } catch (err) {
      setBusy(false);
      setError(webauthnErrorMessage(err) ?? (isApiError(err, 'account_locked') ? loginError(err) : errorMessage(err)));
    }
  };

  return (
    <AuthCard
      title={step === 'credentials' ? 'Sign in' : 'Two-step verification'}
      subtitle={step === 'mfa' ? 'Confirm it’s you with a second factor.' : undefined}
    >
      <div className="space-y-4">
        {reason === 'idle' && step === 'credentials' && <Alert kind="info">You were signed out after 15 minutes of inactivity.</Alert>}
        {reason === 'expired' && step === 'credentials' && <Alert kind="info">Your session expired. Please sign in again.</Alert>}
        {error && <Alert>{error}</Alert>}

        {step === 'credentials' ? (
          <form onSubmit={onCredentials} className="space-y-4">
            <Input label="Email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
            <Input
              label="Password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <Button type="submit" loading={busy} className="w-full">
              Continue
            </Button>
            {providers.data?.google && (
              <>
                <div className="flex items-center gap-3 text-xs text-stone-500 dark:text-stone-400" aria-hidden="true">
                  <span className="h-px flex-1 bg-stone-200 dark:bg-stone-700" />
                  or
                  <span className="h-px flex-1 bg-stone-200 dark:bg-stone-700" />
                </div>
                <Button type="button" variant="secondary" onClick={onGoogle} disabled={busy} className="w-full">
                  <GoogleIcon />
                  Continue with Google
                </Button>
              </>
            )}
          </form>
        ) : (
          <div className="space-y-4">
            {methods.length > 1 && (
              <div role="tablist" aria-label="Verification method" className="flex flex-wrap gap-1">
                {methods.map((m) => (
                  <button
                    key={m}
                    type="button"
                    role="tab"
                    aria-selected={m === method}
                    onClick={() => {
                      setMethod(m);
                      setCode('');
                      setError(null);
                    }}
                    className={cx(
                      'rounded-md px-3 py-1.5 text-sm',
                      m === method ? 'bg-brand-600 text-white' : 'bg-stone-100 text-stone-700 dark:bg-stone-800 dark:text-stone-200',
                    )}
                  >
                    {METHOD_LABEL[m]}
                  </button>
                ))}
              </div>
            )}
            {method === 'passkey' ? (
              <Button onClick={onPasskey} loading={busy} className="w-full">
                Use passkey
              </Button>
            ) : (
              <form onSubmit={onCode} className="space-y-4">
                <Input
                  key={method}
                  label={method === 'totp' ? 'Authenticator code' : 'Recovery code'}
                  inputMode={method === 'totp' ? 'numeric' : 'text'}
                  autoComplete="one-time-code"
                  required
                  autoFocus
                  value={code}
                  // Recovery codes keep their dashes; authenticator codes are reduced to their 6 digits.
                  onChange={(e) => setCode(method === 'totp' ? otpDigits(e.target.value) : e.target.value)}
                />
                <Button type="submit" loading={busy} className="w-full">
                  Verify
                </Button>
              </form>
            )}
            <Button
              variant="ghost"
              className="w-full"
              onClick={() => {
                setStep('credentials');
                setError(null);
                setCode('');
                // Drop the Google handoff so a reload doesn't reopen the MFA step.
                if (fromGoogle) void navigate(location.pathname + location.search, { replace: true, state: null });
              }}
            >
              Start over
            </Button>
          </div>
        )}
      </div>
    </AuthCard>
  );
}

// Google "G" logo for the sign-in button.
function GoogleIcon() {
  return (
    <svg viewBox="0 0 48 48" className="h-4 w-4" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.2 0 24 0 14.6 0 6.6 5.4 2.7 13.2l7.9 6.2C12.5 13.6 17.8 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.4c-.5 2.9-2.2 5.3-4.6 6.9l7.4 5.8c4.3-4 6.9-9.9 6.9-17.2z" />
      <path fill="#FBBC05" d="M10.6 28.6c-.5-1.4-.8-3-.8-4.6s.3-3.2.8-4.6l-7.9-6.2C1 16.6 0 20.2 0 24s1 7.4 2.7 10.8l7.9-6.2z" />
      <path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.4-5.8c-2.1 1.4-4.8 2.2-8.5 2.2-6.2 0-11.5-4.1-13.4-9.9l-7.9 6.2C6.6 42.6 14.6 48 24 48z" />
    </svg>
  );
}
