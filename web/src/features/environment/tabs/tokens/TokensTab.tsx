/** Service tokens for an environment: create (the token is shown once), list and revoke. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { errorMessage } from '@/shared/api/client';
import { createToken, listTokens, revokeToken } from './tokens.api';
import type { Environment, TokenScope } from '@/shared/api/types';
import { Dialog } from '@/shared/components/Dialog';
import { useToast } from '@/shared/components/Toast';
import { Alert, Badge, Button, EmptyState, Input, Spinner } from '@/shared/components/ui';
import { copyWithAutoClear } from '@/shared/lib/clipboard';
import { EJSON_PUBKEY_RE, formatDateTime } from '@/shared/lib/format';

// Create, list and revoke service tokens (owners).
export function TokensTab({ project, env }: { project: string; env: Environment }) {
  const qc = useQueryClient();
  const toast = useToast();
  const key = ['tokens', project, env.slug];
  const q = useQuery({ queryKey: key, queryFn: () => listTokens(project, env.slug) });

  // New-token form state; `plaintext` holds the one-time token to display.
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<TokenScope[]>(['read']);
  const [pub, setPub] = useState('');
  const [days, setDays] = useState('90');
  const [plaintext, setPlaintext] = useState<string | null>(null);

  // Form validation.
  const pubErr = pub && !EJSON_PUBKEY_RE.test(pub.trim()) ? 'Must be a 64-character hex ejson public key.' : null;
  const daysNum = days ? Number(days) : undefined;
  const daysErr = days && (!Number.isInteger(daysNum) || (daysNum ?? 0) < 1) ? 'Whole number of days, at least 1.' : null;

  // Create a token and show it once.
  const create = useMutation({
    mutationFn: () =>
      createToken(project, env.slug, {
        name: name.trim(),
        scopes,
        ejsonPublicKey: pub.trim() || undefined,
        expiresInDays: daysNum,
      }),
    gcTime: 0,
    onSuccess: async (r) => {
      setPlaintext(r.token);
      create.reset();
      setName('');
      setPub('');
      await qc.invalidateQueries({ queryKey: key });
    },
  });
  // Revoke a token.
  const revoke = useMutation({
    mutationFn: (id: string) => revokeToken(project, env.slug, id),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: key });
      toast.success('Token revoked');
    },
  });

  // Toggle a scope; submit only when the form is valid.
  const toggle = (s: TokenScope) => setScopes((xs) => (xs.includes(s) ? xs.filter((x) => x !== s) : [...xs, s]));
  const canCreate = name.trim() !== '' && scopes.length > 0 && !pubErr && !daysErr;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (canCreate) create.mutate();
  };
  // Used in the curl example.
  const origin = typeof window !== 'undefined' ? window.location.origin : '';

  return (
    <div className="space-y-4">
      <form onSubmit={submit} className="space-y-3 rounded-lg p-4 ring-1 ring-stone-200 dark:ring-stone-700" aria-labelledby="new-token-h">
        <h3 id="new-token-h" className="text-sm font-semibold">New service token</h3>
        {create.error && <Alert>{errorMessage(create.error)}</Alert>}
        <div className="grid gap-3 sm:grid-cols-2">
          <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} required />
          <Input label="Expires in (days)" type="number" min={1} value={days} onChange={(e) => setDays(e.target.value)} error={daysErr} hint="Leave empty for no expiry" />
        </div>
        <fieldset>
          <legend className="text-sm font-medium">Scopes</legend>
          <div className="mt-1 flex gap-4">
            {(['read', 'export'] as TokenScope[]).map((s) => (
              <label key={s} className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={scopes.includes(s)} onChange={() => toggle(s)} />
                {s}
              </label>
            ))}
          </div>
        </fieldset>
        <Input label="ejson public key (optional)" value={pub} onChange={(e) => setPub(e.target.value)} error={pubErr} spellCheck={false} className="font-mono" hint="If set, responses are encrypted to this key" />
        <Button type="submit" disabled={!canCreate} loading={create.isPending}>Create token</Button>
      </form>

      {revoke.error && <Alert>{errorMessage(revoke.error)}</Alert>}
      {q.isLoading && <Spinner />}
      {q.error && <Alert>{errorMessage(q.error)}</Alert>}
      {q.data && q.data.tokens.length === 0 && <EmptyState title="No service tokens" />}
      {q.data && q.data.tokens.length > 0 && (
        <div className="overflow-x-auto rounded-lg ring-1 ring-stone-200 dark:ring-stone-700">
          <table className="min-w-full divide-y divide-stone-200 text-sm dark:divide-stone-700">
            <caption className="sr-only">Service tokens</caption>
            <thead className="bg-stone-50 text-left text-xs font-semibold uppercase text-stone-600 dark:bg-stone-800 dark:text-stone-300">
              <tr>
                <th scope="col" className="px-3 py-2">Name</th>
                <th scope="col" className="px-3 py-2">Prefix</th>
                <th scope="col" className="px-3 py-2">Scopes</th>
                <th scope="col" className="px-3 py-2">Expires</th>
                <th scope="col" className="px-3 py-2">Last used</th>
                <th scope="col" className="px-3 py-2"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100 dark:divide-stone-800">
              {q.data.tokens.map((t) => (
                <tr key={t.id}>
                  <th scope="row" className="px-3 py-2 text-left font-medium">
                    {t.name}
                    {t.ejsonPublicKey && <div className="text-xs font-normal text-stone-500">ejson-encrypted</div>}
                  </th>
                  <td className="px-3 py-2 font-mono text-xs">{t.prefix}…</td>
                  <td className="px-3 py-2"><div className="flex gap-1">{t.scopes.map((s) => <Badge key={s}>{s}</Badge>)}</div></td>
                  <td className="px-3 py-2 text-xs">{t.expiresAt ? formatDateTime(t.expiresAt) : 'Never'}</td>
                  <td className="px-3 py-2 text-xs">{formatDateTime(t.lastUsedAt)}</td>
                  <td className="px-3 py-2 text-right">
                    {t.revokedAt ? (
                      <Badge className="bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200">revoked</Badge>
                    ) : (
                      <Button size="sm" variant="danger" disabled={revoke.isPending} onClick={() => window.confirm(`Revoke ${t.name}?`) && revoke.mutate(t.id)}>
                        Revoke
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Dialog
        open={plaintext !== null}
        onClose={() => setPlaintext(null)}
        dismissible={false}
        size="lg"
        title="Copy your token now"
        description="This token is shown only once. Store it in your CI secret store."
        footer={<Button onClick={() => setPlaintext(null)}>I have stored it</Button>}
      >
        <div className="space-y-3">
          <code className="block break-all rounded bg-stone-100 p-2 font-mono text-sm dark:bg-stone-800">{plaintext}</code>
          <Button
            size="sm"
            variant="secondary"
            onClick={() =>
              plaintext &&
              copyWithAutoClear(plaintext).then(
                () => toast.success('Copied — clipboard clears in 30s'),
                () => toast.error('Clipboard is not available.'),
              )
            }
          >
            Copy token
          </Button>
          <p className="text-sm">Example:</p>
          <pre className="overflow-x-auto rounded bg-stone-900 p-2 text-xs text-stone-100">{`curl -H "Authorization: Bearer <token>" ${origin}/api/v1/secrets`}</pre>
        </div>
      </Dialog>
    </div>
  );
}
