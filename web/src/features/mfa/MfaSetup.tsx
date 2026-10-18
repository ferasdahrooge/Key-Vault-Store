/** Setup flows for the two MFA factors (passkey and authenticator app), used by enrollment and the account page. */
import { useState, type FormEvent } from 'react';
import { passkeyRegisterOptions, passkeyRegisterVerify, totpConfirm, totpEnroll } from '@/features/auth/auth.api';
import { errorMessage } from '@/shared/api/client';
import type { PasskeyRegisterResponse, TotpEnrollResponse } from '@/shared/api/types';
import { otpDigits } from '@/features/auth/otp';
import { register, webauthnErrorMessage, webauthnSupported } from '@/features/auth/webauthn';
import { CopyButton } from '@/shared/components/CopyButton';
import { Alert, Button, Input } from '@/shared/components/ui';

/** Registers a passkey. `onDone` receives the server response (may include recovery codes). */
export function PasskeySetup({ onDone }: { onDone: (r: PasskeyRegisterResponse) => void }) {
  const [name, setName] = useState('My passkey');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Nothing to set up on browsers without WebAuthn.
  if (!webauthnSupported()) return <Alert kind="info">This browser does not support passkeys.</Alert>;

  // Get options from the server, prompt the authenticator, then save the passkey.
  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const opts = await passkeyRegisterOptions();
      const resp = await register(opts);
      onDone(await passkeyRegisterVerify(resp, name.trim() || 'Passkey'));
    } catch (err) {
      setError(webauthnErrorMessage(err) ?? errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      {error && <Alert>{error}</Alert>}
      <Input label="Passkey name" value={name} maxLength={64} onChange={(e) => setName(e.target.value)} hint="E.g. “Work laptop” or “YubiKey”." />
      <Button type="submit" loading={busy}>
        Create passkey
      </Button>
    </form>
  );
}

/** Enrolls an authenticator app: QR (data: URL) + manual secret + confirm code. `onDone` gets new recovery codes, if any. */
export function TotpSetup({ onDone }: { onDone: (recoveryCodes: string[] | undefined) => void }) {
  const [enroll, setEnroll] = useState<TotpEnrollResponse | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Ask the server for a new seed and QR code.
  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      setEnroll(await totpEnroll());
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  // Confirm setup with the first code from the app.
  const confirm = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await totpConfirm(code.trim());
      setEnroll(null);
      onDone(r.recoveryCodes);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  // Before setup starts, show just the start button.
  if (!enroll) {
    return (
      <div className="space-y-3">
        {error && <Alert>{error}</Alert>}
        <Button variant="secondary" onClick={start} loading={busy}>
          Set up authenticator app
        </Button>
      </div>
    );
  }
  return (
    <form onSubmit={confirm} className="space-y-4">
      {error && <Alert>{error}</Alert>}
      <p className="text-sm">Scan this QR code with your authenticator app, then enter the 6-digit code it shows.</p>
      <img src={enroll.qrDataUrl} alt="TOTP QR code" width={192} height={192} className="size-48 rounded bg-white p-2" />
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span>Or enter this key manually:</span>
        <code className="rounded bg-stone-100 px-2 py-1 font-mono break-all dark:bg-stone-800">{enroll.secret}</code>
        <CopyButton value={enroll.secret} autoClear />
      </div>
      <Input
        label="Code from your app"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]{6}"
        required
        value={code}
        onChange={(e) => setCode(otpDigits(e.target.value))}
      />
      <Button type="submit" loading={busy}>
        Confirm
      </Button>
    </form>
  );
}
