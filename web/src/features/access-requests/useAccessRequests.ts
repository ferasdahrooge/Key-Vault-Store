/** Access requests query, polled every minute so the nav badge stays current. */
import { useQuery } from '@tanstack/react-query';
import { listAccessRequests } from './accessRequests.api';

// React Query cache key for access requests.
export const ACCESS_REQUESTS_KEY = ['access-requests'] as const;

export function useAccessRequests() {
  return useQuery({ queryKey: ACCESS_REQUESTS_KEY, queryFn: listAccessRequests, refetchInterval: 60_000 });
}
