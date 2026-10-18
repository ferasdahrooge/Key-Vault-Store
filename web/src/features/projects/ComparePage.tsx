/** Compare: keys × environments presence matrix (no values). Route /p/:project/compare. */
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { errorMessage } from '@/shared/api/client';
import { compare, getProject } from './projects.api';
import { Alert, EmptyState, EnvChip, PageHeader, Spinner } from '@/shared/components/ui';
import { formatDateTime } from '@/shared/lib/format';

// Shows which secret keys exist in which environments of a project.
export function ComparePage() {
  const { project = '' } = useParams();
  const projQ = useQuery({ queryKey: ['project', project], queryFn: () => getProject(project), enabled: !!project });
  // Only environments the user is a member of; all selected by default.
  const accessible = projQ.data?.environments.filter((e) => e.role !== null) ?? [];
  const [selected, setSelected] = useState<string[] | null>(null);
  const envs = selected ?? accessible.map((e) => e.slug);

  // Presence matrix for the selected environments.
  const cmpQ = useQuery({
    queryKey: ['compare', project, envs],
    queryFn: () => compare(project, envs),
    enabled: !!projQ.data && envs.length > 0,
  });

  // Add or remove an environment column.
  const toggle = (slug: string) => {
    const next = envs.includes(slug) ? envs.filter((s) => s !== slug) : [...envs, slug];
    // keep project order
    setSelected(accessible.map((e) => e.slug).filter((s) => next.includes(s)));
  };

  if (projQ.isLoading) return <div className="p-6"><Spinner /></div>;
  if (projQ.error) return <div className="p-6"><Alert>{errorMessage(projQ.error)}</Alert></div>;
  const proj = projQ.data;
  if (!proj) return null;
  // Column order and lookup for environment names.
  const cols = cmpQ.data?.envs ?? [];
  const envBySlug = new Map(proj.environments.map((e) => [e.slug, e]));

  return (
    <div className="space-y-4 p-4 sm:p-6">
      <PageHeader title={`${proj.name} · Compare`} subtitle={<Link to="/" className="text-brand-600 dark:text-brand-400 hover:underline">Back to projects</Link>} />
      {accessible.length === 0 && <EmptyState title="You are not a member of any environment in this project" />}
      {accessible.length > 0 && (
        <fieldset>
          <legend className="text-sm font-medium">Environments</legend>
          <div className="mt-1 flex flex-wrap gap-3">
            {accessible.map((e) => (
              <label key={e.slug} className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={envs.includes(e.slug)} onChange={() => toggle(e.slug)} />
                <EnvChip name={e.name} slug={e.slug} color={e.color} isProtected={e.protected} />
              </label>
            ))}
          </div>
        </fieldset>
      )}
      {cmpQ.isLoading && <Spinner />}
      {cmpQ.error && <Alert>{errorMessage(cmpQ.error)}</Alert>}
      {cmpQ.data && cmpQ.data.keys.length === 0 && <EmptyState title="No secrets in the selected environments" />}
      {cmpQ.data && cmpQ.data.keys.length > 0 && (
        <div className="overflow-x-auto rounded-lg ring-1 ring-stone-200 dark:ring-stone-700">
          <table className="min-w-full divide-y divide-stone-200 text-sm dark:divide-stone-700">
            <caption className="sr-only">Secret presence by environment</caption>
            <thead className="bg-stone-50 text-left text-xs font-semibold uppercase text-stone-600 dark:bg-stone-800 dark:text-stone-300">
              <tr>
                <th scope="col" className="px-3 py-2">Key</th>
                {cols.map((c) => (
                  <th key={c} scope="col" className="px-3 py-2">
                    <Link to={`/p/${encodeURIComponent(proj.slug)}/${encodeURIComponent(c)}`} className="hover:underline">{envBySlug.get(c)?.name ?? c}</Link>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100 dark:divide-stone-800">
              {cmpQ.data.keys.map((k) => (
                <tr key={k.key}>
                  <th scope="row" className="px-3 py-2 text-left font-mono">{k.key}</th>
                  {cols.map((c) => {
                    const p = k.presence[c];
                    return p?.exists ? (
                      <td key={c} className="px-3 py-2 text-emerald-700 dark:text-emerald-300" title={`Updated ${formatDateTime(p.updatedAt)}`}>
                        <span aria-hidden="true">✓</span> <span className="sr-only">present, </span>v{p.version}
                      </td>
                    ) : (
                      <td key={c} className="bg-red-50 px-3 py-2 font-medium text-red-700 dark:bg-red-950/40 dark:text-red-300">missing</td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
