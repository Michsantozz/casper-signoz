"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";
import type { ComponentProps } from "react";

/**
 * next-themes wrapper. Applies/removes the `dark` class on <html> according
 * to the chosen theme (persisted in localStorage). Previously `dark` was
 * hardcoded in the layout; now the theme is toggleable from the UI (see
 * ThemeToggle in AppShell).
 */
export function ThemeProvider({
  children,
  ...props
}: ComponentProps<typeof NextThemesProvider>) {
  return <NextThemesProvider {...props}>{children}</NextThemesProvider>;
}
