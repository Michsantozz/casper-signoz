import "server-only";

/**
 * Explicit operator allowlist for workspace-wide operational capabilities.
 *
 * This is intentionally independent of "authenticated": the SRE agent can read
 * telemetry for the whole deployment and the health route can mutate SigNoz.
 * With neither allowlist configured, authorization fails closed.
 */
type OperatorCandidate = {
  id?: string | null;
  email?: string | null;
};

function csvSet(value: string | undefined, normalize = false): Set<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => (normalize ? item.toLowerCase() : item)),
  );
}

export function isOperator(candidate: OperatorCandidate | null | undefined) {
  if (!candidate) return false;

  const ids = csvSet(process.env.OPERATOR_USER_IDS);
  if (candidate.id && ids.has(candidate.id)) return true;

  const emails = csvSet(process.env.OPERATOR_EMAILS, true);
  return Boolean(
    candidate.email && emails.has(candidate.email.trim().toLowerCase()),
  );
}
