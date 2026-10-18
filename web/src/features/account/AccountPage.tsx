/** Account page: passkeys, authenticator app, recovery codes, linked Google account and "log out everywhere". */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { deletePasskey, listPasskeys, logoutAll, unlinkGoogle } from '@/features/auth/auth.api';
import { errorMessage } from '@/shared/api/client';
import { Dialog } from '@/shared/components/Dialog';
import { PasskeySetup, TotpSetup } from '@/features/mfa/MfaSetup';
import { RecoveryCodes } from '@/features/mfa/RecoveryCodes';
import { useToast } from '@/shared/components/Toast';
import { Alert, Badge, Button, PageHeader, Spinner } from '@/shared/components/ui';
import { ME_KEY, useMe } from '@/features/auth/useMe';
import { formatDateTime, relativeTime } from '@/shared/lib/format';

const PASSKEYS_KEY = ['passkeys'] as const; // query key for the passkey list
// Shared card styling.
const card = 'rounded-lg bg-white p-5 ring-1 ring-stone-200 dark:bg-stone-900 dark:ring-stone-800';

// Security settings for the signed-in user.
export function AccountPage() {
  const me = useMe();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const passkeys = useQuery({ queryKey: PASSKEYS_KEY, queryFn: listPasskeys });
  // Which dialog is open, and freshly issued recovery codes to show.
  const [dialog, setDialog] = useState<'passkey' | 'totp' | 'logout-all' | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);

  // Reload MFA status and the passkey list.
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ME_KEY });
    void qc.invalidateQueries({ queryKey: PASSKEYS_KEY });
  };
  // Remove a passkey.
  const remove = useMutation({
    mutationFn: deletePasskey,
    onSuccess: () => {
      toast.success('Passkey removed.');
      refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  // Unlink the Google account.
  const unlink = useMutation({
    mutationFn: unlinkGoogle,
    onSuccess: () => {
      toast.success('Google account unlinked.');
      refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  // End all sessions, then go to login.
  const logoutEverywhere = useMutation({
    mutationFn: logoutAll,
    onSuccess: () => {
      qc.clear();
      void navigate('/login', { replace: true });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  if (me.isPending) return <Spinner />;
  if (me.isError) return <Alert>{errorMessage(me.error)}</Alert>;
  const { user, mfa } = me.data;

  // After adding a factor: close the dialog and show new recovery codes if any.
  const afterSetup = (c: string[] | undefined) => {
    setDialog(null);
    refresh();
    if (c?.length) setCodes(c);
    else toast.success('Factor added.');
  };

  return (
    <>
      <PageHeader title="Account" subtitle={`${user.name} · ${user.email}`} />
      <div className="grid gap-4 lg:grid-cols-2">
        <section className={card} aria-labelledby="acc-passkeys">
          <div className="mb-3 flex items-center justify-between">
            <h2 id="acc-passkeys" className="font-semibold">
              Passkeys
            </h2>
            <Button size="sm" onClick={() => setDialog('passkey')}>
              Add passkey
            </Button>
          </div>
          {passkeys.isPending ? (
            <Spinner />
          ) : passkeys.isError ? (
            <Alert>{errorMessage(passkeys.error)}</Alert>
          ) : passkeys.data.passkeys.length === 0 ? (
            <p className="text-sm text-stone-500">No passkeys registered.</p>
          ) : (
            <ul className="divide-y divide-stone-200 dark:divide-stone-800">
              {passkeys.data.passkeys.map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-2 py-2 text-sm">
                  <div>
                    <div className="font-medium">{p.name}</div>
                    <div className="text-xs text-stone-500">
                      Added {formatDateTime(p.createdAt)} · {p.lastUsedAt ? `last used ${relativeTime(p.lastUsedAt)}` : 'never used'}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="danger"
                    aria-label={`Remove passkey ${p.name}`}
                    loading={remove.isPending && remove.variables === p.id}
                    disabled={remove.isPending}
                    onClick={() => remove.mutate(p.id)}
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className={card} aria-labelledby="acc-totp">
          <h2 id="acc-totp" className="mb-3 font-semibold">
            Authenticator app
          </h2>
          {mfa.totp ? (
            <Badge className="bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-200">Enabled</Badge>
          ) : (
            <div className="space-y-2">
              <p className="text-sm text-stone-500">Not set up.</p>
              <Button size="sm" variant="secondary" onClick={() => setDialog('totp')}>
                Set up
              </Button>
            </div>
          )}
        </section>

        <section className={card} aria-labelledby="acc-recovery">
          <h2 id="acc-recovery" className="mb-3 font-semibold">
            Recovery codes
          </h2>
          <p className="text-sm">
            <span className="font-semibold">{mfa.recoveryCodesLeft}</span> unused code{mfa.recoveryCodesLeft === 1 ? '' : 's'} left.
          </p>
          {mfa.recoveryCodesLeft <= 3 && <div className="mt-2"><Alert kind="warning">You are running low on recovery codes.</Alert></div>}
        </section>

        {me.data.googleLinked && (
          <section className={card} aria-labelledby="acc-google">
            <h2 id="acc-google" className="mb-3 font-semibold">
              Google sign-in
            </h2>
            <p className="mb-3 text-sm text-stone-500">
              A Google account is linked. Signing in with it still asks for your second factor.
            </p>
            <Button size="sm" variant="secondary" loading={unlink.isPending} onClick={() => unlink.mutate()}>
              Unlink Google account
            </Button>
          </section>
        )}

        <section className={card} aria-labelledby="acc-sessions">
          <h2 id="acc-sessions" className="mb-3 font-semibold">
            Sessions
          </h2>
          <p className="mb-3 text-sm text-stone-500">
            Signed in {relativeTime(me.data.loginAt)}
            {me.data.mfaAt && ` · last verified ${relativeTime(me.data.mfaAt)}`}
          </p>
          <Button variant="danger" size="sm" onClick={() => setDialog('logout-all')}>
            Log out everywhere
          </Button>
        </section>
      </div>

      <Dialog open={dialog === 'passkey'} onClose={() => setDialog(null)} title="Add a passkey">
        <PasskeySetup onDone={(r) => afterSetup(r.recoveryCodes)} />
      </Dialog>
      <Dialog open={dialog === 'totp'} onClose={() => setDialog(null)} title="Set up authenticator app">
        <TotpSetup onDone={afterSetup} />
      </Dialog>
      <Dialog
        open={dialog === 'logout-all'}
        onClose={() => setDialog(null)}
        size="sm"
        title="Log out everywhere?"
        description="This ends every session of your account, including this one."
        footer={
          <>
            <Button variant="secondary" onClick={() => setDialog(null)}>
              Cancel
            </Button>
            <Button variant="danger" loading={logoutEverywhere.isPending} onClick={() => logoutEverywhere.mutate()}>
              Log out everywhere
            </Button>
          </>
        }
      >
        <span />
      </Dialog>
      <Dialog open={codes !== null} onClose={() => setCodes(null)} dismissible={false} title="Save your recovery codes">
        {codes && <RecoveryCodes codes={codes} onDone={() => setCodes(null)} doneLabel="Done" />}
      </Dialog>
    </>
  );
}
