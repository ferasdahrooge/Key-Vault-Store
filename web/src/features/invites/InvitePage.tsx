/** Invite link landing page (/invite/:token): choose a password, then continue to MFA enrollment. */
import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { acceptInvite, getInvite } from './invites.api';
import { errorMessage, isApiError } from '@/shared/api/client';
import { AuthCard } from '@/features/auth/AuthCard';
import { Alert, Button, Input, Spinner, cx } from '@/shared/components/ui';
import { passwordChecks } from '@/shared/lib/password';

// Shows who the invite is for and lets them set a password.
export function InvitePage() {
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  // Look up the invite (no retries; an invalid link should fail fast).
  const invite = useQuery({ queryKey: ['invite', token], queryFn: () => getInvite(token), retry: false, gcTime: 0 });
  const [pw, setPw] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Loading and error states.
  if (invite.isPending) {
    return (
      <AuthCard title="Accept invite">
        <Spinner />
      </AuthCard>
    );
  }
  if (invite.isError) {
    return (
      <AuthCard title="Invite unavailable">
        <Alert>{isApiError(invite.error) && invite.error.status === 404 ? 'This invite link is invalid, expired or already used.' : errorMessage(invite.error)}</Alert>
        <Link to="/login" className="mt-4 inline-block text-sm text-brand-600 dark:text-brand-400 underline">
          Go to sign in
        </Link>
      </AuthCard>
    );
  }

  // Submit only when required checks pass and both passwords match.
  const checks = passwordChecks(pw, invite.data.email);
  const ok = checks.every((c) => !c.required || c.ok) && pw === confirm && pw.length > 0;

  // Accept the invite, then continue to MFA enrollment.
  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      await acceptInvite(token, pw);
      qc.clear();
      void navigate('/enroll', { replace: true });
    } catch (err) {
      setBusy(false);
      setError(errorMessage(err));
    }
  };

  return (
    <AuthCard title={`Welcome, ${invite.data.name}`} subtitle={`Choose a password for ${invite.data.email}.`}>
      <form onSubmit={onSubmit} className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <input type="email" autoComplete="username" value={invite.data.email} readOnly hidden />
        <Input label="Password" type="password" autoComplete="new-password" required value={pw} onChange={(e) => setPw(e.target.value)} />
        <ul className="space-y-1 text-sm" aria-label="Password requirements">
          {checks.map((c) => (
            <li key={c.id} className={cx(c.ok ? 'text-green-700 dark:text-green-400' : 'text-stone-500')}>
              <span aria-hidden="true">{c.ok ? '✓ ' : '• '}</span>
              {c.label}
              {!c.required && ' (recommended)'}
              <span className="sr-only">{c.ok ? ' — met' : ' — not met'}</span>
            </li>
          ))}
        </ul>
        <Input
          label="Confirm password"
          type="password"
          autoComplete="new-password"
          required
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          error={confirm && confirm !== pw ? 'Passwords do not match.' : null}
        />
        <Button type="submit" loading={busy} disabled={!ok} className="w-full">
          Set password
        </Button>
      </form>
    </AuthCard>
  );
}
