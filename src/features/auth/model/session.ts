import "server-only";
import { cache } from "react";
import { headers } from "next/headers";
import { auth } from "@/features/auth/model/auth";

/**
 * Resolves the current session server-side (routes/RSC/tools).
 *
 * Replaces the hardcoded `user_id`: the calendar and bots belong to the
 * authenticated user. Tools and routes derive the user_id from here, never
 * from a query param.
 *
 * Wrapped in `React.cache()`: chamado ~44× (getSession + requireUserId) — dentro
 * de um mesmo request/render, múltiplas chamadas (ex. requireUserId seguido de
 * outra lógica que lê a sessão) deduplicam o parse de cookie + lookup de sessão
 * numa única execução em vez de repetir por callsite.
 */
export const getSession = cache(async () => {
  return auth.api.getSession({ headers: await headers() });
});

/** Session user_id, or throws if unauthenticated. Use in protected routes. */
export async function requireUserId(): Promise<string> {
  const session = await getSession();
  if (!session?.user?.id) {
    throw new Error("unauthenticated");
  }
  return session.user.id;
}
