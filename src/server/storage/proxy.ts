import "server-only";
import { presignServerReachableUrl } from "@/server/storage/s3";

/**
 * Same-origin streaming proxy for meeting media (video/audio).
 *
 * The clip button (mediabunny `UrlSource`) and the <video> player fetch the
 * meeting recording from the browser. The recording lives in object storage
 * (MinIO/S3/R2) or on a Recall.ai signed URL — always a *different* origin,
 * often plain `http:` for local self-host MinIO. Two things break there:
 *
 *   - CSP: mediabunny streams via `fetch()` range requests, which fall under
 *     `connect-src` (not `media-src`). Our prod CSP is `connect-src 'self'
 *     https: wss:` — a cross-origin `http://minio:9200` request is blocked.
 *   - CORS: the object store doesn't send `Access-Control-Allow-Origin` for our
 *     app origin, so even a `https:` object URL fails the browser fetch.
 *
 * Serving the bytes through the app's own origin fixes both at once, without
 * relaxing the CSP or exposing storage credentials to the client. The route
 * handlers that call this stay responsible for authorization (session/RLS or
 * share token) — this helper is transport only.
 *
 * Range requests are forwarded verbatim so mediabunny's byte-range streaming
 * (and the <video> seek bar) keep working: we pass the client's `Range` header
 * upstream and mirror `206`/`Content-Range`/`Accept-Ranges` back down. Nothing
 * is buffered — the upstream body streams straight through.
 */

/** Upstream response headers worth mirroring back to the client. */
const FORWARDED_RESPONSE_HEADERS = [
  "content-type",
  "content-length",
  "content-range",
  "accept-ranges",
  "last-modified",
  "etag",
] as const;

/**
 * Streams `sourceUrl` back to the client through this origin, forwarding the
 * request's `Range` header and mirroring the upstream status/headers. Returns a
 * `Response` the route handler can return directly.
 */
export async function proxyMediaStream(
  sourceUrl: string,
  req: Request,
): Promise<Response> {
  const range = req.headers.get("range");
  // The bucket is private, so an anonymous GET 403s. Resolve the source to a
  // server-reachable, presigned (authenticated) URL: for objects in our bucket
  // this signs against the internal endpoint; Recall's own signed URLs pass
  // through untouched. Signature auth travels in the query string, so no cookies
  // or app auth headers leak to the object store.
  const upstreamUrl = await presignServerReachableUrl(sourceUrl);
  const upstream = await fetch(upstreamUrl, {
    // Only the Range header matters upstream.
    headers: range ? { range } : {},
    // Let the browser's own cache-control apply; don't cache credentialed media
    // at the fetch layer.
    cache: "no-store",
  }).catch(() => null);

  if (!upstream || !upstream.ok || !upstream.body) {
    // 502: the source (storage/Recall) failed, not the client's request.
    return new Response(null, { status: 502, statusText: "Bad Gateway" });
  }

  const headers = new Headers();
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  // Media is user-scoped; never let a shared cache hold it.
  headers.set("Cache-Control", "private, no-store");

  // Preserve 206 (partial) vs 200 (full) so range requests behave.
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}
