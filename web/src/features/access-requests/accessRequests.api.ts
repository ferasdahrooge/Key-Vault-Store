/** Access requests: ask for a role in an environment, list your own and the ones you can decide, approve or deny. */
import { api, seg } from '@/shared/api/client';
import type { AccessRequest, Role } from '@/shared/api/types';

// Ask for access to an environment.
export const requestAccess = (p: string, e: string, body: { role: Role; reason: string; durationMin: number }) =>
  api.post<{ request: AccessRequest }>(`/api/projects/${seg(p)}/envs/${seg(e)}/access-requests`, body);

// My requests plus the ones waiting for my decision.
export const listAccessRequests = () => api.get<{ mine: AccessRequest[]; toDecide: AccessRequest[] }>('/api/access-requests');

// Approve or deny a request.
export const decideAccessRequest = (id: string, approve: boolean) =>
  api.post<{ request: AccessRequest }>(`/api/access-requests/${seg(id)}/decide`, { approve });
