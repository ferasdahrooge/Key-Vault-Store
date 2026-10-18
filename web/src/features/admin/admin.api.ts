/** Admin user management (list users, enable/disable, grant/revoke admin, unlock). */
import { api, seg } from '@/shared/api/client';
import type { AdminUser } from '@/shared/api/types';

// All users (admin only).
export const listUsers = () => api.get<{ users: AdminUser[] }>('/api/admin/users');

// Change a user's status/admin flag or unlock them.
export const updateUser = (id: string, body: { status?: 'active' | 'disabled'; isAdmin?: boolean; unlock?: true }) =>
  api.patch<{ user: AdminUser }>(`/api/admin/users/${seg(id)}`, body);
