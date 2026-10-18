/** Environment members: list, set a role (also adds a member), remove. */
import { api, seg } from '@/shared/api/client';
import type { Member, Role } from '@/shared/api/types';

// Base path for an environment's members.
const base = (p: string, e: string) => `/api/projects/${seg(p)}/envs/${seg(e)}/members`;

// Members of an environment.
export const listMembers = (p: string, e: string) => api.get<{ members: Member[] }>(base(p, e));

// Add a member or change their role.
export const setMember = (p: string, e: string, userId: string, role: Role) =>
  api.put<{ member: Member }>(`${base(p, e)}/${seg(userId)}`, { role });

// Remove a member.
export const removeMember = (p: string, e: string, userId: string) =>
  api.del<{ ok: boolean }>(`${base(p, e)}/${seg(userId)}`);
