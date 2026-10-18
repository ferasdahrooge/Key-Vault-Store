/** Access requests page: requests waiting for your decision (as an owner) and your own requests. */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { decideAccessRequest } from './accessRequests.api';
import { errorMessage } from '@/shared/api/client';
import type { AccessRequest } from '@/shared/api/types';
import { useToast } from '@/shared/components/Toast';
import { Alert, Badge, Button, EmptyState, PageHeader, RoleBadge, Spinner } from '@/shared/components/ui';
import { ACCESS_REQUESTS_KEY, useAccessRequests } from './useAccessRequests';
import { formatDuration, relativeTime } from '@/shared/lib/format';

// Badge colours per request status.
const STATUS_CLS: Record<string, string> = {
  pending: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200',
  approved: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-200',
  denied: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200',
};

/** One request; with `decide`, also shows the requester and approve/deny buttons while pending. */
function RequestRow({ r, decide }: { r: AccessRequest; decide?: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  // Approve or deny, then refresh the list.
  const m = useMutation({
    mutationFn: (approve: boolean) => decideAccessRequest(r.id, approve),
    onSuccess: (_d, approve) => {
      toast.success(approve ? 'Request approved.' : 'Request denied.');
      void qc.invalidateQueries({ queryKey: ACCESS_REQUESTS_KEY });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <li className="flex flex-col gap-2 rounded-lg bg-white p-4 ring-1 ring-stone-200 sm:flex-row sm:items-center sm:justify-between dark:bg-stone-900 dark:ring-stone-800">
      <div className="space-y-1 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">
            {r.project.name} / {r.env.name}
          </span>
          <RoleBadge role={r.role} />
          <Badge className={STATUS_CLS[r.status]}>{r.status}</Badge>
        </div>
        {decide && (
          <div>
            {r.user.name} <span className="text-stone-500">&lt;{r.user.email}&gt;</span>
          </div>
        )}
        <div className="text-stone-600 dark:text-stone-400">“{r.reason}”</div>
        <div className="text-xs text-stone-500">
          For {formatDuration(r.durationMin)} · requested {relativeTime(r.createdAt)}
          {r.decidedAt && ` · decided ${relativeTime(r.decidedAt)}`}
        </div>
      </div>
      {decide && r.status === 'pending' && (
        <div className="flex gap-2">
          <Button size="sm" loading={m.isPending && m.variables === true} disabled={m.isPending} onClick={() => m.mutate(true)}>
            Approve
          </Button>
          <Button size="sm" variant="danger" loading={m.isPending && m.variables === false} disabled={m.isPending} onClick={() => m.mutate(false)}>
            Deny
          </Button>
        </div>
      )}
    </li>
  );
}

// Sort pending requests first, then newest first.
const byPendingThenDate = (a: AccessRequest, b: AccessRequest) =>
  Number(b.status === 'pending') - Number(a.status === 'pending') || b.createdAt.localeCompare(a.createdAt);

// Two lists: requests to decide and my own requests.
export function AccessRequestsPage() {
  const q = useAccessRequests();
  if (q.isPending) return <Spinner />;
  if (q.isError) return <Alert>{errorMessage(q.error)}</Alert>;
  const toDecide = [...q.data.toDecide].sort(byPendingThenDate);
  const mine = [...q.data.mine].sort(byPendingThenDate);
  return (
    <>
      <PageHeader title="Access requests" subtitle="Time-boxed access to environments." />
      <section aria-labelledby="ar-decide" className="mb-8">
        <h2 id="ar-decide" className="mb-3 text-lg font-semibold">
          To decide
        </h2>
        {toDecide.length ? (
          <ul className="space-y-3">
            {toDecide.map((r) => (
              <RequestRow key={r.id} r={r} decide />
            ))}
          </ul>
        ) : (
          <EmptyState title="Nothing to decide">Requests for environments you own appear here.</EmptyState>
        )}
      </section>
      <section aria-labelledby="ar-mine">
        <h2 id="ar-mine" className="mb-3 text-lg font-semibold">
          My requests
        </h2>
        {mine.length ? (
          <ul className="space-y-3">
            {mine.map((r) => (
              <RequestRow key={r.id} r={r} />
            ))}
          </ul>
        ) : (
          <EmptyState title="No requests">Use “Request access” on the projects page.</EmptyState>
        )}
      </section>
    </>
  );
}
