import { QueryClient } from '@tanstack/react-query';
import { ApiError } from '@/shared/api/client';

// Shared React Query client: 15 s freshness, retry only server errors, never retry mutations.
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      refetchOnWindowFocus: true,
      retry: (count, err) => {
        if (err instanceof ApiError && err.status < 500) return false;
        return count < 2;
      },
    },
    mutations: {
      retry: false,
      gcTime: 0,
    },
  },
});
