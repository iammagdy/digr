/**
 * One way for a screen to call our own API and to read what went wrong. It joins what each screen did by hand:
 *  - the sign-in token (a Bearer header, when a session exists),
 *  - a timeout, so a hung request ends instead of leaving the page waiting,
 *  - a safe read of the answer (a platform error page, an empty or broken JSON body never throws a parse error),
 *  - and ONE Arabic sentence for every failure, chosen by `customerFacingFailure` (src/lib/customerError.ts).
 *
 * A failure is thrown as an `ApiFetchError`: its `message` is already the Arabic sentence, so even a screen that still prints
 * `err.message` shows nothing technical. `code` is a safe short code for the console; it never carries message text.
 */
import { ChatRequestError, customerFacingFailure, isRetryableFailure } from "./customerError";

export const DEFAULT_API_TIMEOUT_MS = 30_000;

export interface ApiFetchOptions extends Omit<RequestInit, "body"> {
  /** A plain object is sent as JSON; a string or FormData is sent as it is. */
  body?: unknown;
  /** The request is cut after this long (default 30 s). */
  timeoutMs?: number;
  /** For a call that never spends anything (the chat): the sentence adds «لم يُخصم أي رصيد». */
  noCharge?: boolean;
  /** The sentence for a temporary failure, when the call may touch the balance. */
  fallback?: string;
  /** Overrides how the token is read (tests, server-side callers). Return "" for none. */
  getAccessToken?: () => Promise<string>;
}

export class ApiFetchError extends ChatRequestError {
  readonly code: string;
  readonly retryable: boolean;
  /** True when the caller's own signal cancelled the call (a page that closed): there is nothing to show. */
  readonly aborted: boolean;
  constructor(text: string, status: number, reason: string, code: string, retryable: boolean, aborted = false) {
    super(text, status, reason);
    this.name = "ApiFetchError";
    this.code = code;
    this.retryable = retryable;
    this.aborted = aborted;
  }
  /** The Arabic sentence for the customer (same as `message`). */
  get text(): string { return this.message; }
}

async function defaultAccessToken(): Promise<string> {
  try {
    const { createClient } = await import("./supabase/client");
    const { data: { session } } = await createClient().auth.getSession();
    return session?.access_token || "";
  } catch {
    return ""; // the cookie session still travels with the request
  }
}

/** Said when the caller asked for anything but one of our own `/api/` routes. Nothing is sent and no token is read. */
export const REQUEST_REFUSED_AR = "تعذّر إرسال الطلب. حدّث الصفحة وجرّب مرة أخرى.";

const PATH_BASE = "http://same-origin.invalid";

/**
 * The only address this helper will call: one of our own routes, `/api/...`, on this origin. The session token is attached to the request,
 * so it must never travel to another host: `https://other.example/x`, `//other.example/x`, `javascript:`, a backslash form and a path whose
 * `..` leaves `/api/` are all refused. The address is resolved the way the browser resolves it, and that RESOLVED path (never the raw text) is what is sent.
 */
export function safeApiPath(path: unknown): string | null {
  if (typeof path !== "string" || !path.startsWith("/api/")) return null;
  if (/[\\\u0000-\u001f\u007f]/.test(path)) return null;
  let url: URL;
  try { url = new URL(path, PATH_BASE); } catch { return null; }
  if (url.origin !== PATH_BASE || !url.pathname.startsWith("/api/")) return null;
  return url.pathname + url.search;
}

/** Only these English codes in `error` are read as a reason (they are the codes our routes use for a permanent failure); any other text is not a code. */
const ERROR_CODES_READ_AS_REASON: ReadonlySet<string> = new Set(["not_found", "bad_request"]);

/**
 * The server's reason code: its own `reason`, else an `error` that is exactly `not_found` or `bad_request` on a 4xx answer (a 5xx that carries
 * such a word is a server failure, so it stays temporary). A bare 404 (a page, an empty body, a proxy) is NOT a reason: it may be temporary.
 */
function reasonOf(data: unknown, status: number): string {
  const body = data && typeof data === "object" ? data as { reason?: unknown; error?: unknown } : {};
  if (typeof body.reason === "string" && body.reason) return body.reason;
  if (status >= 400 && status < 500 && typeof body.error === "string" && ERROR_CODES_READ_AS_REASON.has(body.error)) return body.error;
  return "";
}

function wrap(err: unknown, options: ApiFetchOptions, aborted: boolean): ApiFetchError {
  const failure = customerFacingFailure(err, { noCharge: options.noCharge, fallback: options.fallback });
  const status = err instanceof ChatRequestError ? err.status : 0;
  const reason = err instanceof ChatRequestError ? err.reason : "";
  return new ApiFetchError(failure.text, status, reason, failure.code, isRetryableFailure(err), aborted);
}

/** Reads the body once, as text, so a page that is not JSON is a coded failure and never a «Unexpected token» message. */
async function readBody(res: Response): Promise<{ data: unknown; parsed: boolean }> {
  let text = "";
  try { text = await res.text(); } catch { return { data: null, parsed: false }; }
  if (!text.trim()) return { data: null, parsed: res.ok };
  try { return { data: JSON.parse(text), parsed: true }; } catch { return { data: null, parsed: false }; }
}

/**
 * Calls one of our routes and returns its JSON. Success is `res.ok` and no `success: false` in the body (routes of the admin area
 * answer without a `success` field). Every failure throws an `ApiFetchError` with an Arabic `message`.
 */
export async function apiFetch<T = any>(path: string, options: ApiFetchOptions = {}): Promise<T> {
  // BEFORE the token is read or any request is built: a refused address never reaches `fetch` and never sees a credential
  const target = safeApiPath(path);
  if (target === null) throw new ApiFetchError(REQUEST_REFUSED_AR, 0, "bad_path", "bad_path", false);

  const { body, timeoutMs = DEFAULT_API_TIMEOUT_MS, noCharge: _noCharge, fallback: _fallback, getAccessToken, signal: callerSignal, headers: callerHeaders, ...init } = options;

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const onCallerAbort = () => controller.abort();
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort();
    else callerSignal.addEventListener("abort", onCallerAbort, { once: true });
  }

  try {
    const token = await (getAccessToken ?? defaultAccessToken)().catch(() => "");
    const isForm = typeof FormData !== "undefined" && body instanceof FormData;
    const isRaw = typeof body === "string" || isForm || (typeof Blob !== "undefined" && body instanceof Blob);
    const headers: Record<string, string> = {
      ...(body !== undefined && !isForm ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...Object.fromEntries(new Headers(callerHeaders).entries()),
    };
    // `redirect: "error"`: the Authorization header must not follow a redirect to another host (our routes do not redirect; a redirect is a failure)
    const res = await fetch(target, {
      cache: "no-store",
      ...init,
      credentials: "same-origin",
      redirect: "error",
      headers,
      signal: controller.signal,
      ...(body === undefined ? {} : { body: (isRaw ? body : JSON.stringify(body)) as BodyInit }),
    });
    const { data, parsed } = await readBody(res);
    // a page that is not JSON (a platform error page, an empty body) is never a permanent failure, even on a 404
    if (!parsed) throw new ChatRequestError("", res.status || 502, "bad_response");
    const failed = !res.ok || (data && typeof data === "object" && (data as { success?: unknown }).success === false);
    if (failed) {
      const message = data && typeof data === "object" && typeof (data as { error?: unknown }).error === "string" ? (data as { error: string }).error : "";
      throw new ChatRequestError(message, res.status, reasonOf(data, res.status));
    }
    return data as T;
  } catch (err) {
    if (err instanceof ApiFetchError) throw err;
    const callerCancelled = !timedOut && !!callerSignal?.aborted;
    // our own timeout is a plain failure with the temporary sentence; a caller's cancel carries the sentence too, flagged so the page can stay silent
    const source = timedOut ? Object.assign(new Error("timeout"), { name: "AbortError" }) : err;
    throw wrap(source, options, callerCancelled);
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", onCallerAbort);
  }
}
