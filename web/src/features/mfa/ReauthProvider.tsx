/** Global step-up (re-auth) modal for sensitive actions. */
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { reauthPasskey, reauthPasskeyOptions, reauthTotp } from '@/features/auth/auth.api';
import { errorMessage, setClientHandlers } from '@/shared/api/client';
import type { MeResponse } from '@/shared/api/types';
import { otpDigits } from '@/features/auth/otp';
import { authenticate, webauthnErrorMessage, webauthnSupported } from '@/features/auth/webauthn';
import { ME_KEY } from '@/features/auth/useMe';
import { Dialog } from '@/shared/components/Dialog';
import { Alert, Button, Input } from '@/shared/components/ui';

/**
 * Registers the API client's `requestReauth` handler: shows a modal asking for a TOTP code or a passkey
 * and resolves true on success, false on cancel. The client coalesces concurrent prompts and retries.
 */
export function ReauthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Resolves the pending requestReauth() promise.
  const resolver = useRef<((ok: boolean) => void) | null>(null);

  // Open the modal whenever the API client needs a fresh MFA check.
  useEffect(() => {
    setClientHandlers({
      requestReauth: () =>
        new Promise<boolean>((resolve) => {
          resolver.current?.(false);
          resolver.current = resolve;
          setCode('');
          setError(null);
          setOpen(true);
        }),
    });
    return () => {
      setClientHandlers({ requestReauth: async () => false });
      resolver.current?.(false);
      resolver.current = null;
    };
  }, []);

  // Close the modal and resolve the waiting request (refresh /me on success).
  const finish = (ok: boolean) => {
    setOpen(false);
    setBusy(false);
    setCode('');
    const r = resolver.current;
    resolver.current = null;
    if (ok) void qc.invalidateQueries({ queryKey: ME_KEY });
    r?.(ok);
  };

  // Re-auth with an authenticator code.
  const onTotp = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await reauthTotp(code.trim());
      finish(true);
    } catch (err) {
      setBusy(false);
      setError(errorMessage(err));
    }
  };

  // Re-auth with a passkey.
  const onPasskey = async () => {
    setBusy(true);
    setError(null);
    try {
      const opts = await reauthPasskeyOptions();
      const resp = await authenticate(opts);
      await reauthPasskey(resp);
      finish(true);
    } catch (err) {
      setBusy(false);
      setError(webauthnErrorMessage(err) ?? errorMessage(err));
    }
  };

  // Only offer the factors the user actually has.
  const me = qc.getQueryData<MeResponse>(ME_KEY);
  const hasTotp = me ? me.mfa.totp : true;
  const hasPasskey = (me ? me.mfa.passkeys > 0 : true) && webauthnSupported();

  return (
    <>
      {children}
      <Dialog
        open={open}
        onClose={() => finish(false)}
        dismissible={!busy}
        size="sm"
        title="Confirm it's you"
        description="This action needs a recent second-factor check."
      >
        <div className="space-y-4">
          {error && <Alert>{error}</Alert>}
          {hasTotp && (
            <form onSubmit={onTotp} className="space-y-3">
              <Input
                label="Authenticator code"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                required
                value={code}
                onChange={(e) => setCode(otpDigits(e.target.value))}
                data-autofocus
              />
              <Button type="submit" loading={busy} className="w-full">
                Verify
              </Button>
            </form>
          )}
          {hasPasskey && (
            <Button variant="secondary" className="w-full" onClick={onPasskey} disabled={busy}>
              Use a passkey
            </Button>
          )}
          <Button variant="ghost" className="w-full" onClick={() => finish(false)} disabled={busy}>
            Cancel
          </Button>
        </div>
      </Dialog>
    </>
  );
}
