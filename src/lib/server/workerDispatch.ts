export interface WorkerChunkDispatchResult {
  started: boolean;
  status: number;
  body: any;
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
  return {
    // Treat SSO redirects, HTML protection pages, and malformed acknowledgments
    // as a failed start; fetch otherwise follows a redirect and can see HTML 200.
    started: response.ok && body?.success === true && body?.claimed !== false,
    status: response.status,
    body,
  };
}
