/** User directory search, used when adding environment members. */
import { api } from '@/shared/api/client';
import type { DirectoryUser } from '@/shared/api/types';

// Find users by name or email.
export const searchDirectory = (q: string) => api.get<{ users: DirectoryUser[] }>('/api/users/directory', { query: { q } });
