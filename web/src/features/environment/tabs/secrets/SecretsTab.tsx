/** Secrets list for an environment: search, reveal, copy, edit, history and delete, depending on your role. */
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { errorMessage } from '@/shared/api/client';
import { listSecrets } from './secrets.api';
import { SECRET_TYPES, type Environment, type Role, type SecretMeta } from '@/shared/api/types';
import { Alert, Badge, Button, EmptyState, Input, Select, Spinner } from '@/shared/components/ui';
import { expiryState, formatDateTime, relativeTime } from '@/shared/lib/format';
import { RevealCell } from './RevealCell';
import { EditSecretDrawer, NewSecretDialog, secretsKey } from './SecretDialogs';

/** A secret's expiry: nothing when none, red when expired, amber when soon, otherwise the date. */
function ExpiryBadge({ iso }: { iso: string | null }) {
  const s = expiryState(iso);
  if (s.kind === 'none') return null;
  if (s.kind === 'expired') return <Badge className="bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200">expired</Badge>;
  if (s.kind === 'soon') return <Badge className="bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">expires in {s.days}d</Badge>;
  return <span className="text-xs text-stone-500">expires {formatDateTime(iso)}</span>;
}

// Secrets table with client-side search and filters; editors can create and edit.
export function SecretsTab({ project, env, role }: { project: string; env: Environment; role: Role }) {
  const canEdit = role === 'editor' || role === 'owner';
  const q = useQuery({ queryKey: secretsKey(project, env.slug), queryFn: () => listSecrets(project, env.slug) });
  const [search, setSearch] = useState('');
  const [type, setType] = useState('');
  const [tag, setTag] = useState('');
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  // Derived lists: the secret being edited, all tags, and the filtered rows.
  const secrets = useMemo(() => q.data?.secrets ?? [], [q.data]);
  const editing: SecretMeta | undefined = secrets.find((s) => s.id === editingId);
  const allTags = useMemo(() => Array.from(new Set(secrets.flatMap((s) => s.tags))).sort(), [secrets]);
  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return secrets.filter(
      (s) =>
        (!needle || s.key.toLowerCase().includes(needle) || (s.description ?? '').toLowerCase().includes(needle)) &&
        (!type || s.type === type) &&
        (!tag || s.tags.includes(tag)),
    );
  }, [secrets, search, type, tag]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <Input label="Search" type="search" value={search} onChange={(e) => setSearch(e.target.value)} className="w-full sm:w-64" />
        <Select label="Type" value={type} onChange={setType} options={[{ value: '', label: 'All types' }, ...SECRET_TYPES.map((t) => ({ value: t, label: t }))]} />
        <Select label="Tag" value={tag} onChange={setTag} options={[{ value: '', label: 'All tags' }, ...allTags.map((t) => ({ value: t, label: t }))]} />
        {canEdit && (
          <Button className="sm:ml-auto" onClick={() => setCreating(true)}>
            New secret
          </Button>
        )}
      </div>

      {q.isLoading && <Spinner />}
      {q.error && <Alert>{errorMessage(q.error)}</Alert>}
      {q.data && secrets.length === 0 && <EmptyState title="No secrets yet">{canEdit ? 'Create the first secret or import an .ejson file.' : null}</EmptyState>}
      {secrets.length > 0 && (
        <div className="overflow-x-auto rounded-lg ring-1 ring-stone-200 dark:ring-stone-700">
          <table className="min-w-full divide-y divide-stone-200 text-sm dark:divide-stone-700">
            <caption className="sr-only">Secrets in {env.name}</caption>
            <thead className="bg-stone-50 text-left text-xs font-semibold uppercase tracking-wide text-stone-600 dark:bg-stone-800 dark:text-stone-300">
              <tr>
                <th scope="col" className="px-3 py-2">Key</th>
                <th scope="col" className="px-3 py-2">Value</th>
                <th scope="col" className="px-3 py-2">Type</th>
                <th scope="col" className="px-3 py-2">Tags</th>
                <th scope="col" className="px-3 py-2">Version</th>
                <th scope="col" className="px-3 py-2">Updated</th>
                <th scope="col" className="px-3 py-2"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100 dark:divide-stone-800">
              {filtered.map((s) => (
                <tr key={s.id} className="align-top">
                  <th scope="row" className="px-3 py-2 text-left font-mono font-medium">
                    {s.key}
                    {s.description && <div className="font-sans text-xs font-normal text-stone-500">{s.description}</div>}
                    <div><ExpiryBadge iso={s.expiresAt} /></div>
                  </th>
                  <td className="px-3 py-2"><RevealCell project={project} env={env.slug} secretId={s.id} secretKey={s.key} /></td>
                  <td className="px-3 py-2">{s.type}</td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap gap-1">{s.tags.map((t) => <Badge key={t}>{t}</Badge>)}</div>
                  </td>
                  <td className="px-3 py-2 tabular-nums">v{s.currentVersion}</td>
                  <td className="px-3 py-2 text-xs text-stone-600 dark:text-stone-400">
                    <span title={formatDateTime(s.updatedAt)}>{relativeTime(s.updatedAt)}</span>
                    <div>{s.updatedBy?.name ?? '—'}</div>
                  </td>
                  <td className="px-3 py-2 text-right">
                    <Button size="sm" variant="secondary" onClick={() => setEditingId(s.id)} aria-label={`${canEdit ? 'Edit' : 'Details for'} ${s.key}`}>
                      {canEdit ? 'Edit' : 'Details'}
                    </Button>
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr><td colSpan={7} className="px-3 py-6 text-center text-stone-500">No secrets match the filters.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      <NewSecretDialog open={creating} onClose={() => setCreating(false)} project={project} env={env} />
      {editing && <EditSecretDrawer key={editing.id} secret={editing} onClose={() => setEditingId(null)} project={project} env={env} canEdit={canEdit} />}
    </div>
  );
}
