/**
 * Pure pieces of the Resend request body (no imports, no Deno, no network): the validation of an unsubscribe URL and the
 * assembly of the payload. index.ts renders the template and calls assembleResendPayload; the tests import this file directly.
 */
/** A usable List-Unsubscribe target: a string, at most 2048 characters, a well-formed https URL, no angle brackets, spaces or control characters (it goes into a header). */
export function isValidUnsubscribeUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) return false;
  if (/[\s<>"\u0000-\u001f\u007f]/.test(value)) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/** RFC 8058 one-click unsubscribe headers for a Resend payload. */
export function unsubscribeHeaders(url: string): Record<string, string> {
  return { "List-Unsubscribe": `<${url}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" };
}

/**
 * The variables to render with. When an `unsubscribeUrl` is given and the caller did not supply `UnsubscribeURL`, it is injected as
 * `UnsubscribeURL`, so the visible footer link of the news template always equals the List-Unsubscribe target (whatever the deployment order).
 */
export function renderVarsWithUnsubscribe<T extends Record<string, unknown>>(vars: T, unsubscribeUrl?: string): T & { UnsubscribeURL?: string } {
  if (!unsubscribeUrl) return vars;
  const given = (vars as Record<string, unknown>).UnsubscribeURL;
  if (given !== undefined && given !== null && String(given) !== "") return vars;
  return { ...vars, UnsubscribeURL: unsubscribeUrl };
}

/**
 * The Resend payload. The List-Unsubscribe headers are added ONLY when `unsubscribeUrl` is given, so every other caller's payload is
 * exactly { from, to, subject, html }, as before.
 */
export function assembleResendPayload(from: string, rendered: { subject: string; html: string }, to: string, unsubscribeUrl?: string) {
  return {
    from,
    to: [to],
    subject: rendered.subject,
    html: rendered.html,
    ...(unsubscribeUrl ? { headers: unsubscribeHeaders(unsubscribeUrl) } : {}),
  };
}
