/** Admin area (admins only): users and the audit log, as tabs. */
import { Navigate, useSearchParams } from 'react-router-dom';
import { PageHeader, cx } from '@/shared/components/ui';
import { useMe } from '@/features/auth/useMe';
import { AuditTab } from './tabs/AuditTab';
import { UsersTab } from './tabs/UsersTab';

// Admin tabs; the active one is kept in ?tab= so it survives reloads.
const TABS = [
  { id: 'users', label: 'Users' },
  { id: 'audit', label: 'Audit log' },
] as const;

// Non-admins are sent back to the home page.
export function AdminPage() {
  const me = useMe();
  const [sp, setSp] = useSearchParams();
  const tab = sp.get('tab') === 'audit' ? 'audit' : 'users';
  if (me.data && !me.data.user.isAdmin) return <Navigate to="/" replace />;
  return (
    <>
      <PageHeader title="Admin" />
      <div role="tablist" aria-label="Admin sections" className="mb-4 flex gap-1 border-b border-stone-200 dark:border-stone-800">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setSp({ tab: t.id }, { replace: true })}
            className={cx(
              '-mb-px border-b-2 px-3 py-2 text-sm font-medium',
              tab === t.id ? 'border-brand-600 text-brand-700 dark:text-brand-300' : 'border-transparent text-stone-600 dark:text-stone-400',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel">{tab === 'users' ? <UsersTab /> : <AuditTab />}</div>
    </>
  );
}
