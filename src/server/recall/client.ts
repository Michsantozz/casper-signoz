import "server-only";
import { requireEnv } from "@/shared/lib/env";

/**
 * Minimal REST client for the Recall.ai API.
 *
 * Auth: header `Authorization: Token <RECALL_API_KEY>`.
 * Regional base URL (RECALL_REGION) — resources are region-local; use the same
 * region where the account/API key was created. Default: us-east-1.
 *
 * Valid regions: us-west-2 | us-east-1 | eu-central-1 | ap-northeast-1.
 */

/** Default Recall region when RECALL_REGION is unset (resources are region-local). */
export const DEFAULT_REGION = "us-east-1";

function baseUrl(): string {
  const region = process.env.RECALL_REGION || DEFAULT_REGION;
  return `https://${region}.recall.ai`;
}

export class RecallError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "RecallError";
  }
}

/** Indicates ad-hoc bot pool depletion — retryable after ~30s. */
export class RecallAdhocPoolError extends RecallError {
  constructor(body: unknown) {
    super("Recall ad-hoc bot pool depleted (507). Retry in ~30s.", 507, body);
    this.name = "RecallAdhocPoolError";
  }
}

type RecallRequest = {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  /** Path relative to /api/, e.g.: "v1/bot/" or "v1/bot/<id>/leave_call/". */
  path: string;
  query?: Record<string, string | number | string[] | undefined>;
  body?: unknown;
};

// Bounded retry for transient failures. Only GETs are retried — they're
// idempotent, so a retried POST/PATCH/DELETE (e.g. schedule_bot) could
// double-act. 507 (ad-hoc pool depletion) is excluded: it has its own ~30s
// user-facing "try again" semantics, not an instant retry.
const MAX_RETRIES = 2; // total attempts = 3
const BASE_DELAY_MS = 300;
const REQUEST_TIMEOUT_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Executes an authenticated request against the Recall.ai REST API. */
export async function recallFetch<T = unknown>(req: RecallRequest): Promise<T> {
  const apiKey = requireEnv("RECALL_API_KEY");

  const url = new URL(`${baseUrl()}/api/${req.path}`);
  for (const [key, value] of Object.entries(req.query ?? {})) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) url.searchParams.append(key, v);
    } else {
      url.searchParams.set(key, String(value));
    }
  }

  const canRetry = req.method === "GET";

  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: req.method,
        headers: {
          Authorization: `Token ${apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: req.body === undefined ? undefined : JSON.stringify(req.body),
        // Bounds provider stalls. This is especially important for POST bot
        // creation, which may run while a per-dedup advisory lock is held.
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      // Network-level failure (no response). Retry idempotent reads, else rethrow.
      if (canRetry && attempt < MAX_RETRIES) {
        await sleep(BASE_DELAY_MS * 2 ** attempt + Math.floor(Math.random() * 100));
        continue;
      }
      throw err;
    }

    // 204 / empty body (e.g. some DELETEs) — returns undefined.
    const text = await res.text();
    const parsed = text ? safeJson(text) : undefined;

    if (!res.ok) {
      if (res.status === 507) throw new RecallAdhocPoolError(parsed);
      // Retry transient 5xx on idempotent reads with jittered backoff.
      if (canRetry && res.status >= 500 && attempt < MAX_RETRIES) {
        await sleep(BASE_DELAY_MS * 2 ** attempt + Math.floor(Math.random() * 100));
        continue;
      }
      throw new RecallError(
        `Recall API ${req.method} ${req.path} failed: ${res.status}`,
        res.status,
        parsed ?? text,
      );
    }

    return parsed as T;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
