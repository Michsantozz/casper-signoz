// Client-safe public API of the auth slice.
//
// Server-only modules (better-auth config, session access) are NOT re-exported
// here — importing this barrel from a Client Component must never pull the
// server graph (`@/server/email`, the drizzle client) into the client bundle.
// Those live in `index.server.ts`. See the FSD-Next "server and client public
// APIs" rule.
export * from "./model/auth-client";
export * from "./ui/AppShell";
export * from "./ui/LoginScreen";
export * from "./ui/OnboardingDialog";
