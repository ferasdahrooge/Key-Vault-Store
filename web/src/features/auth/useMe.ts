/** Query hook for the signed-in user and their MFA state. */
import { useQuery } from '@tanstack/react-query';
import { getMe } from './auth.api';

// React Query cache key for the current user.
export const ME_KEY = ['me'] as const;

/** Current user (GET /api/auth/me). Works in enrollment mode too. */
export function useMe() {
  return useQuery({ queryKey: ME_KEY, queryFn: getMe, staleTime: 60_000 });
}
