/** Admin audit log: filters, paging, chain verification and JSONL export. */
import { useState, type FormEvent } from 'react';
import { useInfiniteQuery, useMutation, useQuery } from '@tanstack/react-query';
import { listUsers } from '../admin.api';
import { AUDIT_EXPORT_URL, listAudit, verifyAudit, type AuditFilter } from '../audit.api';
import { errorMessage } from '@/shared/api/client';
import { Alert, Button, EmptyState, Input, Select, Spinner } from '@/shared/components/ui';
import { formatDateTime } from '@/shared/lib/format';
import { USERS_KEY } from './UsersTab';

const PAGE = 50; // entries per page

// Audit log viewer for admins.
export function AuditTab() {
  const users = useQuery({ queryKey: USERS_KEY, queryFn: listUsers });
  // Filter form values; applied only on submit.
  const [draft, setDraft] = useState({ actorId: '', action: '', envId: '' });
  const [filter, setFilter] = useState<AuditFilter>({});
  // Paged audit list ("Load more" fetches older entries).
  const q = useInfiniteQuery({
    queryKey: ['audit', filter],
    queryFn: ({ pageParam }) => listAudit({ ...filter, limit: PAGE, before: pageParam ?? undefined }),
    initialPageParam: null as string | number | null,
    getNextPageParam: (last) => last.nextBefore ?? undefined,
  });
  const verify = useMutation({ mutationFn: verifyAudit });

  // Apply the filter form.
  const apply = (e: FormEvent) => {
    e.preventDefault();
    setFilter({
      actorId: draft.actorId || undefined,
      action: draft.action.trim() || undefined,
      envId: draft.envId.trim() || undefined,
    });
  };
  // All loaded pages as one list.
  const entries = q.data?.pages.flatMap((p) => p.entries) ?? [];

  return (
    <section aria-label="Audit log" className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" loading={verify.isPending} onClick={() => verify.mutate()}>
          Verify chain
        </Button>
        <a href={AUDIT_EXPORT_URL} download className="text-sm text-brand-600 dark:text-brand-400 underline">
          Export JSONL
        </a>
      </div>
      {verify.isError && <Alert>{errorMessage(verify.error)}</Alert>}
      {verify.data &&
        (verify.data.ok ? (
          <Alert kind="success">Hash chain intact — {verify.data.checked} entries checked.</Alert>
        ) : (
          <Alert>Hash chain BROKEN at entry #{verify.data.brokenAtSeq ?? '?'} ({verify.data.checked} checked). Investigate immediately.</Alert>
        ))}

      <form onSubmit={apply} className="grid items-end gap-2 sm:grid-cols-4">
        <Select
          label="Actor"
          value={draft.actorId}
          onChange={(v) => setDraft((d) => ({ ...d, actorId: v }))}
          options={[{ value: '', label: 'Anyone' }, ...(users.data?.users ?? []).map((u) => ({ value: u.id, label: `${u.name} (${u.email})` }))]}
        />
        <Input label="Action" placeholder="e.g. secret.reveal" value={draft.action} onChange={(e) => setDraft((d) => ({ ...d, action: e.target.value }))} />
        <Input label="Environment ID" value={draft.envId} onChange={(e) => setDraft((d) => ({ ...d, envId: e.target.value }))} />
        <Button type="submit" variant="secondary">
          Apply filters
        </Button>
      </form>

      {q.isPending ? (
        <Spinner />
      ) : q.isError ? (
        <Alert>{errorMessage(q.error)}</Alert>
      ) : entries.length === 0 ? (
        <EmptyState title="No audit entries" />
      ) : (
        <div className="overflow-x-auto rounded-lg ring-1 ring-stone-200 dark:ring-stone-800">
          <table className="min-w-full divide-y divide-stone-200 text-sm dark:divide-stone-800">
            <thead className="bg-stone-50 text-left dark:bg-stone-900">
              <tr>
                <th scope="col" className="px-3 py-2">#</th>
                <th scope="col" className="px-3 py-2">When</th>
                <th scope="col" className="px-3 py-2">Actor</th>
                <th scope="col" className="px-3 py-2">Action</th>
                <th scope="col" className="px-3 py-2">IP</th>
                <th scope="col" className="px-3 py-2">Details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-200 bg-white dark:divide-stone-800 dark:bg-stone-950">
              {entries.map((e) => (
                <tr key={e.seq}>
                  <td className="px-3 py-2 font-mono text-xs">{e.seq}</td>
                  <td className="px-3 py-2 whitespace-nowrap">{formatDateTime(e.at)}</td>
                  <td className="px-3 py-2">{e.actor ? e.actor.name : <span className="text-stone-500">{e.actorType}</span>}</td>
                  <td className="px-3 py-2 font-mono text-xs">{e.action}</td>
                  <td className="px-3 py-2 font-mono text-xs">{e.ip ?? '—'}</td>
                  <td className="max-w-xs truncate px-3 py-2 font-mono text-xs" title={e.meta ? JSON.stringify(e.meta) : undefined}>
                    {e.meta ? JSON.stringify(e.meta) : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {q.hasNextPage && (
        <Button variant="secondary" loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
          Load more
        </Button>
      )}
    </section>
  );
}
