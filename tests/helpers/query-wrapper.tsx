// Test wrapper for hooks that read/write through TanStack Query. Each call builds a FRESH
// QueryClient (no cross-test cache bleed) with retries OFF and the poll-on-refocus behaviors
// disabled, so a hook's query resolves deterministically in jsdom without background churn.
// Returns { wrapper, queryClient } — pass wrapper to renderHook, and use queryClient to assert
// cache state (getQueryData) or drive invalidation the way the app would.

import type { ReactNode } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

export function makeQueryWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        // deterministic: no window-focus/reconnect refetch racing the assertions.
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
        staleTime: 0,
        gcTime: Infinity,
      },
      mutations: { retry: false },
    },
  })

  function wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  }

  return { wrapper, queryClient }
}
