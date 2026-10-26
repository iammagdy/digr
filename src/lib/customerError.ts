/**
 * What a customer reads when a request fails. A browser or platform error («Failed to fetch», «Unexpected token <», a stack
 * message) is never shown: it becomes one Arabic sentence, and a safe reason code goes to the console instead.
 */
import { START_UNKNOWN_AR, startFailureText, type StartedJobState } from "./startFailure";


/** For the chat, where a turn never spends anything. */
export const TEMPORARY_FAILURE_NO_CHARGE_AR = "حصل تعثر مؤقت، لم يُخصم أي رصيد، جرّب مرة أخرى.";
/** For actions that may touch the balance: no promise about the balance that the client cannot know. */
export const TEMPORARY_FAILURE_AR = "حصل تعثر مؤقت، جرّب مرة أخرى بعد قليل.";

/** A failed response from our own API: the status and the server's safe reason code travel with it. */
export class ChatRequestError extends Error {
  readonly status: number;
  readonly reason: string;
  constructor(message: string, status: number, reason = "") {
    super(message);
    this.name = "ChatRequestError";
    this.status = status;
    this.reason = reason;
  }
}

/** Arabic only, and nothing that looks like an internal word (Latin letters, ids, placeholders). */
export function isCustomerSafeArabic(text: unknown): text is string {
  if (typeof text !== "string") return false;
  const value = text.trim();
  if (!value || value.length > 400) return false;
  if (!/[؀-ۿ]/.test(value)) return false;
  if (/[A-Za-z]/.test(value)) return false;
  if (/undefined|null|NaN|\[object/i.test(value)) return false;
  return true;
}

/**
 * Server reason codes whose cause is the request itself (no capability, no price that can be built): the same text sent again fails the
 * same way. The server already words them for a customer, so that sentence is shown as it is and no «try again» button is offered.
 */
const DETERMINISTIC_FAILURE_REASONS: ReadonlySet<string> = new Set(["plan_build_failed", "capability_not_found", "unsupported_platform"]);

/** False for a failure that a repeat of the same request cannot change; true for a network drop, a timeout or a server hiccup. */
export function isRetryableFailure(err: unknown): boolean {
  return !(err instanceof ChatRequestError && DETERMINISTIC_FAILURE_REASONS.has(err.reason));
}

export type FailureCode = "client_timeout" | "network" | "bad_response" | "server_error" | "client_error" | "unknown";

/** A short code that is safe to log: it never carries the message text. */
export function failureCode(err: unknown): string {
  if (err instanceof ChatRequestError) {
    if (err.reason) return `server:${err.reason}`.replace(/[^a-zA-Z0-9_:-]/g, "_").slice(0, 64);
    return err.status >= 500 ? `server_${err.status}` : `client_${err.status}`;
  }
  const name = err && typeof err === "object" ? String((err as { name?: unknown }).name || "") : "";
  const message = err && typeof err === "object" ? String((err as { message?: unknown }).message || "") : "";
  if (name === "AbortError" || /aborted|timeout/i.test(message)) return "client_timeout";
  if (name === "TypeError" || /failed to fetch|load failed|networkerror|network request failed/i.test(message)) return "network";
  if (name === "SyntaxError" || /unexpected token|json/i.test(message)) return "bad_response";
  return "unknown";
}

/**
 * The sentence for a failure. A message the server wrote for a customer (a 4xx in clean Arabic: a short rate-limit wait, a
 * length limit, a missing sign-in) passes through; anything else — a network drop, a timeout, a 5xx, an unreadable body,
 * an English or technical message — becomes the temporary-failure sentence.
 */
export function customerFacingFailure(
  err: unknown,
  options: { fallback?: string; noCharge?: boolean } = {},
): { text: string; code: string } {
  const code = failureCode(err);
  const temporary = options.noCharge ? TEMPORARY_FAILURE_NO_CHARGE_AR : (options.fallback || TEMPORARY_FAILURE_AR);
  const message = err && typeof err === "object" ? (err as { message?: unknown }).message : undefined;
  const deliberate = err instanceof ChatRequestError
    ? (err.status >= 400 && err.status < 500 && err.status !== 408) || !isRetryableFailure(err)
    : code === "unknown";
  if (deliberate && isCustomerSafeArabic(message)) return { text: message.trim(), code };
  return { text: temporary, code };
}

/** Parse a response of ours. A platform error page (not JSON) is a failure with a code, never a parse error shown as text. */
export async function readChatResponse(res: Response): Promise<any> {
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    throw new ChatRequestError("", res.status || 502, "bad_response");
  }
  if (!res.ok || !data?.success) {
    throw new ChatRequestError(typeof data?.error === "string" ? data.error : "", res.status, typeof data?.reason === "string" ? data.reason : "");
  }
  return data;
}

export function logClientFailure(scope: string, code: string): void {
  console.warn(`[chat:client_failure] scope=${scope} code=${code}`);
}

/** The sentence for a failed start when the page could not check whether the request began (see startFailure.ts for the rule). */
export function startFailureMessageAr(err: unknown, jobState: StartedJobState = "unknown"): string {
  const failure = customerFacingFailure(err);
  const text = startFailureText({ deliberateText: failure.text !== TEMPORARY_FAILURE_AR ? failure.text : null, jobState });
  return text ?? START_UNKNOWN_AR;
}
