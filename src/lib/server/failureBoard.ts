import { isTestAccount } from "./testAccounts";
import { adminCapabilityLabelAr } from "./adminJobLabels";
import { jobIdForQuote } from "./missionStatus";
import { MODEL_PLAN_REQUEST_PARAM } from "../modelPlanner/constants";
import { EXPLORATION_TABLE, PLANNER_EVENT_ROW_ENDPOINT, PLANNER_TURN_ROW_ENDPOINT } from "../modelPlanner/exploration";

/**
 * THE FAILURES BOARD «لوحة الأعطال» (admin only, read only): every failed or empty operation of the last 7 days, from data that already exists:
 *   - jobs that failed, delivered nothing, or delivered only part of what was approved;
 *   - planner turns that ended without a plan (a refusal, a missing value, a model that could not be reached);
 *   - exploration calls (the sample calls made before approval) that failed, answered nothing or did not fit the budget.
 * Each row has its time (Cairo), the account and a test badge, the request text, the endpoints tried and what each did, the reason in plain Arabic, the provider and model USD and the links.
 * A summary groups the rows by service and reason for 24 hours and 7 days. Nothing here writes, spends or touches a customer's money; «أعد التجربة» is a separate route that re-runs ONE request
 * through the planner and stops before any approval.
 */
export const BOARD_WINDOW_MS = 7 * 24 * 3600 * 1000;
export const DAY_MS = 24 * 3600 * 1000;

export type FailureKind = "job_failed" | "job_empty" | "job_partial" | "planner_refused" | "planner_error" | "exploration_failed";

export const KIND_LABEL_AR: Record<FailureKind, string> = {
  job_failed: "مهمة فشلت",
  job_empty: "مهمة بلا نتائج",
  job_partial: "مهمة ناقصة",
  planner_refused: "المخطط لم يجد خطة",
  planner_error: "خطأ في التخطيط",
  exploration_failed: "عيّنة فاشلة",
};

export interface BoardAttempt { endpoint: string; outcome: string; httpStatus?: number | null }

export interface BoardRow {
  id: string;
  kind: FailureKind;
  at: string;
  /** The time in Cairo, for reading («٢٨/١٠/٢٠٢٦ ١٤:٣٢»). */
  cairoAt: string;
  userId: string | null;
  userEmail: string | null;
  isTest: boolean;
  requestText: string;
  /** The service the request was about, in Arabic. */
  service: string;
  attempts: BoardAttempt[];
  reasonAr: string;
  providerUsd: number;
  /** null when the data has no model figure for this row. */
  modelUsd: number | null;
  jobId: string | null;
  jobHref: string | null;
  /** The request id of the planner turn or sample calls (the key to the rows behind it). */
  requestId: string | null;
  /** A row with a request text can be tried again through the planner. */
  retryable: boolean;
}

export interface BoardSummaryRow { service: string; reasonAr: string; last24h: number; last7d: number }

const cairoFormatter = new Intl.DateTimeFormat("ar-EG-u-nu-arab", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
export const cairoTime = (iso: string): string => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? cairoFormatter.format(new Date(t)).replace("،", "") : "—";
};

// ---------------------------------------------------------------------------------------------------------------------------------------------
// reasons, in plain Arabic

const ATTEMPT_REASON_AR: Record<string, string> = {
  timeout: "المصدر لم يرد في الوقت المناسب",
  empty: "المصدر ردّ دون بيانات",
  http_error: "المصدر فشل أو رفض الطلب",
  over_budget: "العيّنة لم تدخل ضمن حدّ الاستكشاف",
  no_time: "لم يبقَ وقت لعيّنة أخرى",
  unmappable: "لا بديل مناسب لهذا المصدر",
};

/** The outcome word of an exploration row's `refused_reason` («timeout: no answer within 12 s»). */
export const outcomeOfRefusal = (refused: unknown): string => String(refused ?? "").split(":")[0].trim();

export function reasonOfAttempts(attempts: ReadonlyArray<BoardAttempt>): string {
  const bad = attempts.filter((a) => a.outcome !== "ok");
  if (bad.length === 0) return "لم تُسجَّل نتيجة لهذه العيّنة";
  const reasons = [...new Set(bad.map((a) => ATTEMPT_REASON_AR[a.outcome] ?? "فشلت العيّنة"))];
  return bad.length > 1 ? `${reasons.join("، ")} (بعد ${bad.length} محاولات)` : reasons[0];
}

/** A planner turn row's `refused_reason` («unavailable: the model said… [needs_real_sample]») as a kind and an Arabic reason. */
export function reasonOfPlannerTurn(refused: unknown): { kind: FailureKind; reasonAr: string } {
  const text = String(refused ?? "");
  const code = text.split(":")[0].trim();
  const codes = /\[([^\]]+)\]/.exec(text)?.[1];
  if (code === "no_model") return { kind: "planner_error", reasonAr: "تعذّر الاتصال بنموذج التخطيط أو انتهى وقت الدورة" };
  if (code === "incomplete") return { kind: "planner_refused", reasonAr: `الطلب ينقصه بيان (حساب أو رابط أو عدد)${codes ? ` · ${codes}` : ""}` };
  if (code === "unavailable") return { kind: "planner_refused", reasonAr: `لم نجد مصدرًا يخدم الطلب بعد تجربة البدائل${codes ? ` · ${codes}` : ""}` };
  return { kind: "planner_refused", reasonAr: `انتهى التخطيط دون خطة${codes ? ` · ${codes}` : ""}` };
}

const PLATFORM_AR: Record<string, string> = { x: "إكس", tiktok: "تيك توك", youtube: "يوتيوب", facebook: "فيسبوك", instagram: "إنستغرام", linkedin: "لينكد إن", companies: "الشركات", people: "الأشخاص", google: "جوجل", web: "الويب", jobs: "الوظائف", news: "الأخبار" };

/** The service of an endpoint id, in Arabic (the platform part of the id: «anyapi.x.user.posts» is «إكس»). Unknown: the id itself, never hidden. */
export function serviceOfEndpoint(endpointId: string): string {
  const parts = String(endpointId ?? "").toLowerCase().split(".");
  for (const p of parts) if (PLATFORM_AR[p]) return PLATFORM_AR[p];
  for (const p of String(endpointId ?? "").toLowerCase().split(/[.\-_]/)) if (PLATFORM_AR[p]) return PLATFORM_AR[p];
  return endpointId || "غير معروف";
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// the board

export interface JobRow { id: string; user_id: string | null; status: string; endpoint_id?: string | null; target_volume_max?: number | null; delivered_units?: number | null; error_message?: string | null; accumulated_cost_usd?: number | null; created_at?: string | null; updated_at?: string | null }
export interface ExplorationRow { request_id: string; user_id: string | null; endpoint_id: string; http_status?: number | null; rows_returned?: number | null; cost_usd?: number | null; refused_reason?: string | null; params_digest?: any; created_at: string }

export interface BoardInput {
  jobs: ReadonlyArray<JobRow>;
  /** The customer's words of each job (by job id), from its quote. */
  requestTextByJob: ReadonlyMap<string, string>;
  exploration: ReadonlyArray<ExplorationRow>;
  owners: ReadonlyMap<string, { email: string | null }>;
  now: number;
  hideTest?: boolean;
}

const jobServiceAr = (job: JobRow): string => (job.endpoint_id ? adminCapabilityLabelAr(job.endpoint_id)?.replace(/\s*\(TREG\)$/, "") ?? serviceOfEndpoint(job.endpoint_id) : "غير معروف");

function jobFailure(job: JobRow): { kind: FailureKind; reasonAr: string } | null {
  const delivered = Math.max(0, Number(job.delivered_units) || 0);
  const wanted = Math.max(0, Number(job.target_volume_max) || 0);
  if (job.status === "failed" || job.status === "refused") {
    const own = typeof job.error_message === "string" && /[؀-ۿ]/.test(job.error_message) ? job.error_message.slice(0, 200) : "";
    return { kind: delivered > 0 ? "job_partial" : "job_failed", reasonAr: own || "فشل التنفيذ دون سبب مسجّل" };
  }
  if (job.status === "completed" || job.status === "done") {
    if (delivered === 0) return { kind: "job_empty", reasonAr: "اكتملت المهمة دون أن يصل أي صف" };
    if (wanted > 0 && delivered < wanted) return { kind: "job_partial", reasonAr: `وصل ${delivered} من ${wanted} صفًا مطلوبًا` };
  }
  return null;
}

/** The board from the raw rows. Pure: the loader reads the rows, this builds the board and the summary. */
export function buildBoard(input: BoardInput): { rows: BoardRow[]; summary: BoardSummaryRow[] } {
  const since = input.now - BOARD_WINDOW_MS;
  const rows: BoardRow[] = [];
  const owner = (id: string | null) => {
    const email = id ? input.owners.get(id)?.email ?? null : null;
    return { email, isTest: isTestAccount({ id: id ?? "", email }) };
  };

  // 1. jobs
  for (const job of input.jobs) {
    const at = job.updated_at || job.created_at || "";
    if (!(Date.parse(at) >= since)) continue;
    const failure = jobFailure(job);
    if (!failure) continue;
    const o = owner(job.user_id);
    const text = input.requestTextByJob.get(job.id) ?? "";
    rows.push({
      id: `job:${job.id}`, kind: failure.kind, at, cairoAt: cairoTime(at), userId: job.user_id, userEmail: o.email, isTest: o.isTest, requestText: text, service: jobServiceAr(job),
      attempts: job.endpoint_id ? [{ endpoint: job.endpoint_id, outcome: job.status }] : [], reasonAr: failure.reasonAr, providerUsd: Math.max(0, Number(job.accumulated_cost_usd) || 0), modelUsd: null,
      jobId: job.id, jobHref: `/admin/jobs?job=${encodeURIComponent(job.id)}`, requestId: null, retryable: text.length > 0,
    });
  }

  // 2. planner turns and exploration calls, joined by request id
  const byRequest = new Map<string, ExplorationRow[]>();
  for (const r of input.exploration) { const list = byRequest.get(r.request_id) ?? []; list.push(r); byRequest.set(r.request_id, list); }
  for (const [requestId, group] of byRequest) {
    const sorted = [...group].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
    const turn = sorted.find((r) => r.endpoint_id === PLANNER_TURN_ROW_ENDPOINT);
    const events = sorted.filter((r) => r.endpoint_id === PLANNER_EVENT_ROW_ENDPOINT);
    const samples = sorted.filter((r) => r.endpoint_id !== PLANNER_TURN_ROW_ENDPOINT && r.endpoint_id !== PLANNER_EVENT_ROW_ENDPOINT);
    const attempts: BoardAttempt[] = samples.map((r) => ({ endpoint: r.endpoint_id, outcome: r.refused_reason ? outcomeOfRefusal(r.refused_reason) : (r.rows_returned === null || r.rows_returned === undefined ? (Number(r.http_status) === 200 ? "ok" : "http_error") : Number(r.rows_returned) > 0 ? "ok" : "empty"), httpStatus: r.http_status ?? null }));
    const failedSamples = attempts.some((a) => a.outcome !== "ok");
    if (!turn && !failedSamples) continue;
    const anchor = turn ?? samples.find((r) => r.refused_reason) ?? samples[0];
    const at = anchor.created_at;
    if (!(Date.parse(at) >= since)) continue;
    const userId = anchor.user_id ?? null;
    const o = owner(userId);
    const text = String(turn?.params_digest?.request ?? events.find((e) => typeof e.params_digest?.request === "string")?.params_digest?.request ?? "");
    const providerUsd = samples.reduce((s, r) => s + Math.max(0, Number(r.cost_usd) || 0), 0);
    const modelUsd = typeof turn?.params_digest?.modelUsd === "number" ? turn.params_digest.modelUsd : null;
    const reason = turn ? reasonOfPlannerTurn(turn.refused_reason) : { kind: "exploration_failed" as FailureKind, reasonAr: reasonOfAttempts(attempts) };
    const fromEndpoint = samples[0]?.endpoint_id;
    rows.push({
      id: `req:${requestId}`, kind: reason.kind, at, cairoAt: cairoTime(at), userId, userEmail: o.email, isTest: o.isTest, requestText: text, service: fromEndpoint ? serviceOfEndpoint(fromEndpoint) : "التخطيط",
      attempts, reasonAr: turn && failedSamples ? `${reason.reasonAr} — ${reasonOfAttempts(attempts)}` : reason.reasonAr, providerUsd, modelUsd, jobId: null, jobHref: null, requestId, retryable: text.length > 0,
    });
  }

  const visible = input.hideTest ? rows.filter((r) => !r.isTest) : rows;
  visible.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return { rows: visible, summary: summarize(visible, input.now) };
}

/** Rows grouped by service and reason, counted for the last 24 hours and the last 7 days; the busiest first. */
export function summarize(rows: ReadonlyArray<BoardRow>, now: number): BoardSummaryRow[] {
  const map = new Map<string, BoardSummaryRow>();
  for (const r of rows) {
    const key = `${r.service}\u0000${r.reasonAr.replace(/\s*[(·—].*$/, "").trim()}`;
    const entry = map.get(key) ?? { service: r.service, reasonAr: r.reasonAr.replace(/\s*[(·—].*$/, "").trim(), last24h: 0, last7d: 0 };
    entry.last7d += 1;
    if (Date.parse(r.at) >= now - DAY_MS) entry.last24h += 1;
    map.set(key, entry);
  }
  return [...map.values()].sort((a, b) => b.last7d - a.last7d || b.last24h - a.last24h || a.service.localeCompare(b.service));
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// the loader (read only)

export async function loadFailureBoard(admin: any, opts: { now?: number; hideTest?: boolean } = {}): Promise<{ rows: BoardRow[]; summary: BoardSummaryRow[]; partial: string[] }> {
  const now = opts.now ?? Date.now();
  const sinceIso = new Date(now - BOARD_WINDOW_MS).toISOString();
  const partial: string[] = [];
  let jobs: JobRow[] = [];
  try {
    const { data } = await admin.from("jobs").select("id, user_id, status, endpoint_id, target_volume_max, delivered_units, error_message, accumulated_cost_usd, created_at, updated_at").gte("updated_at", sinceIso).order("updated_at", { ascending: false }).limit(1000);
    jobs = Array.isArray(data) ? data : [];
  } catch { partial.push("jobs"); }
  let exploration: ExplorationRow[] = [];
  try {
    const { data } = await admin.from(EXPLORATION_TABLE).select("request_id, user_id, endpoint_id, http_status, rows_returned, cost_usd, refused_reason, params_digest, created_at").gte("created_at", sinceIso).order("created_at", { ascending: false }).limit(3000);
    exploration = Array.isArray(data) ? data : [];
  } catch { partial.push("exploration_calls"); }
  const requestTextByJob = new Map<string, string>();
  try {
    const { data } = await admin.from("plans_quotes").select("id, items").gte("created_at", new Date(now - BOARD_WINDOW_MS - DAY_MS).toISOString()).order("created_at", { ascending: false }).limit(2000);
    for (const q of Array.isArray(data) ? data : []) {
      const items = Array.isArray(q?.items) ? q.items : Array.isArray(q?.items?.items) ? q.items.items : [];
      const text = items[0]?.params?.[MODEL_PLAN_REQUEST_PARAM];
      if (q?.id && typeof text === "string" && text) requestTextByJob.set(jobIdForQuote(q.id), text);
    }
  } catch { partial.push("plans_quotes"); }
  const ids = [...new Set([...jobs.map((j) => j.user_id), ...exploration.map((e) => e.user_id)].filter((v): v is string => typeof v === "string" && v.length > 0))];
  const owners = new Map<string, { email: string | null }>();
  try {
    for (let i = 0; i < ids.length; i += 200) {
      const { data } = await admin.from("profiles").select("id, email").in("id", ids.slice(i, i + 200));
      for (const p of Array.isArray(data) ? data : []) if (p?.id) owners.set(String(p.id), { email: p.email || null });
    }
  } catch { partial.push("profiles"); }
  return { ...buildBoard({ jobs, requestTextByJob, exploration, owners, now, hideTest: opts.hideTest }), partial };
}
