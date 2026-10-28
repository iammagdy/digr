import { randomBytes } from "node:crypto";
import { AGENT_ALLOWED_MODELS, AGENT_BUCKET, AGENT_HEARTBEAT_TABLE, AGENT_SETTINGS_TABLE, AGENT_TEST_ACCOUNT_EMAIL, MISSION_CALLS_TABLE, MISSION_EVENTS_TABLE, MISSION_TABLE, PLANNING_MODEL_SETTING_KEY } from "./constants";
import { latestBeat, workerAlive } from "./heartbeat";
import { approveMission, repriceStoredPlan } from "./lifecycle";
import { customerPlanView, type PricedPlan } from "./plan";

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

/** Approve: re-prices the stored plan by code, reserves through the existing functions (quote, accept, lock the job), then hands the mission to the worker. */
export async function approvePlan(client: any, input: { id: string; adminId: string }): Promise<ActionResult<{ jobId: string; reservePoints: number; unitPricePoints: number }>> {
  const { data: mission } = await client.from(MISSION_TABLE).select("id,user_id,status,plan").eq("id", input.id).maybeSingle();
  if (!mission) return bad(404, "المهمة غير موجودة.");
  if (mission.status !== "plan_ready" || !mission.plan) return bad(409, "لا توجد خطة جاهزة للاعتماد.");
  const account = await findTestAccount(client);
  if (!account || account.id !== mission.user_id) return bad(403, "هذه الصفحة تعمل لحساب الاختبار فقط.");
  // claim the transition first so a double click never approves twice
  const claim = await client.from(MISSION_TABLE).update({ status: "approved", approved_at: new Date().toISOString(), approved_by: input.adminId, worker_id: null, lease_until: new Date(Date.now() + 3600_000).toISOString() }).eq("id", input.id).eq("status", "plan_ready");
  if (claim.error) return bad(500, "تعذّر الاعتماد.");
  const result = await approveMission(client, { id: mission.id, user_id: mission.user_id, plan: mission.plan as PricedPlan });
  if (!result.ok) {
    await client.from(MISSION_TABLE).update({ status: "plan_ready", lease_until: null, error: result.code }).eq("id", input.id);
    return bad(result.code === "insufficient_balance" ? 402 : 409, result.messageAr);
  }
  await client.from(MISSION_TABLE).update({ job_id: result.jobId, quote_id: result.quoteId, reserved_points: result.reservePoints, unit_price_points: result.unitPricePoints, lease_until: null, error: null, updated_at: new Date().toISOString() }).eq("id", input.id);
  await client.from(MISSION_EVENTS_TABLE).insert({ mission_id: input.id, kind: "system", message_ar: "اعتُمدت الخطة وحُجز الرصيد؛ يبدأ التنفيذ الآن." });
  return { ok: true, jobId: result.jobId, reservePoints: result.reservePoints, unitPricePoints: result.unitPricePoints };
}

export async function setPlanningModel(client: any, input: { model: unknown; adminId: string }): Promise<ActionResult<{ model: string }>> {
  const model = String(input.model ?? "");
  if (!AGENT_ALLOWED_MODELS.includes(model)) return bad(400, "نموذج غير مسموح.");
  const { error } = await client.from(AGENT_SETTINGS_TABLE).upsert({ key: PLANNING_MODEL_SETTING_KEY, value: { model }, updated_at: new Date().toISOString(), updated_by: input.adminId }, { onConflict: "key" });
  if (error) return bad(500, "تعذّر حفظ الإعداد.");
  return { ok: true, model };
}

const SUMMARY_COLUMNS = "id,request_text,status,question_ar,reserved_points,unit_price_points,delivered_units,charged_points,planning_model,planning_llm_usd,execution_model,execution_llm_usd,planning_treg_usd,execution_treg_usd,created_at,updated_at";

/** The page's first load: the worker's heartbeat (alive or not), the model setting, and the latest missions. */
export async function loadOverview(client: any, now: number = Date.now()) {
  const [beats, setting, missions] = await Promise.all([
    client.from(AGENT_HEARTBEAT_TABLE).select("worker_id,beat_at,active_missions,model,version").order("beat_at", { ascending: false }).limit(5),
    client.from(AGENT_SETTINGS_TABLE).select("value").eq("key", PLANNING_MODEL_SETTING_KEY).maybeSingle(),
    client.from(MISSION_TABLE).select(SUMMARY_COLUMNS).order("created_at", { ascending: false }).limit(LIST_LIMIT),
  ]);
  const rows = Array.isArray(beats.data) ? beats.data : [];
  const last = latestBeat(rows);
  return {
    tablesReady: !beats.error && !missions.error,
    worker: { ...workerAlive(last, now), lastBeatAt: last, workers: rows },
    planningModel: typeof setting.data?.value?.model === "string" ? setting.data.value.model : null,
    allowedModels: AGENT_ALLOWED_MODELS,
    testAccountEmail: AGENT_TEST_ACCOUNT_EMAIL,
    missions: Array.isArray(missions.data) ? missions.data : [],
  };
}

/** One mission for the admin: everything, the plan in both views (the customer's and the internal one with the price computed by code), the events after `afterEventId`, and the call totals. */
export async function loadDetail(client: any, input: { id: string; afterEventId?: number }) {
  const { data: mission } = await client.from(MISSION_TABLE).select("*").eq("id", input.id).maybeSingle();
  if (!mission) return bad(404, "المهمة غير موجودة.");
  const [events, calls] = await Promise.all([
    client.from(MISSION_EVENTS_TABLE).select("id,kind,message_ar,counts,created_at").eq("mission_id", input.id).gt("id", input.afterEventId ?? 0).order("id", { ascending: true }).limit(500),
    client.from(MISSION_CALLS_TABLE).select("id,phase,endpoint_id,status,refused_reason,rows_returned,cost_usd,created_at").eq("mission_id", input.id).order("created_at", { ascending: true }).limit(500),
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
  const { data: mission } = await client.from(MISSION_TABLE).select("id,files").eq("id", input.id).maybeSingle();
  const file = Array.isArray(mission?.files) ? (mission.files as Array<{ name: string; path: string }>).find((f) => f.name === input.name) : null;
  if (!file) return bad(404, "الملف غير موجود.");
  const { data, error } = await client.storage.from(AGENT_BUCKET).createSignedUrl(`${input.id}/${file.path}`, 120, { download: file.name });
  if (error || !data?.signedUrl) return bad(500, "تعذّر إنشاء رابط الملف.");
  return { ok: true, url: String(data.signedUrl) };
}
