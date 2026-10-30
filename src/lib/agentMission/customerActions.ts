import { randomBytes } from "node:crypto";
import { AGENT_BUCKET, AGENT_MAX_MISSIONS_PER_HOUR, AGENT_MAX_OPEN_MISSIONS_PER_USER, MISSION_CALLS_TABLE, MISSION_EVENTS_TABLE, MISSION_TABLE, AGENT_HEARTBEAT_TABLE } from "./constants";
import { approveMissionOnce } from "./approval";
import { customerMissionView, type EventForCustomer, type MissionRowForCustomer, type QueueInfo } from "./customerView";
import { latestBeat, workerAlive } from "./heartbeat";
import { userWillBeEmailed } from "./emailEligibility";
import { customerPlanView, type PricedPlan, type PricedStage } from "./plan";
import { applyPlanEdits } from "./planEdit";
import { missionDownloadName } from "./fileNames";
import { listOpenMissions, openLimitMessageAr, type OpenMissionView } from "./openMissions";

/**
 * What a CUSTOMER does with a mission, on the server, with the service-role client and an explicit owner check on every call (a customer reaches only their own missions; the browser never
 * holds the service key). The agent plans and works in the worker; the site creates the mission, shows it, approves it through the existing money functions, and cancels or answers it.
 */
export type CustomerResult<T = Record<string, unknown>> = ({ ok: true } & T) | { ok: false; status: number; error: string; blockers?: OpenMissionView[] };
const bad = (status: number, error: string): { ok: false; status: number; error: string } => ({ ok: false, status, error });

const MIN_TEXT = 3;
const MAX_TEXT = 4000;
const CANCELLABLE = ["queued", "needs_input", "plan_ready"];
const SAFE_COLUMNS = "id,user_id,status,question_ar,plan_public,job_id,reserved_points,unit_price_points,delivered_units,charged_points,summary_ar,files,created_at";

export const SIGNUP_TO_APPROVE_AR = "سجّل حسابك أولًا لتعتمد المهمة؛ خطتك محفوظة وتنتظرك بعد التسجيل.";

/** The mission of a chat request: created for the signed-in user (or the guest, who may look at the plan but must sign up before approving). The worker plans it. */
export async function createCustomerMission(client: any, input: { userId: string; text: unknown }): Promise<CustomerResult<{ id: string }>> {
  const text = String(input.text ?? "").replace(/\s+/g, " ").trim();
  if (text.length < MIN_TEXT) return bad(400, "اكتب نص المهمة.");
  if (text.length > MAX_TEXT) return bad(400, "نص المهمة أطول من المسموح.");
  // the limit counts exactly the missions `listOpenMissions` shows as the worker's (one definition, `openMissions.ts`); a planning mission with no live worker is ended there, and a question or plan that waits for the customer never blocks
  const blockers = (await listOpenMissions(client, { userId: input.userId })).filter((m) => m.blocksNewRequests);
  if (blockers.length >= AGENT_MAX_OPEN_MISSIONS_PER_USER) return { ...bad(429, openLimitMessageAr(blockers)), blockers };
  const hourAgo = new Date(Date.now() - 3600_000).toISOString();
  const recent = await client.from(MISSION_TABLE).select("id", { count: "exact", head: true }).eq("user_id", input.userId).gte("created_at", hourAgo);
  if (!recent?.error && typeof recent?.count === "number" && recent.count >= AGENT_MAX_MISSIONS_PER_HOUR) {
    return bad(429, "أرسلت عددًا كبيرًا من الطلبات في ساعة واحدة. جرّب بعد قليل؛ لن يُخصم شيء.");
  }
  const id = `msn_${randomBytes(10).toString("hex")}`;
  const { error } = await client.from(MISSION_TABLE).insert({ id, user_id: input.userId, created_by: input.userId, request_text: text, status: "queued" });
  if (error) return bad(500, "تعذّر بدء المهمة الآن. حاول بعد قليل؛ لم يُخصم شيء.");
  return { ok: true, id };
}

/** The queue the mission stands in: missions waiting before it, missions running now, and whether the worker is alive. Read only. */
export async function readQueue(client: any, mission: { id: string; created_at: string; status: string }, now: number = Date.now()): Promise<QueueInfo> {
  const nowIso = new Date(now).toISOString();
  const [ahead, running, beats] = await Promise.all([
    client.from(MISSION_TABLE).select("id", { count: "exact", head: true }).in("status", ["queued", "approved"]).lt("created_at", mission.created_at).neq("id", mission.id),
    client.from(MISSION_TABLE).select("id", { count: "exact", head: true }).in("status", ["planning", "executing"]).gt("lease_until", nowIso),
    client.from(AGENT_HEARTBEAT_TABLE).select("beat_at").order("beat_at", { ascending: false }).limit(3),
  ]);
  const rows = Array.isArray(beats?.data) ? beats.data : [];
  return { ahead: typeof ahead?.count === "number" ? ahead.count : 0, running: typeof running?.count === "number" ? running.count : 0, workerAlive: workerAlive(latestBeat(rows), now).alive };
}

/** One mission as the customer reads it (never the plan's endpoints, costs, errors or workers): the view the card and the live panel draw. */
export async function loadCustomerMission(client: any, input: { id: string; userId: string; now?: number }) {
  const { data: mission } = await client.from(MISSION_TABLE).select(SAFE_COLUMNS).eq("id", input.id).maybeSingle();
  if (!mission || mission.user_id !== input.userId) return bad(404, "المهمة غير موجودة.");
  const [events, calls, queue] = await Promise.all([
    client.from(MISSION_EVENTS_TABLE).select("id,kind,message_ar,counts,created_at").eq("mission_id", input.id).order("id", { ascending: true }).limit(500),
    client.from(MISSION_CALLS_TABLE).select("id", { count: "exact", head: true }).eq("mission_id", input.id).neq("status", "refused"),
    readQueue(client, mission, input.now),
  ]);
  const row: MissionRowForCustomer = {
    id: mission.id, status: mission.status, question_ar: mission.question_ar ?? null, plan_public: mission.plan_public ?? null, reserved_points: mission.reserved_points ?? null,
    unit_price_points: mission.unit_price_points ?? null, delivered_units: mission.delivered_units ?? null, charged_points: mission.charged_points ?? null, summary_ar: mission.summary_ar ?? null,
    files: Array.isArray(mission.files) ? mission.files : null, created_at: mission.created_at,
  };
  const evs: EventForCustomer[] = (Array.isArray(events?.data) ? events.data : []).map((e: any) => ({ id: Number(e.id), kind: String(e.kind), message_ar: String(e.message_ar ?? ""), counts: e.counts && typeof e.counts === "object" ? e.counts : {}, created_at: String(e.created_at) }));
  // the e-mail is promised only while it will really be sent (read only while the mission is in the worker's hands, when the line is shown)
  let emailWillBeSent: boolean | undefined;
  if (mission.status === "approved" || mission.status === "executing") {
    try { emailWillBeSent = userWillBeEmailed((await client.auth?.admin?.getUserById?.(input.userId))?.data?.user); } catch { emailWillBeSent = false; }
  }
  return { ok: true as const, status: mission.status as string, requestText: String(mission.request_text ?? ""), view: customerMissionView({ mission: row, events: evs, queue, callsMade: typeof calls?.count === "number" ? calls.count : 0, now: input.now, emailWillBeSent }) };
}

const APPROVE_MESSAGES: Record<string, string> = {
  insufficient_balance: "رصيدك لا يكفي لحجز هذه المهمة. اشحن رصيدك ثم اعتمدها؛ خطتك محفوظة ولم يُخصم شيء.",
  concurrency_limit: "عندك مهام شغالة بالفعل. انتظر اكتمال إحداها ثم اعتمد هذه؛ خطتك محفوظة ولم يُخصم شيء.",
  quote_expired: "انتهت صلاحية السعر. اضغط اعتمد مرة أخرى.",
  plan_changed: "تغيّر سعر الخطة؛ اطلب المهمة من جديد ليُحسب لك سعر محدّث.",
  quote_failed: "المهمة أكبر من الحد المسموح للحجز الواحد. قلّل العدد المطلوب ثم أعد الطلب؛ لم يُخصم شيء.",
  accept_failed: "تعذّر حجز الرصيد الآن؛ حاول بعد قليل ولم يُخصم شيء.",
  claim_failed: "تعذّر بدء المهمة الآن؛ حجز مؤقت مُحرَّر ولم يُخصم شيء.",
};

/**
 * Approve. A guest is told to sign up first, an unverified account to verify its e-mail. `precheck` is the route's own gate (provider gate, busy state, concurrency): it runs before anything is reserved.
 * The reserve itself is the shared approval path (the existing money functions); on success the customer is told once that the page may be closed.
 */
export async function approveForCustomer(client: any, input: { id: string; userId: string; isGuest: boolean; emailVerified: boolean; precheck?: () => Promise<{ ok: true } | { ok: false; status: number; error: string }>; onApproved?: (r: { jobId: string }) => Promise<void> }): Promise<CustomerResult<{ jobId: string; reservePoints: number }>> {
  if (input.isGuest) return bad(401, SIGNUP_TO_APPROVE_AR);
  if (!input.emailVerified) return bad(403, "فعّل بريدك الإلكتروني أولًا ثم اعتمد المهمة.");
  const { data: mission } = await client.from(MISSION_TABLE).select("id,user_id,status").eq("id", input.id).maybeSingle();
  if (!mission || mission.user_id !== input.userId) return bad(404, "المهمة غير موجودة.");
  if (mission.status !== "plan_ready") return bad(409, mission.status === "approved" || mission.status === "executing" ? "هذه المهمة معتمدة وتعمل بالفعل." : "لا توجد خطة جاهزة للاعتماد.");
  if (input.precheck) {
    const gate = await input.precheck();
    if (!gate.ok) return bad(gate.status, gate.error);
  }
  const r = await approveMissionOnce(client, { id: input.id, actorId: input.userId, expectUserId: input.userId, messages: APPROVE_MESSAGES });
  if (!r.ok) return bad(r.status, r.error);
  try { await input.onApproved?.({ jobId: r.jobId }); } catch { /* the notice never changes the approval */ }
  return { ok: true, jobId: r.jobId, reservePoints: r.reservePoints };
}

export async function cancelForCustomer(client: any, input: { id: string; userId: string }): Promise<CustomerResult<{ requestText: string }>> {
  const { data } = await client.from(MISSION_TABLE).select("id,user_id,status,request_text").eq("id", input.id).maybeSingle();
  if (!data || data.user_id !== input.userId) return bad(404, "المهمة غير موجودة.");
  // before approval nothing is held: cancelling is just a status. A mission that holds money ends by its own settlement.
  if (!CANCELLABLE.includes(data.status)) return bad(409, data.status === "cancelled" ? "هذه المهمة أُلغيت بالفعل." : "لا يمكن إلغاء مهمة بدأ تنفيذها؛ ينتهي حجزها بالتسوية.");
  const upd = await client.from(MISSION_TABLE).update({ status: "cancelled", updated_at: new Date().toISOString() }).eq("id", input.id).in("status", CANCELLABLE);
  if (upd.error) return bad(500, "تعذّر الإلغاء.");
  return { ok: true, requestText: String(data.request_text ?? "") };
}

/** The mapped items of the page each stage's yield was measured on, read from the mission's own folder (null for a stage whose page is unavailable: its measured yield stays). */
async function readYieldRows(client: any, missionId: string, plan: PricedPlan): Promise<Map<string, Array<Record<string, unknown>>>> {
  const out = new Map<string, Array<Record<string, unknown>>>();
  for (const s of plan.stages) {
    if (!s.relevance || !s.yield_from || !/^out_\d{4,6}$/.test(s.yield_from)) continue;
    try {
      const { data } = await client.storage.from(AGENT_BUCKET).download(`${missionId}/out/${s.yield_from}.json`);
      const parsed = JSON.parse(typeof data?.text === "function" ? await data.text() : String(data ?? ""));
      if (Array.isArray(parsed) && parsed.every((r) => r && typeof r === "object")) out.set(s.key, parsed as Array<Record<string, unknown>>);
    } catch { /* the measured yield stays */ }
  }
  return out;
}

/**
 * THE CUSTOMER EDITS THE PLAN (the number of items, the period, the language, each exclusion, the main columns) while it waits for approval: applied to the stored plan by code, priced again by code (the model never decides a price),
 * stored with the card's own view, and shown again. Only a plan that is still «plan_ready» changes; once approved, the plan is what was priced and held. Nothing is held or charged here.
 */
export async function editPlanForCustomer(client: any, input: { id: string; userId: string; edits: unknown }): Promise<CustomerResult<{ status: string; requestText: string }>> {
  const { data: mission } = await client.from(MISSION_TABLE).select("id,user_id,status,plan,request_text").eq("id", input.id).maybeSingle();
  if (!mission || mission.user_id !== input.userId) return bad(404, "المهمة غير موجودة.");
  if (mission.status !== "plan_ready" || !mission.plan) return bad(409, "لا يمكن تعديل الخطة الآن.");
  const plan = mission.plan as PricedPlan;
  const rows = await readYieldRows(client, input.id, plan);
  const r = applyPlanEdits(plan, input.edits, { yieldRows: (s: PricedStage) => rows.get(s.key) ?? null });
  if (!r.ok) return bad(400, r.errorAr);
  const upd = await client.from(MISSION_TABLE).update({ plan: r.plan as any, plan_public: customerPlanView(r.plan) as any, unit_price_points: r.plan.price.unitPricePoints, reserved_points: r.plan.price.reservePoints, updated_at: new Date().toISOString() }).eq("id", input.id).eq("status", "plan_ready").select("id");
  if (upd.error) return bad(500, "تعذّر حفظ تعديلك.");
  // approved or cancelled in the meantime: the stored plan is the one that was priced and held
  if (Array.isArray(upd.data) && upd.data.length === 0) return bad(409, "تغيّرت حالة المهمة؛ لا يمكن تعديل الخطة الآن.");
  await client.from(MISSION_EVENTS_TABLE).insert({ mission_id: input.id, kind: "plan", message_ar: "حدّثنا الخطة بحسب تعديلك، والسعر محسوب من جديد.", counts: { stages: r.plan.stages.length, rows: r.plan.price.deliveredRows, unit_points_x1000: Math.round(r.plan.price.unitPricePoints * 1000), reserve_points: r.plan.price.reservePoints } });
  return { ok: true, status: "plan_ready", requestText: String(mission.request_text ?? "") };
}

export async function answerForCustomer(client: any, input: { id: string; userId: string; text: unknown }): Promise<CustomerResult> {
  const text = String(input.text ?? "").replace(/\s+/g, " ").trim();
  if (text.length < 1 || text.length > 1000) return bad(400, "اكتب إجابتك.");
  const { data } = await client.from(MISSION_TABLE).select("id,user_id,status").eq("id", input.id).maybeSingle();
  if (!data || data.user_id !== input.userId) return bad(404, "المهمة غير موجودة.");
  if (data.status !== "needs_input") return bad(409, "المهمة لا تنتظر إجابة.");
  const upd = await client.from(MISSION_TABLE).update({ answer_text: text, status: "queued", question_ar: null, worker_id: null, lease_until: null, updated_at: new Date().toISOString() }).eq("id", input.id).eq("status", "needs_input");
  if (upd.error) return bad(500, "تعذّر حفظ الإجابة.");
  await client.from(MISSION_EVENTS_TABLE).insert({ mission_id: input.id, kind: "answer", message_ar: "وصلت إجابتك وعاد الوكيل إلى التخطيط.", counts: {} });
  return { ok: true };
}

/** A short-lived link to a result file of the customer's own mission. */
export async function customerFileLink(client: any, input: { id: string; userId: string; name: string }): Promise<CustomerResult<{ url: string }>> {
  const { data: mission } = await client.from(MISSION_TABLE).select("id,user_id,files,plan,request_text,delivered_units,updated_at").eq("id", input.id).maybeSingle();
  if (!mission || mission.user_id !== input.userId) return bad(404, "الملف غير موجود.");
  const file = Array.isArray(mission.files) ? (mission.files as Array<{ name: string; path: string; kind?: string }>).find((f) => f.name === input.name) : null;
  if (!file) return bad(404, "الملف غير موجود.");
  // the name the customer saves is the mission's name (the same function as «طلباتي» and the e-mail's link use), never «result.xlsx»
  const download = missionDownloadName({ files: mission.files, kind: file.kind ?? input.name.split(".").pop() ?? "", plan: mission.plan, requestText: mission.request_text, deliveredUnits: mission.delivered_units, date: mission.updated_at });
  const { data, error } = await client.storage.from(AGENT_BUCKET).createSignedUrl(`${input.id}/${file.path}`, 120, { download });
  if (error || !data?.signedUrl) return bad(500, "تعذّر إنشاء رابط الملف.");
  return { ok: true, url: String(data.signedUrl) };
}
