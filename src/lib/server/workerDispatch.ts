export interface WorkerChunkDispatchResult {
  started: boolean;
  status: number;
  body: any;
  failureCode?: "protection_redirect" | "worker_auth_rejected" | "worker_route_missing" | "worker_http_error" | "invalid_acknowledgement";
}

/** Executes one bounded worker chunk and waits for its acknowledgement. */
export async function dispatchWorkerChunk(
  baseUrl: string,
  jobId: string,
  expectedStep: number,
  headers: Record<string, string>,
  timeoutMs = 45_000,
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
