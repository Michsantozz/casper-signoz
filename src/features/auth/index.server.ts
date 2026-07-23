// Server-only public API of the auth slice.
//
// Never import this from a Client Component — it reaches better-auth, the
// drizzle client and `@/server/email`. Routes/RSC/Server Actions/tools import
// from here; the client uses the client-safe `index.ts`.
import "server-only";

export * from "./model/auth";
export * from "./model/session";
