import { randomBytes } from "node:crypto";
import { AGENT_SOURCE_MEASURE_WINDOW_MS, AGENT_ALLOWED_MODELS, AGENT_DYNO_MEMORY_MB, AGENT_BUCKET, AGENT_HEARTBEAT_TABLE, AGENT_SETTINGS_TABLE, AGENT_TEST_ACCOUNT_EMAIL, MISSION_CALLS_TABLE, MISSION_EVENTS_TABLE, MISSION_TABLE, PLANNING_MODEL_SETTING_KEY } from "./constants";
import { memoryWarning } from "./concurrency";
import { latestBeat, workerAlive } from "./heartbeat";
import { approveMissionOnce } from "./approval";
import { repriceStoredPlan } from "./lifecycle";
import { customerPlanView, type PricedPlan } from "./plan";
import { sourceHealth, statsFromCalls, type RecordedCallFact } from "./sourceRanking";
import { missionDownloadName } from "./fileNames";
import { DEFAULT_MISSION_PRICING_SETTINGS, MISSION_PRICING_SETTING_KEY, missionPricingSettingsProblemAr, normalizeMissionPricingSettings, type MissionPricingSettings } from "../missionPricing";

/**
 * What the admin page «الوكيل» does, on the server, with the service-role client. The page is for ONE account only in Phase A: the test account iam.magdy+1@outlook.com.
 * Nothing here writes a money table: approving goes through approveMission (the existing functions), and the worker settles.
 */
export type ActionResult<T = Record<string, unknown>> = ({ ok: true } & T) | { ok: false; status: number; error: string };
const bad = (status: number, error: string): { ok: false; status: number; error: string } => ({ ok: false, status, error });

const MIN_TEXT = 3;
const MAX_TEXT = 4000;
/** Missions that may be listed at once. */
const LIST_LIMIT = 20;

/** The id of the test account, found by its e-mail in profiles (read only). Null when the account does not exist. */
export async function findTestAccount(client: any): Promise<{ id: string; email: string } | null> {
  const { data, error } = await client.from("profiles").select("id,email").eq("email", AGENT_TEST_ACCOUNT_EMAIL).maybeSingle();
  if (error || !data?.id) return null;
  if (String(data.email).toLowerCase() !== AGENT_TEST_ACCOUNT_EMAIL) return null;
  return { id: String(data.id), email: AGENT_TEST_ACCOUNT_EMAIL };
}

export async function createMission(client: any, input: { adminId: string; text: unknown }): Promise<ActionResult<{ id: string }>> {
  const text = String(input.text ?? "").replace(/\s+/g, " ").trim();
  if (text.length < MIN_TEXT) return bad(400, "اكتب نص المهمة.");
  if (text.length > MAX_TEXT) return bad(400, "نص المهمة أطول من المسموح.");
  const account = await findTestAccount(client);
  if (!account) return bad(404, "حساب الاختبار غير موجود.");
  const id = `msn_${randomBytes(10).toString("hex")}`;
  const { error } = await client.from(MISSION_TABLE).insert({ id, user_id: account.id, created_by: input.adminId, request_text: text, status: "queued" });
  if (error) return bad(500, "تعذّر إنشاء المهمة (هل طُبّق SQL الوكيل؟).");
  return { ok: true, id };
}

export async function answerQuestion(client: any, input: { id: string; text: unknown }): Promise<ActionResult> {
  const text = String(input.text ?? "").replace(/\s+/g, " ").trim();
  if (text.length < 1 || text.length > 1000) return bad(400, "اكتب الإجابة.");
  const { data } = await client.from(MISSION_TABLE).select("id,status").eq("id", input.id).maybeSingle();
  if (!data) return bad(404, "المهمة غير موجودة.");
  if (data.status !== "needs_input") return bad(409, "المهمة لا تنتظر إجابة.");
  const upd = await client.from(MISSION_TABLE).update({ answer_text: text, status: "queued", question_ar: null, worker_id: null, lease_until: null, updated_at: new Date().toISOString() }).eq("id", input.id).eq("status", "needs_input");
  if (upd.error) return bad(500, "تعذّر حفظ الإجابة.");
  await client.from(MISSION_EVENTS_TABLE).insert({ mission_id: input.id, kind: "answer", message_ar: "وصلت إجابتك وعاد الوكيل إلى التخطيط." });
  return { ok: true };
}

export async function cancelMission(client: any, input: { id: string }): Promise<ActionResult> {
  const { data } = await client.from(MISSION_TABLE).select("id,status").eq("id", input.id).maybeSingle();
  if (!data) return bad(404, "المهمة غير موجودة.");
  // before approval nothing is held: cancelling is just a status. An approved or executing mission holds money; the worker settles or releases it, so it cannot be cancelled here.
  if (!["queued", "needs_input", "plan_ready"].includes(data.status)) return bad(409, "لا يمكن إلغاء مهمة قيد التنفيذ أو معتمدة؛ ينتهي حجزها بالتسوية.");
  const upd = await client.from(MISSION_TABLE).update({ status: "cancelled", updated_at: new Date().toISOString() }).eq("id", input.id).in("status", ["queued", "needs_input", "plan_ready"]);
  if (upd.error) return bad(500, "تعذّر الإلغاء.");
  return { ok: true };
}

/** Approve: the shared approval path (claim, re-price by code, reserve through the existing functions), then hands the mission to the worker. */
export async function approvePlan(client: any, input: { id: string; adminId: string }): Promise<ActionResult<{ jobId: string; reservePoints: number; unitPricePoints: number }>> {
  const { data: mission } = await client.from(MISSION_TABLE).select("id,user_id,status,plan").eq("id", input.id).maybeSingle();
  if (!mission) return bad(404, "المهمة غير موجودة.");
  if (mission.status !== "plan_ready" || !mission.plan) return bad(409, "لا توجد خطة جاهزة للاعتماد.");
  const account = await findTestAccount(client);
  if (!account || account.id !== mission.user_id) return bad(403, "هذه الصفحة تعمل لحساب الاختبار فقط.");
  const r = await approveMissionOnce(client, { id: input.id, actorId: input.adminId, messages: { insufficient_balance: "رصيد حساب الاختبار لا يكفي لحجز هذه المهمة." } });
  return r.ok ? { ok: true, jobId: r.jobId, reservePoints: r.reservePoints, unitPricePoints: r.unitPricePoints } : bad(r.status, r.error);
}

export async function setPlanningModel(client: any, input: { model: unknown; adminId: string }): Promise<ActionResult<{ model: string }>> {
  const model = String(input.model ?? "");
  if (!AGENT_ALLOWED_MODELS.includes(model)) return bad(400, "نموذج غير مسموح.");
  const { error } = await client.from(AGENT_SETTINGS_TABLE).upsert({ key: PLANNING_MODEL_SETTING_KEY, value: { model }, updated_at: new Date().toISOString(), updated_by: input.adminId }, { onConflict: "key" });
  if (error) return bad(500, "تعذّر حفظ الإعداد.");
  return { ok: true, model };
}

/**
 * The markup and the minimum charge of the pricing rule (missionPricing.ts): saved in agent_settings (key `mission_pricing`) by the admin only. Returns the values before and after so the caller writes the audit row
 * (who changed what, from what to what). A value out of range is refused; nothing here touches a money table.
 */
export async function setMissionPricing(client: any, input: { markup: unknown; minChargePoints: unknown; adminId: string }): Promise<ActionResult<{ before: MissionPricingSettings; after: MissionPricingSettings }>> {
  const problem = missionPricingSettingsProblemAr({ markup: input.markup, minChargePoints: input.minChargePoints });
  if (problem) return bad(400, problem);
  const after = normalizeMissionPricingSettings({ markup: Number(input.markup), min_charge_points: Number(input.minChargePoints) });
  const current = await client.from(AGENT_SETTINGS_TABLE).select("value").eq("key", MISSION_PRICING_SETTING_KEY).maybeSingle();
  const before = normalizeMissionPricingSettings(current.data?.value);
  const { error } = await client.from(AGENT_SETTINGS_TABLE).upsert({ key: MISSION_PRICING_SETTING_KEY, value: { markup: after.markup, min_charge_points: after.minChargePoints }, updated_at: new Date().toISOString(), updated_by: input.adminId }, { onConflict: "key" });
  if (error) return bad(500, "تعذّر حفظ الإعداد.");
  return { ok: true, before, after };
}

const SUMMARY_COLUMNS = "id,request_text,status,question_ar,reserved_points,unit_price_points,delivered_units,charged_points,planning_model,planning_llm_usd,execution_model,execution_llm_usd,planning_treg_usd,execution_treg_usd,created_at,updated_at";

/** The page's first load: the worker's heartbeat (alive or not), the model setting, and the latest missions. */
export async function loadOverview(client: any, now: number = Date.now()) {
  const [beats, setting, missions, pricing] = await Promise.all([
    client.from(AGENT_HEARTBEAT_TABLE).select("worker_id,beat_at,active_missions,model,version,rss_mb,tree_rss_mb").order("beat_at", { ascending: false }).limit(5),
    client.from(AGENT_SETTINGS_TABLE).select("value").eq("key", PLANNING_MODEL_SETTING_KEY).maybeSingle(),
    client.from(MISSION_TABLE).select(SUMMARY_COLUMNS).order("created_at", { ascending: false }).limit(LIST_LIMIT),
    client.from(AGENT_SETTINGS_TABLE).select("value").eq("key", MISSION_PRICING_SETTING_KEY).maybeSingle(),
  ]);
  const rows = Array.isArray(beats.data) ? beats.data : [];
  const last = latestBeat(rows);
  // the memory the freshest worker reported with its heartbeat (null before it reports any, or before the column exists)
  const newest = rows.find((r: any) => r.beat_at === last);
  const rss = Number(newest?.rss_mb);
  const tree = newest?.tree_rss_mb === null || newest?.tree_rss_mb === undefined ? null : Number(newest.tree_rss_mb);
  const memory = newest && Number.isFinite(rss) && newest.rss_mb !== null ? { rssMb: rss, treeRssMb: tree !== null && Number.isFinite(tree) ? tree : null, limitMb: AGENT_DYNO_MEMORY_MB, warn: memoryWarning(tree) } : null;
  return {
    tablesReady: !beats.error && !missions.error,
    worker: { ...workerAlive(last, now), lastBeatAt: last, workers: rows, memory },
    planningModel: typeof setting.data?.value?.model === "string" ? setting.data.value.model : null,
    allowedModels: AGENT_ALLOWED_MODELS,
    pricing: pricing.data?.value ? normalizeMissionPricingSettings(pricing.data.value) : { ...DEFAULT_MISSION_PRICING_SETTINGS },
    testAccountEmail: AGENT_TEST_ACCOUNT_EMAIL,
    missions: Array.isArray(missions.data) ? missions.data : [],
  };
}

/**
 * THE HEALTH OF THE SOURCES, for the admin: every source whose recorded calls (the last fourteen days) failed on its configuration or its inputs, with its state (demoted or skipped for the time window), the reason, how many failures
 * since it last gave rows, when it is tried again, and what it really cost per row. Read only; the planner ranks and skips with the same function.
 */
export async function loadSourceHealth(client: any, now: number = Date.now()) {
  const since = new Date(now - AGENT_SOURCE_MEASURE_WINDOW_MS).toISOString();
  const { data, error } = await client.from(MISSION_CALLS_TABLE).select("endpoint_id,status,refused_reason,http_status,rows_returned,cost_usd,created_at,params_digest").gte("created_at", since).order("created_at", { ascending: false }).limit(5000);
  if (error) return { ok: false as const, sources: [] };
  const stats = statsFromCalls((data ?? []) as RecordedCallFact[]);
  const sources = [...stats.entries()].map(([id, s]) => {
    const h = sourceHealth(s, now);
    return { id, state: h.state, reason: h.reason, failures: h.failures, until: h.until === null ? null : new Date(h.until).toISOString(), attempts: s.attempts, withRows: s.withRows, rows: s.rows, usdPerRow: s.rows > 0 ? Number((s.costUsd / s.rows).toFixed(6)) : null };
  }).sort((a, b) => (a.state === "ok" ? 1 : 0) - (b.state === "ok" ? 1 : 0) || a.id.localeCompare(b.id));
  return { ok: true as const, sources };
}

/** One mission for the admin: everything, the plan in both views (the customer's and the internal one with the price computed by code), the events after `afterEventId`, and the call totals. */
export async function loadDetail(client: any, input: { id: string; afterEventId?: number }) {
  const { data: mission } = await client.from(MISSION_TABLE).select("*").eq("id", input.id).maybeSingle();
  if (!mission) return bad(404, "المهمة غير موجودة.");
  const [events, calls] = await Promise.all([
    client.from(MISSION_EVENTS_TABLE).select("id,kind,message_ar,counts,created_at").eq("mission_id", input.id).gt("id", input.afterEventId ?? 0).order("id", { ascending: true }).limit(500),
    client.from(MISSION_CALLS_TABLE).select("id,phase,endpoint_id,status,refused_reason,http_status,duration_ms,rows_returned,cost_usd,params_digest,created_at").eq("mission_id", input.id).order("created_at", { ascending: true }).limit(500),
  ]);
  const plan = (mission.plan ?? null) as PricedPlan | null;
  const callRows: any[] = Array.isArray(calls.data) ? calls.data : [];
  return {
    ok: true as const,
    mission: { ...mission, plan: undefined },
    customerPlan: plan ? customerPlanView(plan) : null,
    // the internal view: which source each stage uses and what it measured, and the price recomputed by code from those measurements
    internalPlan: plan ? { stages: plan.stages.map((s) => ({ key: s.key, endpoint_id: s.endpoint_id, measured_cost_per_row_usd: s.measured_cost_per_row_usd, measured_from_calls: s.measured_from_calls })), price: repriceStoredPlan(plan) } : null,
    events: Array.isArray(events.data) ? events.data : [],
    calls: { total: callRows.length, refused: callRows.filter((c) => c.status === "refused").length, items: callRows.slice(-50) },
  };
}

/** A short-lived link to a result file of a mission (the private bucket is readable only with the service role). */
export async function fileLink(client: any, input: { id: string; name: string }): Promise<ActionResult<{ url: string }>> {
  const { data: mission } = await client.from(MISSION_TABLE).select("id,files,plan,request_text,delivered_units,updated_at").eq("id", input.id).maybeSingle();
  const file = Array.isArray(mission?.files) ? (mission.files as Array<{ name: string; path: string; kind?: string }>).find((f) => f.name === input.name) : null;
  if (!file) return bad(404, "الملف غير موجود.");
  const download = missionDownloadName({ files: mission.files, kind: file.kind ?? input.name.split(".").pop() ?? "", plan: mission.plan, requestText: mission.request_text, deliveredUnits: mission.delivered_units, date: mission.updated_at });
  const { data, error } = await client.storage.from(AGENT_BUCKET).createSignedUrl(`${input.id}/${file.path}`, 120, { download });
  if (error || !data?.signedUrl) return bad(500, "تعذّر إنشاء رابط الملف.");
  return { ok: true, url: String(data.signedUrl) };
}
