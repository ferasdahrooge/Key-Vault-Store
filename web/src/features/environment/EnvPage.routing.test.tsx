import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '@/shared/api/types';
import { ToastProvider } from '@/shared/components/Toast';

vi.mock('@/features/projects/projects.api', () => ({ getProject: vi.fn() }));
vi.mock('./tabs/secrets/secrets.api', () => ({ listSecrets: vi.fn().mockResolvedValue({ secrets: [] }) }));

import * as projects from '@/features/projects/projects.api';
import { EnvPage } from './EnvPage';

// A project with one environment per role.
const project: Project = {
  id: 'p1',
  slug: 'app',
  name: 'App',
  description: null,
  environments: [
    { id: 'e1', slug: 'dev', name: 'Dev', color: 'green', protected: false, role: 'viewer' },
    { id: 'e2', slug: 'prod', name: 'Prod', color: 'red', protected: true, role: null },
    { id: 'e3', slug: 'staging', name: 'Staging', color: 'amber', protected: true, role: 'owner' },
  ],
};

// Renders the env page at a given URL.
function renderAt(path: string) {
  (projects.getProject as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(project);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/p/:project/:env" element={<EnvPage />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

afterEach(cleanup);

// Tab visibility and ?tab= handling per role.
describe('EnvPage', () => {
  it('shows no-access hint when role is null', async () => {
    renderAt('/p/app/prod');
    expect(await screen.findByText("You don't have access to this environment")).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Environment sections' })).not.toBeInTheDocument();
  });

  it('viewer sees only secrets and members tabs', async () => {
    renderAt('/p/app/dev?tab=settings');
    const nav = await screen.findByRole('navigation', { name: 'Environment sections' });
    expect(nav).toHaveTextContent('Secrets');
    expect(nav).toHaveTextContent('Members');
    expect(nav).not.toHaveTextContent('Settings');
    expect(nav).not.toHaveTextContent('Tokens');
    expect(screen.queryByText(/Production · protected/)).not.toBeInTheDocument();
  });

  it('owner of protected env sees banner and all tabs', async () => {
    renderAt('/p/app/staging');
    expect(await screen.findByText('Production · protected')).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Environment sections' });
    for (const t of ['Secrets', 'Members', 'Tokens', 'Import / Export', 'Settings', 'Activity']) expect(nav).toHaveTextContent(t);
  });
});
