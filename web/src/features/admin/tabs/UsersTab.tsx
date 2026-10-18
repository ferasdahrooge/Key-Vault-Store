/** Admin user list: invite users, enable/disable, grant or revoke admin, unlock locked accounts. */
import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { listUsers, updateUser } from '../admin.api';
import { errorMessage } from '@/shared/api/client';
import { createInvite } from '@/features/invites/invites.api';
import type { AdminUser } from '@/shared/api/types';
import { CopyButton } from '@/shared/components/CopyButton';
import { Dialog } from '@/shared/components/Dialog';
import { useToast } from '@/shared/components/Toast';
import { Alert, Badge, Button, Input, Spinner } from '@/shared/components/ui';
import { useMe } from '@/features/auth/useMe';
import { formatDate, formatDateTime } from '@/shared/lib/format';

// React Query cache key for the admin user list.
export const USERS_KEY = ['admin', 'users'] as const;

/** Creates an invite and shows its single-use link to copy (it is not shown again). */
function InviteDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [isAdmin, setIsAdmin] = useState(false);
  const m = useMutation({
    mutationFn: () => createInvite({ email: email.trim(), name: name.trim(), isAdmin }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: USERS_KEY }),
  });
  // Reset the form when the dialog closes.
  const close = () => {
    m.reset();
    setEmail('');
    setName('');
    setIsAdmin(false);
    onClose();
  };
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    m.mutate();
  };
  return (
    <Dialog open={open} onClose={close} dismissible={!m.isPending} title="Invite user">
      {m.data ? (
        <div className="space-y-3">
          <Alert kind="success">Invite created. Send this link to {email} — it expires {formatDateTime(m.data.expiresAt)}.</Alert>
          <code className="block rounded bg-stone-100 p-2 font-mono text-xs break-all dark:bg-stone-800">{m.data.inviteUrl}</code>
          <div className="flex gap-2">
            <CopyButton value={m.data.inviteUrl} label="Copy link" />
            <Button size="sm" onClick={close}>
              Done
            </Button>
          </div>
        </div>
      ) : (
        <form onSubmit={onSubmit} className="space-y-4">
          {m.isError && <Alert>{errorMessage(m.error)}</Alert>}
          <Input label="Email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          <Input label="Name" required value={name} onChange={(e) => setName(e.target.value)} />
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="size-4" checked={isAdmin} onChange={(e) => setIsAdmin(e.target.checked)} />
            Administrator
          </label>
          <Button type="submit" loading={m.isPending}>
            Create invite
          </Button>
        </form>
      )}
    </Dialog>
  );
}

/** Per-user admin actions; `self` hides the ones the server refuses for your own account. */
function UserActions({ u, self }: { u: AdminUser; self: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const m = useMutation({
    mutationFn: (body: Parameters<typeof updateUser>[1]) => updateUser(u.id, body),
    onSuccess: () => {
      toast.success('User updated.');
      void qc.invalidateQueries({ queryKey: USERS_KEY });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const locked = !!u.lockedUntil && new Date(u.lockedUntil).getTime() > Date.now();
  // Current state decides which buttons show.
  const disabled = u.status === 'disabled';
  return (
    <div className="flex flex-wrap gap-1">
      <Button size="sm" variant={disabled ? 'secondary' : 'danger'} disabled={m.isPending || self} onClick={() => m.mutate({ status: disabled ? 'active' : 'disabled' })}>
        {disabled ? 'Enable' : 'Disable'}
      </Button>
      <Button size="sm" variant="secondary" disabled={m.isPending || (self && u.isAdmin)} onClick={() => m.mutate({ isAdmin: !u.isAdmin })}>
        {u.isAdmin ? 'Remove admin' : 'Make admin'}
      </Button>
      {locked && (
        <Button size="sm" variant="secondary" disabled={m.isPending} onClick={() => m.mutate({ unlock: true })}>
          Unlock
        </Button>
      )}
    </div>
  );
}

// User table with an invite button.
export function UsersTab() {
  const me = useMe();
  const q = useQuery({ queryKey: USERS_KEY, queryFn: listUsers });
  const [invite, setInvite] = useState(false);
  return (
    <section aria-label="Users">
      <div className="mb-3 flex justify-end">
        <Button onClick={() => setInvite(true)}>Invite user</Button>
      </div>
      {q.isPending ? (
        <Spinner />
      ) : q.isError ? (
        <Alert>{errorMessage(q.error)}</Alert>
      ) : (
        <div className="overflow-x-auto rounded-lg ring-1 ring-stone-200 dark:ring-stone-800">
          <table className="min-w-full divide-y divide-stone-200 text-sm dark:divide-stone-800">
            <thead className="bg-stone-50 text-left dark:bg-stone-900">
              <tr>
                <th scope="col" className="px-3 py-2">User</th>
                <th scope="col" className="px-3 py-2">Status</th>
                <th scope="col" className="px-3 py-2">Created</th>
                <th scope="col" className="px-3 py-2">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-200 bg-white dark:divide-stone-800 dark:bg-stone-950">
              {q.data.users.map((u) => {
                const locked = !!u.lockedUntil && new Date(u.lockedUntil).getTime() > Date.now();
                return (
                  <tr key={u.id}>
                    <td className="px-3 py-2">
                      <div className="font-medium">
                        {u.name} {u.isAdmin && <Badge className="bg-brand-100 text-brand-800 dark:bg-brand-900/40 dark:text-brand-200">admin</Badge>}
                      </div>
                      <div className="text-xs text-stone-500">{u.email}</div>
                    </td>
                    <td className="px-3 py-2">
                      <Badge className={u.status === 'disabled' ? 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200' : undefined}>{u.status}</Badge>
                      {locked && <Badge className="ml-1 bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">locked</Badge>}
                    </td>
                    <td className="px-3 py-2 text-stone-500">{formatDate(u.createdAt)}</td>
                    <td className="px-3 py-2">
                      <UserActions u={u} self={u.id === me.data?.user.id} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <InviteDialog open={invite} onClose={() => setInvite(false)} />
    </section>
  );
}
