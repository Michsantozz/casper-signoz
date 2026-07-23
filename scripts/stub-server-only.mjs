// Resolver hook: neutralize the `server-only` import guard when running the
// real server modules OUTSIDE the Next bundler (one-off enrichment runner).
export async function resolve(specifier, context, next) {
  if (specifier === "server-only" || specifier === "client-only") {
    // Point it at an empty data: module — import succeeds, no throw.
    return { url: "data:text/javascript,export{}", shortCircuit: true };
  }
  return next(specifier, context);
}
