/**
 * Google redirects here (/login/google/callback?code&state). The page hands code + state to the API,
 * then continues like the password step: on to /login's MFA step, or to /enroll.
 */
import { useEffect, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { googleCallback } from './auth.api';
import { errorMessage, isApiError } from '@/shared/api/client';
import { AuthCard } from './AuthCard';
import { Spinner } from '@/shared/components/ui';
import { safeNext } from '@/shared/lib/navigation';
import type { LoginLocationState } from './LoginPage';

// Finishes Google sign-in and routes to MFA or enrollment.
export function GoogleCallbackPage() {
  const [sp] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  // The code and state are single use; StrictMode's double effect must not send them twice.
  const sent = useRef(false);

  useEffect(() => {
    if (sent.current) return;
    sent.current = true;
    const code = sp.get('code');
    const state = sp.get('state');
    // On failure, return to the login page with an error message.
    const back = (error: string) => void navigate('/login', { replace: true, state: { error } satisfies LoginLocationState });

    if (!code || !state) {
      back(sp.get('error') === 'access_denied' ? 'Google sign-in was cancelled.' : 'Google sign-in did not complete. Please try again.');
      return;
    }
    // Send code+state to the server, then continue the login flow.
    googleCallback(code, state).then(
      (r) => {
        qc.clear();
        if ('mfaEnrollmentRequired' in r) {
          void navigate('/enroll', { replace: true });
          return;
        }
        const next = r.next ? safeNext(r.next) : '/';
        const login = next === '/' ? '/login' : `/login?next=${encodeURIComponent(next)}`;
        void navigate(login, { replace: true, state: { mfaMethods: r.methods } satisfies LoginLocationState });
      },
      (err: unknown) =>
        back(isApiError(err, 'rate_limited') ? 'Too many attempts. Please wait a moment and try again.' : errorMessage(err)),
    );
  }, [sp, navigate, qc]);

  return (
    <AuthCard title="Signing in with Google">
      <div className="flex items-center gap-3 text-sm text-stone-600 dark:text-stone-400">
        <Spinner className="size-4" />
        Checking your Google account…
      </div>
    </AuthCard>
  );
}
