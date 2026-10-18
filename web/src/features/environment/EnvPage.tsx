/** Environment view: /p/:project/:env?tab=secrets|members|tokens|exchange|settings|activity */
import { useQuery } from '@tanstack/react-query';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { errorMessage } from '@/shared/api/client';
import { getProject } from '@/features/projects/projects.api';
import type { Role } from '@/shared/api/types';
import { Alert, EmptyState, EnvChip, LockIcon, PageHeader, RoleBadge, Spinner, cx } from '@/shared/components/ui';
import { ActivityTab } from './tabs/activity/ActivityTab';
import { ExchangeTab } from './tabs/exchange/ExchangeTab';
import { MembersTab } from './tabs/members/MembersTab';
import { SecretsTab } from './tabs/secrets/SecretsTab';
import { SettingsTab } from './tabs/settings/SettingsTab';
import { TokensTab } from './tabs/tokens/TokensTab';

// Tabs and the minimum role needed to see each one.
export type TabId = 'secrets' | 'members' | 'tokens' | 'exchange' | 'settings' | 'activity';
const RANK: Record<Role, number> = { viewer: 1, editor: 2, owner: 3 };
const TABS: { id: TabId; label: string; min: Role }[] = [
  { id: 'secrets', label: 'Secrets', min: 'viewer' },
  { id: 'members', label: 'Members', min: 'viewer' },
  { id: 'tokens', label: 'Tokens', min: 'owner' },
  { id: 'exchange', label: 'Import / Export', min: 'editor' },
  { id: 'settings', label: 'Settings', min: 'owner' },
  { id: 'activity', label: 'Activity', min: 'owner' },
];

// Environment page: header, protected banner, tabs and the active tab's content.
export function EnvPage() {
  const { project = '', env: envSlug = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const q = useQuery({ queryKey: ['project', project], queryFn: () => getProject(project), enabled: !!project });

  if (q.isLoading) return <div className="p-6"><Spinner /></div>;
  if (q.error) return <div className="p-6"><Alert>{errorMessage(q.error, 'Could not load the project.')}</Alert></div>;
  const proj = q.data;
  // Find the environment from the URL.
  const env = proj?.environments.find((e) => e.slug === envSlug);
  if (!proj || !env) return <div className="p-6"><EmptyState title="Environment not found" /></div>;

  const role = env.role;
  const header = (
    <PageHeader
      title={
        <span className="flex flex-wrap items-center gap-2">
          <Link to="/" className="text-stone-500 hover:underline">{proj.name}</Link>
          <span aria-hidden="true">/</span>
          <EnvChip name={env.name} slug={env.slug} color={env.color} isProtected={env.protected} />
        </span>
      }
      subtitle={<RoleBadge role={role} />}
      actions={<Link to={`/p/${encodeURIComponent(proj.slug)}/compare`} className="text-sm font-medium text-brand-600 dark:text-brand-400 hover:underline dark:text-brand-400">Compare environments</Link>}
    />
  );

  // Not a member: explain how to request access.
  if (!role) {
    return (
      <div className="space-y-4 p-4 sm:p-6">
        {header}
        <EmptyState title="You don't have access to this environment">
          Ask an owner for access, or use <strong>Request access</strong> on the projects dashboard to request time-boxed access.
          <div className="mt-3"><Link to="/" className="text-brand-600 dark:text-brand-400 hover:underline">Back to projects</Link></div>
        </EmptyState>
      </div>
    );
  }

  // Only show tabs the role allows; fall back to Secrets for an unknown ?tab.
  const visible = TABS.filter((t) => RANK[role] >= RANK[t.min]);
  const requested = params.get('tab') as TabId | null;
  const tab: TabId = visible.some((t) => t.id === requested) ? (requested as TabId) : 'secrets';
  // Exchange tab is visible to editors (import); export inside it is owner-only.

  return (
    <div className="space-y-4 p-4 sm:p-6">
      {env.protected && (
        <div role="note" className="flex items-center gap-2 rounded-md bg-red-600 px-4 py-3 text-sm font-bold uppercase tracking-wide text-white">
          <LockIcon className="size-5" />
          <span>Production · protected</span>
          <span className="font-normal normal-case">Changes require typing the environment slug.</span>
        </div>
      )}
      {header}
      <nav aria-label="Environment sections" className="-mx-4 overflow-x-auto border-b border-stone-200 px-4 dark:border-stone-700 sm:mx-0 sm:px-0">
        <ul className="flex gap-1">
          {visible.map((t) => (
            <li key={t.id}>
              <Link
                to={{ search: `?tab=${t.id}` }}
                onClick={(e) => {
                  e.preventDefault();
                  setParams({ tab: t.id });
                }}
                aria-current={tab === t.id ? 'page' : undefined}
                className={cx(
                  'block whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium',
                  tab === t.id ? 'border-brand-600 text-brand-700 dark:text-brand-300' : 'border-transparent text-stone-600 hover:border-stone-300 dark:text-stone-400 dark:hover:border-stone-600',
                )}
              >
                {t.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <div key={`${project}/${env.slug}`}>
        {tab === 'secrets' && <SecretsTab project={project} env={env} role={role} />}
        {tab === 'members' && <MembersTab project={project} env={env} role={role} />}
        {tab === 'tokens' && <TokensTab project={project} env={env} />}
        {tab === 'exchange' && <ExchangeTab project={project} env={env} role={role} />}
        {tab === 'settings' && <SettingsTab key={`${env.name}|${env.color}|${env.protected}`} project={project} env={env} />}
        {tab === 'activity' && <ActivityTab env={env} />}
      </div>
    </div>
  );
}
