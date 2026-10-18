/** Projects and environments: list, create, settings, DEK rotation and the cross-environment compare view. */
import { api, seg } from '@/shared/api/client';
import type { CompareResponse, Environment, NewEnvironmentInput, Project } from '@/shared/api/types';

// Projects visible to the user.
export const listProjects = () => api.get<{ projects: Project[] }>('/api/projects');

/** Server responds `{ project }` (same shape as a list item). */
export const getProject = async (p: string): Promise<Project> =>
  (await api.get<{ project: Project }>(`/api/projects/${seg(p)}`)).project;

// Create a project (admin).
export const createProject = (body: {
  slug: string;
  name: string;
  description?: string;
  environments?: NewEnvironmentInput[];
}) => api.post<{ project: Project }>('/api/projects', body);

// Add an environment to a project (admin).
export const createEnvironment = (p: string, body: NewEnvironmentInput) =>
  api.post<{ environment: Environment }>(`/api/projects/${seg(p)}/envs`, body);

// Change an environment's name, colour or protection.
export const updateEnvironment = (
  p: string,
  e: string,
  body: { name?: string; color?: string; protected?: boolean; confirm?: string },
) =>
  api.patch<{ environment: Environment }>(`/api/projects/${seg(p)}/envs/${seg(e)}`, body);

/** Protected environments require `confirm` = env slug (enforced server-side). */
export const rotateKey = (p: string, e: string, confirm?: string) =>
  api.post<{ ok: boolean; dekVersion: number; reencrypted: number }>(
    `/api/projects/${seg(p)}/envs/${seg(e)}/rotate-key`,
    confirm ? { confirm } : {},
  );

// Which keys exist in which environments.
export const compare = (p: string, envs?: string[]) =>
  api.get<CompareResponse>(`/api/projects/${seg(p)}/compare`, { query: { envs: envs?.join(',') } });
