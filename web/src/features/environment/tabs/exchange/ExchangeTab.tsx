/** ejson import/export for an environment. Exports are encrypted to a recipient key; imports are previewed before commit. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { errorMessage } from '@/shared/api/client';
import { exportEjson, getImportKey, importCommit, importPreview } from './exchange.api';
import { listSecrets } from '../secrets/secrets.api';
import type { Environment, ImportPreview, Role } from '@/shared/api/types';
import { useToast } from '@/shared/components/Toast';
import { Alert, Badge, Button, Input, Spinner, Textarea, cx } from '@/shared/components/ui';
import { copyText } from '@/shared/lib/clipboard';
import { downloadBlob } from '@/shared/lib/download';
import { EJSON_PUBKEY_RE } from '@/shared/lib/format';
import { secretsKey } from '../secrets/SecretDialogs';
import { useProtectedConfirm } from '../../useProtectedConfirm';

// Badge colours for import preview statuses.
const STATUS_CLS: Record<string, string> = {
  new: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200',
  changed: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200',
  unchanged: 'bg-stone-100 text-stone-700 dark:bg-stone-800 dark:text-stone-300',
};

/** Downloads the environment as an .ejson file encrypted to the recipient's public key. */
function ExportSection({ project, env }: { project: string; env: Environment }) {
  const toast = useToast();
  const [pub, setPub] = useState('');
  const [keys, setKeys] = useState<string[]>([]);
  const secrets = useQuery({ queryKey: secretsKey(project, env.slug), queryFn: () => listSecrets(project, env.slug) });
  const m = useMutation({
    mutationFn: () => exportEjson(project, env.slug, { recipientPublicKey: pub.trim(), keys: keys.length ? keys : undefined }),
    gcTime: 0,
    onSuccess: (blob) => {
      downloadBlob(blob, `secrets.${env.slug}.ejson`);
      m.reset();
      toast.success('Export downloaded');
    },
  });
  // Validate the recipient key; toggle which keys to export.
  const pubErr = pub && !EJSON_PUBKEY_RE.test(pub.trim()) ? 'Must be a 64-character hex ejson public key.' : null;
  const toggle = (k: string) => setKeys((xs) => (xs.includes(k) ? xs.filter((x) => x !== k) : [...xs, k]));

  return (
    <section aria-labelledby="export-h" className="space-y-3 rounded-lg p-4 ring-1 ring-stone-200 dark:ring-stone-700">
      <h3 id="export-h" className="font-semibold">Export to .ejson</h3>
      {m.error && <Alert>{errorMessage(m.error)}</Alert>}
      <Input label="Recipient public key" value={pub} onChange={(e) => setPub(e.target.value)} error={pubErr} spellCheck={false} autoComplete="off" hint="Output of `ejson keygen` (public half)" />
      <fieldset>
        <legend className="text-sm font-medium">Keys (none selected = all)</legend>
        <div className="mt-1 flex max-h-48 flex-wrap gap-x-4 gap-y-1 overflow-auto">
          {secrets.data?.secrets.map((s) => (
            <label key={s.id} className="flex items-center gap-2 font-mono text-xs">
              <input type="checkbox" checked={keys.includes(s.key)} onChange={() => toggle(s.key)} />
              {s.key}
            </label>
          ))}
        </div>
      </fieldset>
      <Button disabled={!pub || !!pubErr} loading={m.isPending} onClick={() => m.mutate()}>
        Download secrets.{env.slug}.ejson
      </Button>
    </section>
  );
}

/** What an import would change (new / changed / unchanged) plus entries the server rejected. */
export function ImportPreviewTable({ preview }: { preview: ImportPreview }) {
  return (
    <div className="overflow-x-auto rounded-lg ring-1 ring-stone-200 dark:ring-stone-700">
      <table className="min-w-full divide-y divide-stone-200 text-sm dark:divide-stone-700">
        <caption className="sr-only">Import preview</caption>
        <thead className="bg-stone-50 text-left text-xs font-semibold uppercase text-stone-600 dark:bg-stone-800 dark:text-stone-300">
          <tr>
            <th scope="col" className="px-3 py-2">Key</th>
            <th scope="col" className="px-3 py-2">Status</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-stone-100 dark:divide-stone-800">
          {preview.changes.map((c) => (
            <tr key={c.key}>
              <th scope="row" className="px-3 py-2 text-left font-mono">{c.key}</th>
              <td className="px-3 py-2"><Badge className={STATUS_CLS[c.status]}>{c.status}</Badge></td>
            </tr>
          ))}
          {preview.rejected.map((r) => (
            <tr key={`rej-${r.path}`} className="bg-red-50 dark:bg-red-950/30">
              <th scope="row" className="px-3 py-2 text-left font-mono">{r.path}</th>
              <td className="px-3 py-2">
                <Badge className="bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200">rejected</Badge>
                <span className="ml-2 text-xs text-red-700 dark:text-red-300">{r.reason}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Upload or paste an .ejson file encrypted to the vault's import key, preview it, then commit. */
function ImportSection({ project, env }: { project: string; env: Environment }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [text, setText] = useState('');
  // The server's import public key (never changes, so cache forever).
  const keyQ = useQuery({ queryKey: ['import-key'], queryFn: getImportKey, staleTime: Infinity });
  // Dry run first; commit applies it and refreshes secrets and compare data.
  const preview = useMutation({ mutationFn: (t: string) => importPreview(project, env.slug, t) });
  const commit = useMutation({
    mutationFn: (confirm: string | undefined) => importCommit(project, env.slug, text, confirm),
    onSuccess: async (r) => {
      toast.success(`Imported: ${r.created} created, ${r.updated} updated, ${r.unchanged} unchanged`);
      setText('');
      preview.reset();
      await Promise.all([
        qc.invalidateQueries({ queryKey: secretsKey(project, env.slug) }),
        qc.invalidateQueries({ queryKey: ['compare', project] }),
      ]);
    },
  });
  // Protected envs ask for the slug before committing.
  const pc = useProtectedConfirm(env, commit.isPending);

  // Load an uploaded file into the textarea.
  const onFile = async (f: File | undefined) => {
    if (!f) return;
    const t = await f.text();
    setText(t);
    preview.reset();
  };
  const pk = keyQ.data?.publicKey ?? '';
  // Count of keys that would actually change.
  const changes = preview.data ? preview.data.changes.filter((c) => c.status !== 'unchanged').length : 0;

  return (
    <section aria-labelledby="import-h" className="space-y-3 rounded-lg p-4 ring-1 ring-stone-200 dark:ring-stone-700">
      <h3 id="import-h" className="font-semibold">Import from .ejson</h3>
      <div className="space-y-2 text-sm">
        <p>Server import public key:</p>
        {keyQ.isLoading && <Spinner />}
        {keyQ.error && <Alert>{errorMessage(keyQ.error)}</Alert>}
        {pk && (
          <div className="flex flex-wrap items-center gap-2">
            <code className="break-all rounded bg-stone-100 px-2 py-1 font-mono text-xs dark:bg-stone-800">{pk}</code>
            <Button size="sm" variant="secondary" onClick={() => void copyText(pk).then(() => toast.success('Public key copied'))}>
              Copy
            </Button>
          </div>
        )}
        <ol className="list-decimal space-y-1 pl-5 text-stone-700 dark:text-stone-300">
          <li>
            Create <code>file.ejson</code> containing <code>{`{ "_public_key": "${pk || '<server key>'}", "KEY": "value" }`}</code>.
          </li>
          <li>
            Run <code>ejson encrypt file.ejson</code>.
          </li>
          <li>Upload the encrypted file below (or paste its contents) and preview the changes.</li>
        </ol>
      </div>
      <div>
        <label htmlFor="ejson-file" className="block text-sm font-medium">ejson file</label>
        <input id="ejson-file" type="file" accept=".ejson,.json,application/json" className="mt-1 block text-sm" onChange={(e) => void onFile(e.target.files?.[0])} />
      </div>
      <Textarea label="…or paste encrypted contents" rows={6} value={text} onChange={(e) => { setText(e.target.value); preview.reset(); }} spellCheck={false} />
      {preview.error && <Alert>{errorMessage(preview.error)}</Alert>}
      {commit.error && <Alert>{errorMessage(commit.error)}</Alert>}
      <div className="flex gap-2">
        <Button variant="secondary" disabled={!text.trim()} loading={preview.isPending} onClick={() => preview.mutate(text)}>
          Preview
        </Button>
        {preview.data && (
          <Button
            disabled={changes === 0 || commit.isPending}
            loading={commit.isPending}
            onClick={() => pc.run(`Import ${changes} change(s) into ${env.name}`, (c) => commit.mutate(c))}
          >
            Commit import
          </Button>
        )}
      </div>
      {preview.data && <ImportPreviewTable preview={preview.data} />}
      {pc.dialog}
    </section>
  );
}

// Owners see export and import; editors only import.
export function ExchangeTab({ project, env, role }: { project: string; env: Environment; role: Role }) {
  return (
    <div className={cx('grid gap-4', role === 'owner' && 'lg:grid-cols-2')}>
      {role === 'owner' && <ExportSection project={project} env={env} />}
      <ImportSection project={project} env={env} />
    </div>
  );
}
