"use client";

import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * Global TanStack Query provider. Wraps the client tree in the layout.
 *
 * The QueryClient is created ONCE per mount via useState (not at module
 * scope) so it doesn't leak cache between requests in Next's SSR and doesn't
 * get recreated on every render.
 *
 * Defaults chosen for the meeting/notifications flow:
 *  - staleTime 3s: screens do short polling (5–8s); keeping a low staleTime
 *    avoids redundant refetches between re-renders without delaying updates.
 *  - refetchOnWindowFocus: revalidates when returning to the tab (new minutes
 *    may have arrived while the tab was in the background).
 *  - retry 1: /api routes are local; a real failure is network-related, not
 *    worth retrying further.
 */
export function QueryProvider({ children }: { children: React.ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 3_000,
            refetchOnWindowFocus: true,
            retry: 1,
          },
        },
      }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
