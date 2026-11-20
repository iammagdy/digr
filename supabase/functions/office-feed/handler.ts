export const OFFICE_BUCKET = "office-status";
export const OFFICE_OBJECT_PATH = "status.json";
export const MAX_BODY_BYTES = 65_536;
export const CACHE_CONTROL_SECONDS = 15;

export interface OfficeFeedEnv {
  feedToken: string;
  supabaseUrl: string;
  serviceKey: string;
}

export interface OfficeFeedDeps {
  fetcher?: typeof fetch;
  log?: (...args: unknown[]) => void;
  timeoutMs?: number;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Constant-time equality check (returns false when either side is empty). */
export function constantTimeEqual(a: string, b: string): boolean {
  if (!a || !b) return false;
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  const n = Math.max(x.length, y.length);
  let diff = x.length ^ y.length;
  for (let i = 0; i < n; i++) {
    diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  }
  return diff === 0;
}

async function readBodyCapped(req: Request, maxBytes: number): Promise<{ tooLarge: true } | { tooLarge: false; text: string }> {
  const rawLen = req.headers.get("content-length");
  if (rawLen !== null && rawLen.trim() !== "") {
    const parsedLen = Number(rawLen);
    if (Number.isFinite(parsedLen) && parsedLen > maxBytes) {
      await req.body?.cancel().catch(() => undefined);
      return { tooLarge: true };
    }
  }
  if (!req.body) {
    return { tooLarge: false, text: "" };
  }
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { tooLarge: true };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  return { tooLarge: false, text: new TextDecoder().decode(merged) };
}

export async function handleOfficeFeedRequest(
  req: Request,
  env: OfficeFeedEnv,
  deps: OfficeFeedDeps = {},
): Promise<Response> {
  const fetcher = deps.fetcher ?? fetch;
  const log = deps.log ?? console.info;
  const timeoutMs = deps.timeoutMs ?? 8_000;

  if (req.method !== "POST") {
    return json({ ok: false, error: "method_not_allowed" }, 405);
  }

  if (!env.feedToken || !env.supabaseUrl || !env.serviceKey) {
    log("office_feed_error", { code: "server_not_configured" });
    return json({ ok: false, error: "server_not_configured" }, 500);
  }

  const authHeader = req.headers.get("Authorization") ?? "";
  const bearer = /^Bearer (\S+)$/.exec(authHeader)?.[1] ?? "";
  if (!constantTimeEqual(bearer, env.feedToken)) {
    log("office_feed_error", { code: "unauthorized" });
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  const readResult = await readBodyCapped(req, MAX_BODY_BYTES);
  if (readResult.tooLarge) {
    log("office_feed_error", { code: "payload_too_large" });
    return json({ ok: false, error: "payload_too_large" }, 413);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readResult.text);
  } catch {
    log("office_feed_error", { code: "invalid_json" });
    return json({ ok: false, error: "invalid_json" }, 400);
  }

  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    (parsed as Record<string, unknown>).version !== 1
  ) {
    log("office_feed_error", { code: "invalid_payload" });
    return json({ ok: false, error: "invalid_payload" }, 400);
  }

  const baseUrl = env.supabaseUrl.replace(/\/+$/, "");
  const uploadUrl = `${baseUrl}/storage/v1/object/${OFFICE_BUCKET}/${OFFICE_OBJECT_PATH}`;
  const canonicalBody = JSON.stringify(parsed);

  let storageRes: Response;
  try {
    storageRes = await fetcher(uploadUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.serviceKey}`,
        apikey: env.serviceKey,
        "Content-Type": "application/json",
        "cache-control": `max-age=${CACHE_CONTROL_SECONDS}`,
        "x-upsert": "true",
      },
      body: canonicalBody,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    log("office_feed_error", { code: "storage_unreachable" });
    return json({ ok: false, error: "storage_upload_failed" }, 502);
  }

  await storageRes.body?.cancel().catch(() => undefined);
  if (!storageRes.ok) {
    log("office_feed_error", { code: "storage_upload_failed", status: storageRes.status });
    return json({ ok: false, error: "storage_upload_failed" }, 502);
  }

  log("office_feed_uploaded", { status: 200, bytes: canonicalBody.length });
  return json({ ok: true }, 200);
}
