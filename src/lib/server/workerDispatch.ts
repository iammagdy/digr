export interface WorkerChunkDispatchResult {
  started: boolean;
  status: number;
  body: any;
  failureCode?: "protection_redirect" | "worker_auth_rejected" | "worker_route_missing" | "worker_http_error" | "invalid_acknowledgement" | "dispatch_timeout" | "dispatch_exception";
}

/**
 * How long the dispatcher waits for the worker's acknowledgement. The worker's own deadline is 45 s from its start (`route.ts`: `routeStart + 45_000`,
 * `maxDuration` 60) and a people chunk stops starting lookups 12 s before it (`PEOPLE_LOOKUP_RESERVE_MS`), so it finishes at about 33 s + 10 s of saving
 * and settling = 43 s. The dispatcher waits 55 s (the accept route's `maxDuration` is 60): 12 s of margin over a normal chunk, so a chunk that runs a
 * little late is still acknowledged instead of being mistaken for a failed start (the live job of 14:59 UTC: acknowledged after 49 s, aborted at 45 s).
 */
export const WORKER_DISPATCH_TIMEOUT_MS = 55_000;

/** Executes one bounded worker chunk and waits for its acknowledgement. */
export async function dispatchWorkerChunk(
  baseUrl: string,
  jobId: string,
  expectedStep: number,
  headers: Record<string, string>,
  timeoutMs = WORKER_DISPATCH_TIMEOUT_MS,
  fetcher: typeof fetch = fetch
): Promise<WorkerChunkDispatchResult> {
  const response = await fetcher(`${baseUrl}/api/worker/chunk`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ jobId, expectedStep }),
    signal: AbortSignal.timeout(timeoutMs),
    redirect: "manual",
  });
  const body = await response.json().catch(() => ({}));
  const started = response.ok && body?.success === true && body?.claimed !== false;
  const contentType = response.headers.get("content-type") || "";
  const failureCode = started
    ? undefined
    : (response.status >= 300 && response.status < 400) || contentType.includes("text/html")
      ? "protection_redirect"
      : response.status === 401 || response.status === 403
        ? "worker_auth_rejected"
        : response.status === 404
          ? "worker_route_missing"
          : response.status >= 500
            ? "worker_http_error"
            : "invalid_acknowledgement";
  return {
    // Treat SSO redirects, HTML protection pages, and malformed acknowledgments
    // as a failed start; fetch otherwise follows a redirect and can see HTML 200.
    started,
    status: response.status,
    body,
    failureCode,
  };
}
