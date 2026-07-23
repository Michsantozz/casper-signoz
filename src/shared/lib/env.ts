// Generic env accessor — a leaf util. Lives in shared/ so every layer
// (server, mastra, shared/db) can depend DOWN on it, never up.
export function requireEnv(name: string) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}
