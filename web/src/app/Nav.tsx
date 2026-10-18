/** Main navigation: projects, access requests (with a pending badge), admin, account and logout. */
import { NavLink, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { logout } from '@/features/auth/auth.api';
import { useAccessRequests } from '@/features/access-requests/useAccessRequests';
import { useMe } from '@/features/auth/useMe';
import { cx } from '@/shared/components/ui';

// Highlight the active nav link.
const linkCls = ({ isActive }: { isActive: boolean }) =>
  cx(
    'rounded-md px-3 py-2 text-sm font-medium',
    isActive
      ? 'bg-stone-200 text-stone-900 dark:bg-stone-800 dark:text-white'
      : 'text-stone-600 hover:bg-stone-100 dark:text-stone-300 dark:hover:bg-stone-800',
  );

// Header navigation; the Admin link only shows for admins.
export function Nav() {
  const me = useMe();
  const ar = useAccessRequests();
  const qc = useQueryClient();
  const navigate = useNavigate();
  // Number of requests waiting for my decision (shown as a badge).
  const pending = ar.data?.toDecide.filter((r) => r.status === 'pending').length ?? 0;

  // Log out, wipe cached data, go to the login page.
  const onLogout = async () => {
    try {
      await logout();
    } catch {
      // best effort: the server session may already be gone
    }
    qc.clear(); // drop every cached query so the next user starts clean
    void navigate('/login', { replace: true });
  };

  return (
    <nav aria-label="Main" className="flex flex-wrap items-center gap-1">
      <NavLink to="/" end className={linkCls}>
        Projects
      </NavLink>
      <NavLink to="/access-requests" className={linkCls}>
        Access requests
        {pending > 0 && (
          <span className="ml-1.5 rounded-full bg-brand-600 px-1.5 py-0.5 text-xs text-white">
            {pending}
            <span className="sr-only"> pending</span>
          </span>
        )}
      </NavLink>
      {me.data?.user.isAdmin && (
        <NavLink to="/admin" className={linkCls}>
          Admin
        </NavLink>
      )}
      <span className="mx-1 hidden h-5 w-px bg-stone-300 sm:inline-block dark:bg-stone-700" aria-hidden="true" />
      <NavLink to="/account" className={linkCls}>
        {me.data?.user.name ?? 'Account'}
      </NavLink>
      <button type="button" onClick={onLogout} className={linkCls({ isActive: false })}>
        Log out
      </button>
    </nav>
  );
}
