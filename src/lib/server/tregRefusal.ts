/**
 * What a TREG refusal says about the KEY, as opposed to about one endpoint. Pure text rules, no I/O, shared by the key pool (a data call that answers 403) and the admin key
 * checker. Incident of 2026-10-30: a key's TREG organisation was suspended; every data call answered 403 «org suspended» while the free identity read still passed, so the
 * pool called the key «connected» for 15 hours. A 403 whose own words name the ACCOUNT is a verdict on the key; a bare 403 is not (one endpoint can refuse a plan).
 */
export type AccountRefusal = "org_suspended" | "account_disabled";

const STATE = "(?:suspend(?:ed)?|disabled|deactivated|banned|terminated|frozen)";
const ORG = "(?:org(?:ani[sz]ation)?|team|workspace|tenant)";
const ACCOUNT = "account";
// «org suspended», «organization is suspended», «account has been disabled»
const SUBJECT_THEN_STATE = new RegExp(`\\b(${ORG}|${ACCOUNT})\\b[^a-z0-9]{0,6}(?:\\w+\\s+){0,3}?${STATE}\\b`, "i");
// «suspended organization», "account banned" is covered above; «your account has been suspended» too
const STATE_THEN_SUBJECT = new RegExp(`\\b${STATE}\\b[^a-z0-9]{0,6}(?:\\w+\\s+){0,2}?(${ORG}|${ACCOUNT})\\b`, "i");

/** The fixed reason code of an account-level refusal, or null when the text does not name the account (the code is stored admin-only, never shown to a customer). */
export function accountRefusalReason(text: unknown): AccountRefusal | null {
  const t = typeof text === "string" ? text.slice(0, 600) : "";
  if (!t) return null;
  const m = SUBJECT_THEN_STATE.exec(t) ?? STATE_THEN_SUBJECT.exec(t);
  if (!m) return null;
  return new RegExp(`^${ORG}$`, "i").test(m[1]) ? "org_suspended" : "account_disabled";
}

/** The provider's own short words from an answer body (`detail`, `message`, `error`, `msg`), clipped, with every given secret redacted. Never throws. */
export function providerReasonText(body: unknown, secrets: readonly string[] = [], max = 160): string | null {
  let raw = "";
  if (typeof body === "string") raw = body;
  else if (body && typeof body === "object") {
    const o = body as Record<string, unknown>;
    for (const k of ["detail", "message", "error", "msg", "error_description"]) {
      const v = o[k];
      if (typeof v === "string" && v.trim()) { raw = v; break; }
      if (v && typeof v === "object") { try { raw = JSON.stringify(v); } catch { raw = ""; } if (raw) break; }
    }
  }
  return redactAndClip(raw, secrets, max);
}

/** Text safe to show an admin: secrets and token-shaped strings removed, whitespace collapsed, clipped. */
export function redactAndClip(raw: string, secrets: readonly string[] = [], max = 160): string | null {
  let t = String(raw ?? "");
  for (const s of secrets) if (typeof s === "string" && s.trim().length > 4) t = t.split(s.trim()).join("[REDACTED]");
  t = t
    .replace(/Bearer\s+[A-Za-z0-9_\-.]+/gi, "Bearer [REDACTED]")
    .replace(/treg_[A-Za-z0-9_\-]+/gi, "[REDACTED]")
    .replace(/sk-[A-Za-z0-9_\-]+/gi, "[REDACTED]")
    .replace(/[A-Fa-f0-9]{32,64}/g, "[REDACTED]")
    .replace(/\s+/g, " ")
    .trim();
  return t ? t.slice(0, max) : null;
}
