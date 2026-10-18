/** Home page: the projects you can see, their environments, and a way to request access. */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { listProjects } from './projects.api';
import { errorMessage } from '@/shared/api/client';
import type { Environment, Project } from '@/shared/api/types';
import { NewProjectDialog } from './NewProjectDialog';
import { RequestAccessDialog } from '@/features/access-requests/RequestAccessDialog';
import { Alert, Button, EmptyState, EnvChip, PageHeader, RoleBadge, Spinner } from '@/shared/components/ui';
import { useMe } from '@/features/auth/useMe';

/** One project with its environments; environments you can't see yet offer "Request access". */
function ProjectCard({ project, onRequest }: { project: Project; onRequest: (env: Environment) => void }) {
  // Environments the user can open (Compare needs at least two).
  const accessible = project.environments.filter((e) => e.role);
  return (
    <li className="rounded-lg bg-white p-4 shadow-sm ring-1 ring-stone-200 dark:bg-stone-900 dark:ring-stone-800">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="font-semibold">{project.name}</h2>
          <p className="font-mono text-xs text-stone-500">{project.slug}</p>
        </div>
        {accessible.length >= 2 && (
          <Link to={`/p/${encodeURIComponent(project.slug)}/compare`} className="text-sm text-brand-600 dark:text-brand-400 underline">
            Compare
          </Link>
        )}
      </div>
      {project.description && <p className="mt-2 text-sm text-stone-600 dark:text-stone-400">{project.description}</p>}
      <ul className="mt-4 space-y-2" aria-label={`${project.name} environments`}>
        {project.environments.map((env) =>
          env.role ? (
            <li key={env.id}>
              <Link
                to={`/p/${encodeURIComponent(project.slug)}/${encodeURIComponent(env.slug)}`}
                className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 hover:bg-stone-100 dark:hover:bg-stone-800"
              >
                <EnvChip name={env.name} slug={env.slug} color={env.color} isProtected={env.protected} />
                <RoleBadge role={env.role} />
              </Link>
            </li>
          ) : (
            <li key={env.id} className="flex items-center justify-between gap-2 px-2 py-1.5">
              <span className="opacity-50">
                <EnvChip name={env.name} slug={env.slug} color={env.color} isProtected={env.protected} />
              </span>
              <Button variant="ghost" size="sm" onClick={() => onRequest(env)} aria-label={`Request access to ${project.name} ${env.name}`}>
                Request access
              </Button>
            </li>
          ),
        )}
      </ul>
    </li>
  );
}

// Project list; admins can also create projects.
export function DashboardPage() {
  const me = useMe();
  const q = useQuery({ queryKey: ['projects'], queryFn: listProjects });
  const [newOpen, setNewOpen] = useState(false);
  // Environment the user is requesting access to, if any.
  const [req, setReq] = useState<{ project: Project; env: Environment } | null>(null);

  return (
    <>
      <PageHeader
        title="Projects"
        actions={me.data?.user.isAdmin && <Button onClick={() => setNewOpen(true)}>New project</Button>}
      />
      {q.isPending ? (
        <Spinner />
      ) : q.isError ? (
        <Alert>{errorMessage(q.error)}</Alert>
      ) : q.data.projects.length === 0 ? (
        <EmptyState title="No projects yet">{me.data?.user.isAdmin ? 'Create the first project.' : 'Ask an admin to add you to a project.'}</EmptyState>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {q.data.projects.map((p) => (
            <ProjectCard key={p.id} project={p} onRequest={(env) => setReq({ project: p, env })} />
          ))}
        </ul>
      )}
      {me.data?.user.isAdmin && <NewProjectDialog open={newOpen} onClose={() => setNewOpen(false)} />}
      {req && <RequestAccessDialog open onClose={() => setReq(null)} project={req.project} env={req.env} />}
    </>
  );
}
