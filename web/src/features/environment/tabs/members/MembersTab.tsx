/** Environment members: list, add from the user directory, change roles and remove (owners only). */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { errorMessage, isApiError } from '@/shared/api/client';
import { listMembers, removeMember, setMember } from './members.api';
import { ROLES, type DirectoryUser, type Environment, type Role } from '@/shared/api/types';
import { searchDirectory } from './users.api';
import { useToast } from '@/shared/components/Toast';
import { Alert, Button, Input, RoleBadge, Select, Spinner } from '@/shared/components/ui';
import { formatDateTime } from '@/shared/lib/format';

// Role dropdown options.
const roleOptions = ROLES.map((r) => ({ value: r, label: r }));

/** Explains last_owner in context; other errors use the shared messages. */
function memberError(e: unknown): string {
  if (isApiError(e) && e.code === 'last_owner') return 'An environment must keep at least one owner. Promote someone else to owner first.';
  return errorMessage(e);
}

/** `value`, updated only after it has been stable for `ms` (keeps directory search from firing on every key). */
function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

// Member list; owners can add, change roles and remove.
export function MembersTab({ project, env, role }: { project: string; env: Environment; role: Role }) {
  const isOwner = role === 'owner';
  const qc = useQueryClient();
  const toast = useToast();
  const key = ['members', project, env.slug];
  const q = useQuery({ queryKey: key, queryFn: () => listMembers(project, env.slug) });

  // Directory search for adding a member (debounced, owners only).
  const [search, setSearch] = useState('');
  const debounced = useDebounced(search.trim(), 250);
  const [picked, setPicked] = useState<DirectoryUser | null>(null);
  const [newRole, setNewRole] = useState<Role>('viewer');
  const dir = useQuery({
    queryKey: ['directory', debounced],
    queryFn: () => searchDirectory(debounced),
    enabled: isOwner && debounced.length >= 2 && !picked,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: key });
  // Add a member or change a role.
  const set = useMutation({
    mutationFn: ({ userId, r }: { userId: string; r: Role }) => setMember(project, env.slug, userId, r),
    onSuccess: async (res) => {
      await invalidate();
      toast.success(`${res.member.user.name} is now ${res.member.role}`);
      setPicked(null);
      setSearch('');
    },
  });
  // Remove a member.
  const remove = useMutation({
    mutationFn: (userId: string) => removeMember(project, env.slug, userId),
    onSuccess: async () => {
      await invalidate();
      toast.success('Member removed');
    },
  });
  const err = set.error ?? remove.error;
  // Marks search results that are already members.
  const existing = new Set(q.data?.members.map((m) => m.user.id));

  return (
    <div className="space-y-4">
      {err && <Alert>{memberError(err)}</Alert>}
      {isOwner && (
        <section aria-labelledby="add-member-h" className="rounded-lg p-4 ring-1 ring-stone-200 dark:ring-stone-700">
          <h3 id="add-member-h" className="mb-2 text-sm font-semibold">Add member</h3>
          <div className="flex flex-wrap items-end gap-3">
            <div className="relative w-full sm:w-80">
              <Input
                label="Search people"
                value={picked ? `${picked.name} <${picked.email}>` : search}
                onChange={(e) => {
                  setPicked(null);
                  setSearch(e.target.value);
                }}
                hint="Type at least 2 characters"
                autoComplete="off"
                role="combobox"
                aria-expanded={!!dir.data && !picked}
                aria-controls="dir-results"
              />
              {!picked && debounced.length >= 2 && dir.data && (
                <ul id="dir-results" role="listbox" className="absolute z-10 mt-1 max-h-60 w-full overflow-auto rounded-md bg-white shadow-lg ring-1 ring-stone-200 dark:bg-stone-800 dark:ring-stone-700">
                  {dir.data.users.length === 0 && <li className="px-3 py-2 text-sm text-stone-500">No matches</li>}
                  {dir.data.users.map((u) => (
                    <li key={u.id} role="option" aria-selected={false}>
                      <button type="button" className="w-full px-3 py-2 text-left text-sm hover:bg-stone-100 focus:bg-stone-100 dark:hover:bg-stone-700" onClick={() => setPicked(u)}>
                        {u.name} <span className="text-stone-500">{u.email}</span>
                        {existing.has(u.id) && <span className="ml-1 text-xs text-stone-500">(member)</span>}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <Select label="Role" value={newRole} onChange={(v) => setNewRole(v as Role)} options={roleOptions} />
            <Button disabled={!picked} loading={set.isPending} onClick={() => picked && set.mutate({ userId: picked.id, r: newRole })}>
              Add
            </Button>
          </div>
        </section>
      )}

      {q.isLoading && <Spinner />}
      {q.error && <Alert>{errorMessage(q.error)}</Alert>}
      {q.data && (
        <div className="overflow-x-auto rounded-lg ring-1 ring-stone-200 dark:ring-stone-700">
          <table className="min-w-full divide-y divide-stone-200 text-sm dark:divide-stone-700">
            <caption className="sr-only">Members of {env.name}</caption>
            <thead className="bg-stone-50 text-left text-xs font-semibold uppercase text-stone-600 dark:bg-stone-800 dark:text-stone-300">
              <tr>
                <th scope="col" className="px-3 py-2">Name</th>
                <th scope="col" className="px-3 py-2">Email</th>
                <th scope="col" className="px-3 py-2">Role</th>
                <th scope="col" className="px-3 py-2">Access until</th>
                {isOwner && <th scope="col" className="px-3 py-2"><span className="sr-only">Actions</span></th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100 dark:divide-stone-800">
              {q.data.members.map((m) => (
                <tr key={m.user.id}>
                  <th scope="row" className="px-3 py-2 text-left font-medium">{m.user.name}</th>
                  <td className="px-3 py-2">{m.user.email}</td>
                  <td className="px-3 py-2">
                    {isOwner ? (
                      <Select label={`Role for ${m.user.name}`} className="[&>label]:sr-only" value={m.role} onChange={(v) => set.mutate({ userId: m.user.id, r: v as Role })} options={roleOptions} disabled={set.isPending} />
                    ) : (
                      <RoleBadge role={m.role} />
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs">{m.expiresAt ? `Time-boxed until ${formatDateTime(m.expiresAt)}` : 'Permanent'}</td>
                  {isOwner && (
                    <td className="px-3 py-2 text-right">
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={remove.isPending}
                        onClick={() => window.confirm(`Remove ${m.user.name} from ${env.name}?`) && remove.mutate(m.user.id)}
                      >
                        Remove
                      </Button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
