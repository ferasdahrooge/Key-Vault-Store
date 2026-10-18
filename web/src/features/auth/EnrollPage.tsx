/** First sign-in after an invite (or an admin reset): add an MFA factor, then save the recovery codes. */
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { AuthCard } from './AuthCard';
import { PasskeySetup, TotpSetup } from '@/features/mfa/MfaSetup';
import { RecoveryCodes } from '@/features/mfa/RecoveryCodes';
import { webauthnSupported } from './webauthn';

// Mandatory MFA setup; passkey is suggested first when the browser supports it.
export function EnrollPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [codes, setCodes] = useState<string[] | null>(null);
  const [mode, setMode] = useState<'passkey' | 'totp'>(webauthnSupported() ? 'passkey' : 'totp');

  // Done: drop cached data and go to the home page.
  const finish = () => {
    setCodes(null);
    qc.clear();
    void navigate('/', { replace: true });
  };

  // After the first factor, show the recovery codes before continuing.
  if (codes) {
    return (
      <AuthCard title="Save your recovery codes">
        <RecoveryCodes codes={codes} onDone={finish} />
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Set up two-step verification" subtitle="A second factor is required before you can use Key Vault.">
      <div className="space-y-6">
        {mode === 'passkey' ? (
          <>
            <p className="text-sm">Recommended: use a passkey (Touch ID, Windows Hello or a security key).</p>
            <PasskeySetup onDone={(r) => (r.recoveryCodes?.length ? setCodes(r.recoveryCodes) : finish())} />
            <button type="button" className="text-sm text-brand-600 dark:text-brand-400 underline" onClick={() => setMode('totp')}>
              Use an authenticator app instead
            </button>
          </>
        ) : (
          <>
            <TotpSetup onDone={(c) => (c?.length ? setCodes(c) : finish())} />
            {webauthnSupported() && (
              <button type="button" className="text-sm text-brand-600 dark:text-brand-400 underline" onClick={() => setMode('passkey')}>
                Use a passkey instead
              </button>
            )}
          </>
        )}
        <p className="text-xs text-stone-500">
          Not you? <Link to="/login" className="underline">Sign in with another account</Link>
        </p>
      </div>
    </AuthCard>
  );
}
