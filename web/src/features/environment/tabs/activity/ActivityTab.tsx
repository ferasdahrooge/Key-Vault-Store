/** Recent audit entries for one environment. */
import { useInfiniteQuery } from '@tanstack/react-query';
import { errorMessage } from '@/shared/api/client';
import { listAudit } from '@/features/admin/audit.api';
import type { Environment } from '@/shared/api/types';
import { Alert, Button, EmptyState, Spinner } from '@/shared/components/ui';
import { formatDateTime } from '@/shared/lib/format';

// Activity log for one environment (owners).
export function ActivityTab({ env }: { env: Environment }) {
  // Paged audit entries filtered to this environment.
  const q = useInfiniteQuery({
    queryKey: ['audit', { envId: env.id }],
    queryFn: ({ pageParam }) => listAudit({ envId: env.id, before: pageParam ?? undefined, limit: 50 }),
    initialPageParam: null as string | number | null,
    getNextPageParam: (last) => last.nextBefore ?? undefined,
  });
  const entries = q.data?.pages.flatMap((p) => p.entries) ?? [];

  if (q.isLoading) return <Spinner />;
  if (q.error) return <Alert>{errorMessage(q.error)}</Alert>;
  if (entries.length === 0) return <EmptyState title="No activity yet" />;
  return (
    <div className="space-y-3">
      <div className="overflow-x-auto rounded-lg ring-1 ring-stone-200 dark:ring-stone-700">
        <table className="min-w-full divide-y divide-stone-200 text-sm dark:divide-stone-700">
          <caption className="sr-only">Activity in {env.name}</caption>
          <thead className="bg-stone-50 text-left text-xs font-semibold uppercase text-stone-600 dark:bg-stone-800 dark:text-stone-300">
            <tr>
              <th scope="col" className="px-3 py-2">When</th>
              <th scope="col" className="px-3 py-2">Actor</th>
              <th scope="col" className="px-3 py-2">Action</th>
              <th scope="col" className="px-3 py-2">Details</th>
              <th scope="col" className="px-3 py-2">IP</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100 dark:divide-stone-800">
            {entries.map((e) => (
              <tr key={e.seq}>
                <td className="whitespace-nowrap px-3 py-2 text-xs">{formatDateTime(e.at)}</td>
                <td className="px-3 py-2">{e.actor ? e.actor.name : e.actorType}</td>
                <td className="px-3 py-2 font-mono text-xs">{e.action}</td>
                <td className="max-w-md truncate px-3 py-2 font-mono text-xs text-stone-500">{e.meta ? JSON.stringify(e.meta) : ''}</td>
                <td className="px-3 py-2 text-xs">{e.ip ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {q.hasNextPage && (
        <Button variant="secondary" loading={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
          Load more
        </Button>
      )}
    </div>
  );
}
