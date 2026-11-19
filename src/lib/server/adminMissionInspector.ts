import { hasAddonMarker } from "../agentMission/addonMarker";
import { MISSION_CALLS_TABLE, MISSION_EVENTS_TABLE, MISSION_TABLE } from "../agentMission/constants";

/**
 * THE ADMIN MISSION INSPECTOR (DT-20261118-06 PR 2, Megz D-0104): ONE mission for the team's read-only admin account: the catalog calls made, their status / http status / failure reason, the rows returned, the errors, the state of each stage and
 * the planner's decision. Read-only BY CONSTRUCTION: this module only reads; the route that serves it exports GET alone.
 *
 * NO SECRETS AND NO CUSTOMER DATA, by two guards: (1) every field of the response is NAMED here (an allow-list: a new column of `missions` or `mission_calls` is invisible until it is named; there is no `select("*")`), and (2) every string passes `redactText`
 * (or the stricter `redactFailure` for the free text a provider or the model writes: a failure, an error) and a final walk throws when a string still looks like a secret (the route then answers 500, never a leak).
 * NEVER in the response: sample rows or any cell of a sample, `params_digest` VALUES (only the names of its keys), the customer's user id, e-mail or phone, storage paths or links, ledger / top-up / invoice rows, provider keys or any private setting, the worker id, the lease.
 * The customer's own request text is shown (the team reads what was asked) with e-mail addresses, phone numbers and tokens masked; names the customer wrote stay (stated, by design).
 */
export const INSPECT_CALL_LIMIT = 500;
export const INSPECT_EVENT_LIMIT = 500;
export const REDACTED = "[محجوب]";

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/gi;
const SK_KEY = /\b(?:sk|pk|rk)[-_][A-Za-z0-9_-]{6,}/g;
const JWT = /\beyJ[A-Za-z0-9_-]{6,}(?:\.[A-Za-z0-9_-]+)*/g;
const HEX_RUN = /\b[A-Fa-f0-9]{24,}\b/g;
const B64_RUN = /(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/_-]{32,}={0,2}(?![A-Za-z0-9+/_-])/g;
const URL_QUERY = /(https?:\/\/[^\s?#"'«»]+)\?[^\s"'«»]*/g;
/** a run of digits (Latin or Arabic-Indic) that can be a phone number: at least 7 digits, with the usual separators between them */
const PHONE = /(?<![\w.])\+?[0-9٠-٩](?:[0-9٠-٩ ()\-.]{5,}[0-9٠-٩])(?![\w])/g;
const digitsOf = (s: string): number => (s.match(/[0-9٠-٩]/g) ?? []).length;
/** a date or a date-time is consumed first, so its digits are never read as a phone number */
const DATE_TIME = "\\d{4}-\\d{2}-\\d{2}(?:[T ]\\d{2}:\\d{2}(?::\\d{2}(?:\\.\\d+)?)?Z?)?";
const DATE_OR_PHONE = new RegExp(`(${DATE_TIME})|${PHONE.source}`, "g");
const phoneRuns = (t: string): string[] => [...t.matchAll(DATE_OR_PHONE)].filter((m) => m[1] === undefined && digitsOf(m[0]) >= 7).map((m) => m[0]);

/** The text with every e-mail address, phone number, token, long hex / base64 run and URL query string replaced by one fixed marker. Anything else is returned byte for byte. */
export function redactText(text: unknown, max = 600): string {
  let t = typeof text === "string" ? text : text === null || text === undefined ? "" : String(text);
  t = t.replace(EMAIL, REDACTED).replace(BEARER, REDACTED).replace(SK_KEY, REDACTED).replace(JWT, REDACTED).replace(HEX_RUN, REDACTED).replace(URL_QUERY, `$1?${REDACTED}`).replace(B64_RUN, REDACTED);
  t = t.replace(DATE_OR_PHONE, (m, date) => (date !== undefined || digitsOf(m) < 7 ? m : REDACTED));
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

const QUOTED = /'[^']*'|"[^"]*"|«[^»]*»|`[^`]*`/g;
const URL_ANY = /https?:\/\/\S+|\bwww\.\S+/gi;
const HEADER_VALUE = /\b(?:x-)?(?:api[-_ ]?key|authorization|token|secret|password|key)\b\s*[:=]\s*\S+/gi;
const DIGIT_RUN = /[0-9٠-٩]{4,}/g;
const MIXED_TOKEN = /\b(?=[A-Za-z0-9_-]*[0-9])(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{6,}\b/g;
const SLUG_NAME = /\b[A-Za-z]+(?:-[A-Za-z0-9]+)+\b/g;
/** a Capitalised Latin word that is not the first of its sentence and not an acronym (a person's or a company's name written into an answer), and any word in Arabic letters (a provider's answer is English: Arabic in it is a name or the customer's own words) */
const NAME_WORD = /(?<=[a-z0-9,)]\s)[A-Z][a-z]{1,}\b/g;
const ARABIC_WORD = /[\u0600-\u06FF][\u0600-\u06FF\u064B-\u0652]*/g;
const PATH_NAME = /\/[A-Za-z0-9._~%-]{2,}(?:\/[A-Za-z0-9._~%-]+)+/g;
/**
 * The free text of a FAILURE or an ERROR (what a provider or the model wrote): the pattern masks of `redactText` are not enough for it (a short key echoed back, a person's name or a path in the answer), so here what carries a value is REMOVED, not masked:
 * quoted strings, URLs, header values («x-api-key: …»), runs of four or more digits, tokens that mix letters and digits, path-like names and hyphenated slugs («person john-doe not found» keeps «person not found»). A Capitalised word inside a sentence («for Hossam Elgendy») and any word in Arabic letters are removed too (a name, or the customer's own words). A lower-case name written like an ordinary word cannot be told from a word and stays: failures are cut to 200 characters and are read by the team only. What stays is the provider's own wording of the category («rate limit exceeded», «company not found», the HTTP status).
 */
export function redactFailure(text: unknown, max = 200): string {
  let t = redactText(text, 4000);
  t = t.replace(URL_ANY, " ").replace(HEADER_VALUE, " ").replace(QUOTED, " ").replace(PATH_NAME, " ").replace(SLUG_NAME, " ").replace(NAME_WORD, " ").replace(ARABIC_WORD, " ").replace(MIXED_TOKEN, " ").replace(DIGIT_RUN, " ").split(REDACTED).join(" ");
  t = t.replace(/\s{2,}/g, " ").replace(/\s+([,.:;،])/g, "$1").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

const PLANNING_FAILURE_PREFIX = "admin: planning_failed class=internal reason=";
const ERROR_DETAIL_SEPARATOR = " detail=";
const PLANNING_FAILURE_REASONS = new Set([
  "people_sources_failed", "people_sources_not_tried", "sources_failed",
  "planning_over_budget", "planning_daily_cap", "planning_recording_unavailable",
  "planning_missing_params", "lease_lost_past_timeout",
]);

/** The internal reason envelope carries code-owned facts before the generic text redactor runs. */
export function noCardReasonOf(error: unknown): { cls: "internal"; reason: string; rejectionCount?: number } | null {
  if (typeof error !== "string" || !error.startsWith(PLANNING_FAILURE_PREFIX)) return null;
  const reason = error.slice(PLANNING_FAILURE_PREFIX.length).split(ERROR_DETAIL_SEPARATOR, 1)[0];
  const rejections = /^plan_invalid_after_([1-9]\d?)_rejections$/.exec(reason);
  if (rejections?.[0] === reason) return { cls: "internal", reason: "plan_invalid", rejectionCount: Number(rejections[1]) };
  if (reason.startsWith("no_plan(")) return { cls: "internal", reason: "no_plan" };
  return PLANNING_FAILURE_REASONS.has(reason) ? { cls: "internal", reason } : null;
}

/** Only code-owned reason facts are shown. Provider and model details use the strict failure redactor. */
export function redactError(text: unknown, max = 300): string {
  const t = typeof text === "string" ? text : "";
  const at = t.indexOf(ERROR_DETAIL_SEPARATOR);
  if (t.startsWith(PLANNING_FAILURE_PREFIX)) {
    const reason = noCardReasonOf(t);
    const head = PLANNING_FAILURE_PREFIX + (reason?.reason ?? REDACTED);
    if (reason?.reason === "no_plan") return head.slice(0, max);
    const count = reason?.rejectionCount;
    const details = at < 0 ? "" : ERROR_DETAIL_SEPARATOR + redactFailure(t.slice(at + ERROR_DETAIL_SEPARATOR.length), 160);
    return (head + (count === undefined ? "" : ` rejections=${count}`) + details).slice(0, max);
  }
  if (at < 0) return redactText(t, max);
  return `${redactText(t.slice(0, at), 200)}${ERROR_DETAIL_SEPARATOR}${redactFailure(t.slice(at + ERROR_DETAIL_SEPARATOR.length), 160)}`.slice(0, max);
}

const PARAM_KEY = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
/** The NAMES of a call's inputs (never their values; keys the worker marks internal start with «_»). */
export function paramKeysOf(digest: unknown): string[] {
  if (!digest || typeof digest !== "object" || Array.isArray(digest)) return [];
  return Object.keys(digest as Record<string, unknown>).filter((k) => PARAM_KEY.test(k)).sort().slice(0, 30);
}
const failureOf = (digest: unknown): string => {
  const f = digest && typeof digest === "object" ? (digest as Record<string, unknown>)._failure : null;
  return typeof f === "string" ? redactFailure(f, 200) : "";
};
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
const usd = (v: unknown): number => Math.round((num(v) ?? 0) * 1e6) / 1e6;
const iso = (v: unknown): string | null => (typeof v === "string" && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null);

const INTERNAL_EVENT = /^(?:قياس داخلي|علامة داخلية)/;
export const isInternalEvent = (e: { message_ar?: unknown; counts?: unknown }): boolean =>
  (typeof e.message_ar === "string" && INTERNAL_EVENT.test(e.message_ar.trim())) || (!!e.counts && typeof e.counts === "object" && Object.keys(e.counts as object).some((k) => k.startsWith("adm_")));

export type StageState = "not_reached" | "running" | "done" | "empty" | "failed";
const TERMINAL = new Set(["completed", "failed", "unserved", "cancelled", "partial"]);

export interface InspectInput {
  mission: Record<string, any>;
  events: ReadonlyArray<Record<string, any>>;
  calls: ReadonlyArray<Record<string, any>>;
  /** The real number of calls of the mission (a count), which can be above the rows read. */
  callTotal: number | null;
  now: Date;
}

/** The whole response, built by name. Pure. */
export function buildInspection(input: InspectInput) {
  const m = input.mission;
  const plan = m.plan && typeof m.plan === "object" ? (m.plan as Record<string, any>) : null;
  const calls = input.calls.slice(0, INSPECT_CALL_LIMIT).map((c) => ({
    id: String(c.id ?? ""), at: iso(c.created_at), phase: c.phase === "execution" ? "execution" : "planning", endpointId: String(c.endpoint_id ?? "").slice(0, 120),
    status: ["ok", "failed", "empty", "refused"].includes(String(c.status)) ? String(c.status) : "unknown", httpStatus: num(c.http_status), refusedReason: c.refused_reason ? redactFailure(c.refused_reason, 120) : null,
    rowsReturned: num(c.rows_returned), costUsd: usd(c.cost_usd), durationMs: num(c.duration_ms), failure: failureOf(c.params_digest), paramKeys: paramKeysOf(c.params_digest),
  }));
  const byEndpoint = new Map<string, { endpointId: string; ok: number; empty: number; failed: number; refused: number; rows: number; costUsd: number }>();
  for (const c of calls) {
    const e = byEndpoint.get(c.endpointId) ?? { endpointId: c.endpointId, ok: 0, empty: 0, failed: 0, refused: 0, rows: 0, costUsd: 0 };
    if (c.status === "ok") e.ok += 1; else if (c.status === "empty") e.empty += 1; else if (c.status === "failed") e.failed += 1; else if (c.status === "refused") e.refused += 1;
    e.rows += c.rowsReturned ?? 0; e.costUsd = Math.round((e.costUsd + c.costUsd) * 1e6) / 1e6;
    byEndpoint.set(c.endpointId, e);
  }
  const byStatus = { ok: 0, empty: 0, failed: 0, refused: 0 };
  for (const e of byEndpoint.values()) { byStatus.ok += e.ok; byStatus.empty += e.empty; byStatus.failed += e.failed; byStatus.refused += e.refused; }
  const terminal = TERMINAL.has(String(m.status));
  const stagesIn: Array<Record<string, any>> = Array.isArray(plan?.stages) ? plan!.stages : [];
  // a call that served two stages (a shared endpoint) is counted in EACH stage that uses the endpoint and the stage says so (`sharedEndpoint`)
  const users = new Map<string, number>();
  for (const s of stagesIn) users.set(String(s.endpoint_id), (users.get(String(s.endpoint_id)) ?? 0) + 1);
  const stages = stagesIn.slice(0, 20).map((s) => {
    const mine = calls.filter((c) => c.endpointId === String(s.endpoint_id));
    const count = (st: string) => mine.filter((c) => c.status === st).length;
    const rows = mine.reduce((n, c) => n + (c.rowsReturned ?? 0), 0);
    const state: StageState = mine.length === 0 ? "not_reached" : rows > 0 ? (terminal ? "done" : "running") : count("failed") + count("refused") === mine.length ? "failed" : terminal ? "empty" : "running";
    return {
      key: String(s.key ?? ""), titleAr: redactText(s.title_ar, 120), endpointId: String(s.endpoint_id ?? "").slice(0, 120), parentKey: typeof s.parent_key === "string" ? s.parent_key : null, deliver: s.deliver === true,
      plannedRows: num(s.planned_rows), perParentRows: num(s.per_parent_rows), estimated: s.estimated === true, hasEngine: !!s.engine, sharedEndpoint: (users.get(String(s.endpoint_id)) ?? 0) > 1, state,
      callsOk: count("ok"), callsEmpty: count("empty"), callsFailed: count("failed"), callsRefused: count("refused"), rowsReturned: rows, costUsd: Math.round(mine.reduce((n, c) => n + c.costUsd, 0) * 1e6) / 1e6,
    };
  });
  const events = input.events.slice(0, INSPECT_EVENT_LIMIT).map((e) => ({ id: num(e.id), at: iso(e.created_at), kind: String(e.kind ?? "").slice(0, 20), messageAr: redactText(e.message_ar, 300), internal: isInternalEvent(e), counts: countsOf(e.counts) }));
  const understanding = events.find((e) => e.internal && e.messageAr.includes("فهم النموذج للطلب"));
  const llm = plan?.compiled?.llm;
  const noCard = noCardReasonOf(m.error);
  const total = Math.max(input.callTotal ?? 0, calls.length);
  return {
    ok: true as const,
    generatedAt: input.now.toISOString(),
    mission: {
      id: String(m.id), status: String(m.status ?? ""), terminal, createdAt: iso(m.created_at), updatedAt: iso(m.updated_at), requestText: redactText(m.request_text, 600),
      requestedRows: num(plan?.price?.deliveredRows), deliveredRows: num(m.delivered_units), reservedPoints: num(m.reserved_points), chargedPoints: num(m.charged_points),
      error: m.error ? redactError(m.error, 300) : null, summaryAr: m.summary_ar ? redactText(m.summary_ar, 400) : null, kind: "research" as const,
    },
    planner: {
      understandingAr: typeof llm?.understanding_ar === "string" ? redactText(llm.understanding_ar, 400) : understanding ? understanding.messageAr : null,
      steps: Array.isArray(llm?.steps) ? llm.steps.slice(0, 8).map((s: any) => ({ key: String(s.key ?? ""), platform: String(s.platform ?? "").slice(0, 40), capability: String(s.capability ?? "").slice(0, 80), topic: s.topic ? redactText(s.topic, 80) : null, hasSource: !!s.source })) : [],
      noCardReason: noCard, llmCalls: num(understanding?.counts?.llm_planner) ?? 0, costUsd: usd(m.planning_llm_usd),
    },
    stages,
    calls,
    truncated: total > calls.length,
    callTotals: { total, shown: calls.length, byStatus, byEndpoint: [...byEndpoint.values()].sort((a, b) => b.failed + b.refused - (a.failed + a.refused) || a.endpointId.localeCompare(b.endpointId)) },
    events,
    files: (Array.isArray(m.files) ? m.files : []).slice(0, 10).map((f: any) => ({ kind: String(f?.kind ?? "").slice(0, 10), name: redactText(String(f?.name ?? ""), 120) })),
  };
}
const countsOf = (c: unknown): Record<string, number> => {
  const out: Record<string, number> = {};
  if (c && typeof c === "object" && !Array.isArray(c)) for (const [k, v] of Object.entries(c as Record<string, unknown>)) if (PARAM_KEY.test(k) && typeof v === "number" && Number.isFinite(v)) out[k] = v;
  return out;
};

const SECRET_SHAPES = [EMAIL, BEARER, SK_KEY, JWT, HEX_RUN, B64_RUN];
/** The last guard: every string of the response is checked again; a string that still looks like a secret throws (the route answers 500, the page never shows it). */
export function assertNoSecrets(value: unknown, path = "$"): void {
  if (typeof value === "string") {
    for (const re of SECRET_SHAPES) { re.lastIndex = 0; if (re.test(value)) throw new Error(`inspector: a secret-shaped string at ${path}`); }
    if (phoneRuns(value).length > 0) throw new Error(`inspector: a phone-shaped string at ${path}`);
    return;
  }
  if (Array.isArray(value)) { value.forEach((v, i) => assertNoSecrets(v, `${path}[${i}]`)); return; }
  if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) assertNoSecrets(v, `${path}.${k}`);
}

export type InspectResult = { ok: true; body: ReturnType<typeof buildInspection> } | { ok: false; status: number; error: string };

/** Reads ONE mission by named columns and builds the response. An add-on row, an unknown id and a failed read answer 404 / 500; nothing is written. */
export async function loadInspection(client: any, input: { id: string; now?: Date }): Promise<InspectResult> {
  const { data: mission, error } = await client.from(MISSION_TABLE)
    .select("id,status,created_at,updated_at,request_text,error,summary_ar,delivered_units,charged_points,reserved_points,planning_llm_usd,files,plan").eq("id", input.id).maybeSingle();
  if (error) return { ok: false, status: 500, error: "read_failed" };
  if (!mission || hasAddonMarker(mission)) return { ok: false, status: 404, error: "not_found" };
  const [events, calls, count] = await Promise.all([
    client.from(MISSION_EVENTS_TABLE).select("id,kind,message_ar,counts,created_at").eq("mission_id", input.id).order("id", { ascending: true }).limit(INSPECT_EVENT_LIMIT),
    client.from(MISSION_CALLS_TABLE).select("id,phase,endpoint_id,status,refused_reason,http_status,rows_returned,cost_usd,duration_ms,params_digest,created_at").eq("mission_id", input.id).order("created_at", { ascending: true }).limit(INSPECT_CALL_LIMIT),
    client.from(MISSION_CALLS_TABLE).select("id", { count: "exact", head: true }).eq("mission_id", input.id).then((r: any) => r, () => ({ count: null })),
  ]);
  if (events.error || calls.error) return { ok: false, status: 500, error: "read_failed" };
  const body = buildInspection({ mission, events: Array.isArray(events.data) ? events.data : [], calls: Array.isArray(calls.data) ? calls.data : [], callTotal: typeof count?.count === "number" ? count.count : null, now: input.now ?? new Date() });
  assertNoSecrets(body);
  return { ok: true, body };
}
