import { stage3QueueOn } from "./stage3/queueView";
import { randomBytes } from "node:crypto";
import { AGENT_BUCKET, AGENT_JOB_POINTS_CAP, AGENT_MAX_MISSIONS_PER_HOUR, AGENT_MAX_OPEN_MISSIONS_PER_USER, MISSION_CALLS_TABLE, MISSION_EVENTS_TABLE, MISSION_TABLE, AGENT_HEARTBEAT_TABLE } from "./constants";
import { approveMissionOnce } from "./approval";
import { EXPIRED_SOCIAL_PLAN_AR, isStaleSocialPlan } from "./staleSocialPlan";
import { modelPlanningForTests } from "./testSeam";
import { customerMissionView, type EventForCustomer, type MissionRowForCustomer, type QueueInfo } from "./customerView";
import { latestBeat, workerAlive } from "./heartbeat";
import { userWillBeEmailed } from "./emailEligibility";
import { type PricedPlan, type PricedStage } from "./plan";
import { applyPlanEdits } from "./planEdit";
import { publicPlanOf, smallerVersionOf } from "./overLimit";
import { missionDownloadName } from "./fileNames";
import { listOpenMissions, openLimitMessageAr, type OpenMissionView } from "./openMissions";
import { excelFromCsv } from "../server/excelFromCsv";
import { csvExportFromWorkbook, METHODOLOGY_FILE_NAME, packageCsvExport } from "../server/csvFromExcel";
import { ADDON_MARKER_COLUMN, hasAddonMarker, withoutAddonRows } from "./addonMarker";

/**
 * What a CUSTOMER does with a mission, on the server, with the service-role client and an explicit owner check on every call (a customer reaches only their own missions; the browser never
 * holds the service key). The agent plans and works in the worker; the site creates the mission, shows it, approves it through the existing money functions, and cancels or answers it.
 */
export type CustomerResult<T = Record<string, unknown>> = ({ ok: true } & T) | { ok: false; status: number; error: string; blockers?: OpenMissionView[] };
const bad = (status: number, error: string): { ok: false; status: number; error: string } => ({ ok: false, status, error });

const MIN_TEXT = 3;
const MAX_TEXT = 4000;
const CANCELLABLE = ["queued", "needs_input", "plan_ready"];
const SAFE_COLUMNS = `id,user_id,status,question_ar,plan_public,job_id,reserved_points,unit_price_points,delivered_units,charged_points,summary_ar,files,created_at,${ADDON_MARKER_COLUMN}`;
/**
 * MONEY PR 7e (docs/MONEY-PR-7A.md section 17): a review, review-fix or edit request of a DELIVERED file is a row of this table whose plan is `{ addon }`, not a research mission. Every action below that is written for a research mission refuses it, BEFORE it reads a plan,
 * claims a row or calls a money function, and changes nothing. Its own endpoint (stage4/reviewRequest.ts) is the only way to see or cancel it. The approval keeps its own sentence (below); every other action says this one.
 */
const ADDON_ROW_REFUSAL_AR = "هذا طلب على ملف سُلّم من قبل، وليس طلب بيانات جديدًا؛ تجده في صفحة الملف.";

export const SIGNUP_TO_APPROVE_AR = "سجّل حسابك أولًا لتعتمد المهمة؛ خطتك محفوظة وتنتظرك بعد التسجيل.";

/**
 * The per-hour limit counts RESEARCH missions: a review or edit request of a delivered file (an add-on row) is not one and must not use it up (a customer who makes and cancels review requests would otherwise lock themselves out of new requests). The cheap head count above runs
 * for everyone; only when it reaches the limit are the rows of the hour read once, to leave the add-on rows out. If that read fails the count stands as it was (the conservative answer).
 */
async function researchMissionsInTheHour(client: any, userId: string, since: string, counted: number): Promise<number> {
  try {
    const { data, error } = await client.from(MISSION_TABLE).select(`id,${ADDON_MARKER_COLUMN}`).eq("user_id", userId).gte("created_at", since).limit(500);
    return error || !Array.isArray(data) ? counted : withoutAddonRows(data).length;
  } catch { return counted; }
}

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
  if (!recent?.error && typeof recent?.count === "number" && recent.count >= AGENT_MAX_MISSIONS_PER_HOUR && (await researchMissionsInTheHour(client, input.userId, hourAgo, recent.count)) >= AGENT_MAX_MISSIONS_PER_HOUR) {
    return bad(429, "أرسلت عددًا كبيرًا من الطلبات في ساعة واحدة. جرّب بعد قليل؛ لن يُخصم شيء.");
  }
  const id = `msn_${randomBytes(10).toString("hex")}`;
  const { error } = await client.from(MISSION_TABLE).insert({ id, user_id: input.userId, created_by: input.userId, request_text: text, status: "queued" });
  if (error) return bad(500, "تعذّر بدء المهمة الآن. حاول بعد قليل؛ لم يُخصم شيء.");
  return { ok: true, id };
}

/** The queue the mission stands in: missions waiting before it, missions running now, and whether the worker is alive. Read only. */
export async function readQueue(client: any, mission: { id: string; created_at: string; status: string; user_id?: string }, now: number = Date.now()): Promise<QueueInfo> {
  const nowIso = new Date(now).toISOString();
  const [ahead, running, beats, aheadOwn, runningOwn] = await Promise.all([
    client.from(MISSION_TABLE).select("id", { count: "exact", head: true }).in("status", ["queued", "approved"]).lt("created_at", mission.created_at).neq("id", mission.id),
    client.from(MISSION_TABLE).select("id", { count: "exact", head: true }).in("status", ["planning", "executing"]).gt("lease_until", nowIso),
    client.from(AGENT_HEARTBEAT_TABLE).select("beat_at").order("beat_at", { ascending: false }).limit(3),
    // THE CUSTOMER'S OWN requests among them (round 14): a request that waits behind the customer's own running job says so
    mission.user_id ? client.from(MISSION_TABLE).select("id", { count: "exact", head: true }).in("status", ["queued", "approved"]).lt("created_at", mission.created_at).neq("id", mission.id).eq("user_id", mission.user_id) : Promise.resolve(null),
    mission.user_id ? client.from(MISSION_TABLE).select("id", { count: "exact", head: true }).in("status", ["planning", "executing"]).gt("lease_until", nowIso).eq("user_id", mission.user_id).neq("id", mission.id) : Promise.resolve(null),
  ]);
  const rows = Array.isArray(beats?.data) ? beats.data : [];
  return { ahead: typeof ahead?.count === "number" ? ahead.count : 0, running: typeof running?.count === "number" ? running.count : 0, workerAlive: workerAlive(latestBeat(rows), now).alive, ...(typeof aheadOwn?.count === "number" ? { aheadOwn: aheadOwn.count } : {}), ...(typeof runningOwn?.count === "number" ? { runningOwn: runningOwn.count } : {}) };
}

/** One mission as the customer reads it (never the plan's endpoints, costs, errors or workers): the view the card and the live panel draw. */
export async function loadCustomerMission(client: any, input: { id: string; userId: string; now?: number }) {
  // STAGE 3 S5: the approval time is read only when DIGER_STAGE3_QUEUE is on (unset: the select is exactly what it was)
  const stage3Queue = stage3QueueOn();
  const { data: mission } = await client.from(MISSION_TABLE).select(stage3Queue ? `${SAFE_COLUMNS},approved_at` : SAFE_COLUMNS).eq("id", input.id).maybeSingle();
  if (!mission || mission.user_id !== input.userId || hasAddonMarker(mission)) return bad(404, "المهمة غير موجودة.");
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
  return { ok: true as const, status: mission.status as string, requestText: String(mission.request_text ?? ""), view: customerMissionView({ mission: row, events: evs, queue, callsMade: typeof calls?.count === "number" ? calls.count : 0, now: input.now, emailWillBeSent, ...(stage3Queue ? { stage3Queue: { approvedAtMs: Date.parse(String(mission.approved_at ?? "")) || null } } : {}) }) };
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
const NOT_A_MISSION_AR = "هذا طلب على ملف سُلّم من قبل، وليس طلب بيانات جديدًا؛ لا يُعتمد من هنا.";

export async function approveForCustomer(client: any, input: { id: string; userId: string; isGuest: boolean; emailVerified: boolean; precheck?: () => Promise<{ ok: true } | { ok: false; status: number; error: string }>; onApproved?: (r: { jobId: string }) => Promise<void> }): Promise<CustomerResult<{ jobId: string; reservePoints: number }>> {
  if (input.isGuest) return bad(401, SIGNUP_TO_APPROVE_AR);
  if (!input.emailVerified) return bad(403, "فعّل بريدك الإلكتروني أولًا ثم اعتمد المهمة.");
  const { data: mission } = await client.from(MISSION_TABLE).select("id,user_id,status,plan").eq("id", input.id).maybeSingle();
  if (!mission || mission.user_id !== input.userId) return bad(404, "المهمة غير موجودة.");
  if (mission.status !== "plan_ready") return bad(409, mission.status === "approved" || mission.status === "executing" ? "هذه المهمة معتمدة وتعمل بالفعل." : "لا توجد خطة جاهزة للاعتماد.");
  // MONEY PR 7d: a review, review-fix or edit request of a DELIVERED file is a row of this table whose plan is `{ addon }`, not a mission plan. It is approved by its own function (a later task), never here: refused BEFORE anything is read or held
  if (hasAddonMarker(mission)) return bad(409, NOT_A_MISSION_AR);
  // PR B: a social plan the compiler did not build is refused BEFORE the reserve (nothing is held, no money function is called)
  if (!modelPlanningForTests() && isStaleSocialPlan(mission.plan)) return bad(410, EXPIRED_SOCIAL_PLAN_AR);
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
  const { data } = await client.from(MISSION_TABLE).select(`id,user_id,status,request_text,${ADDON_MARKER_COLUMN}`).eq("id", input.id).maybeSingle();
  if (!data || data.user_id !== input.userId) return bad(404, "المهمة غير موجودة.");
  // a review request has its own cancel (stage4/reviewRequest.ts): it checks that the request is unpaid and was never put through an approval, which this one does not know how to
  if (hasAddonMarker(data)) return bad(409, ADDON_ROW_REFUSAL_AR);
  // before approval nothing is held: cancelling is just a status. A mission that holds money ends by its own settlement.
  if (!CANCELLABLE.includes(data.status)) return bad(409, data.status === "cancelled" ? "هذه المهمة أُلغيت بالفعل." : "لا يمكن إلغاء مهمة بدأ تنفيذها؛ ينتهي حجزها بالتسوية.");
  // the update is read back: a compare-and-set that matched no row (the worker took the mission in the meantime) changed nothing and must never be answered as a cancel that worked
  const upd = await client.from(MISSION_TABLE).update({ status: "cancelled", updated_at: new Date().toISOString() }).eq("id", input.id).eq("user_id", input.userId).in("status", CANCELLABLE).select("id");
  if (upd.error) return bad(500, "تعذّر الإلغاء.");
  if (Array.isArray(upd.data) && upd.data.length === 0) return bad(409, "تغيّرت حالة المهمة قبل أن نلغيها؛ حدّث الصفحة وحاول مرة أخرى.");
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
  if (hasAddonMarker(mission)) return bad(409, ADDON_ROW_REFUSAL_AR);
  if (mission.status !== "plan_ready" || !mission.plan) return bad(409, "لا يمكن تعديل الخطة الآن.");
  const plan = mission.plan as PricedPlan;
  const rows = await readYieldRows(client, input.id, plan);
  const r = applyPlanEdits(plan, input.edits, { yieldRows: (s: PricedStage) => rows.get(s.key) ?? null });
  if (!r.ok) return bad(400, r.errorAr);
  const upd = await client.from(MISSION_TABLE).update({ plan: r.plan as any, plan_public: publicPlanOf(r.plan) as any, unit_price_points: r.plan.price.unitPricePoints, reserved_points: r.plan.price.reservePoints, updated_at: new Date().toISOString() }).eq("id", input.id).eq("status", "plan_ready").select("id");
  if (upd.error) return bad(500, "تعذّر حفظ تعديلك.");
  // approved or cancelled in the meantime: the stored plan is the one that was priced and held
  if (Array.isArray(upd.data) && upd.data.length === 0) return bad(409, "تغيّرت حالة المهمة؛ لا يمكن تعديل الخطة الآن.");
  await client.from(MISSION_EVENTS_TABLE).insert({ mission_id: input.id, kind: "plan", message_ar: "حدّثنا الخطة بحسب تعديلك، والسعر محسوب من جديد.", counts: { stages: r.plan.stages.length, rows: r.plan.price.deliveredRows, unit_points_x1000: Math.round(r.plan.price.unitPricePoints * 1000), reserve_points: r.plan.price.reservePoints } });
  return { ok: true, status: "plan_ready", requestText: String(mission.request_text ?? "") };
}

/**
 * THE SMALLER VERSION OF A PLAN THAT IS ABOVE THE LIMIT (live round 11): the most comments per post whose hold fits the job cap (or the customer's balance, when the card names a lower one), built and priced again BY CODE on the stored plan; the server recomputes it itself
 * (the client only names its balance, which can only make the plan smaller, never larger than the cap). Only a plan that is still «plan_ready» changes; nothing is held or charged here.
 */
export async function smallerVersionForCustomer(client: any, input: { id: string; userId: string; maxHoldPoints?: number }): Promise<CustomerResult<{ status: string }>> {
  const { data: mission } = await client.from(MISSION_TABLE).select("id,user_id,status,plan").eq("id", input.id).maybeSingle();
  if (!mission || mission.user_id !== input.userId) return bad(404, "المهمة غير موجودة.");
  if (hasAddonMarker(mission)) return bad(409, ADDON_ROW_REFUSAL_AR);
  if (mission.status !== "plan_ready" || !mission.plan) return bad(409, "لا يمكن تعديل الخطة الآن.");
  const plan = mission.plan as PricedPlan;
  const balanceLimit = Number.isFinite(Number(input.maxHoldPoints)) ? Math.max(0, Math.floor(Number(input.maxHoldPoints))) : AGENT_JOB_POINTS_CAP;
  const smaller = smallerVersionOf(plan, Math.min(AGENT_JOB_POINTS_CAP, balanceLimit));
  if (!smaller) return bad(400, "لا توجد نسخة أصغر تناسب الحد المسموح أو رصيدك. غيّر طلبك أو ألغِ المهمة؛ ولم يُخصم شيء.");
  const next = smaller.plan;
  const upd = await client.from(MISSION_TABLE).update({ plan: next as any, plan_public: publicPlanOf(next) as any, unit_price_points: next.price.unitPricePoints, reserved_points: next.price.reservePoints, updated_at: new Date().toISOString() }).eq("id", input.id).eq("status", "plan_ready").select("id");
  if (upd.error) return bad(500, "تعذّر حفظ النسخة الأصغر.");
  if (Array.isArray(upd.data) && upd.data.length === 0) return bad(409, "تغيّرت حالة المهمة؛ لا يمكن تعديل الخطة الآن.");
  await client.from(MISSION_EVENTS_TABLE).insert({ mission_id: input.id, kind: "plan", message_ar: "جهّزنا نسخة أصغر من الخطة تناسب الحد المسموح، والسعر محسوب من جديد.", counts: { stages: next.stages.length, rows: next.price.deliveredRows, unit_points_x1000: Math.round(next.price.unitPricePoints * 1000), reserve_points: next.price.reservePoints, smaller_per_post: smaller.per_post } });
  return { ok: true, status: "plan_ready" };
}

export async function answerForCustomer(client: any, input: { id: string; userId: string; text: unknown }): Promise<CustomerResult> {
  const text = String(input.text ?? "").replace(/\s+/g, " ").trim();
  if (text.length < 1 || text.length > 1000) return bad(400, "اكتب إجابتك.");
  const { data } = await client.from(MISSION_TABLE).select(`id,user_id,status,${ADDON_MARKER_COLUMN}`).eq("id", input.id).maybeSingle();
  if (!data || data.user_id !== input.userId) return bad(404, "المهمة غير موجودة.");
  if (hasAddonMarker(data)) return bad(409, ADDON_ROW_REFUSAL_AR);
  if (data.status !== "needs_input") return bad(409, "المهمة لا تنتظر إجابة.");
  const upd = await client.from(MISSION_TABLE).update({ answer_text: text, status: "queued", question_ar: null, worker_id: null, lease_until: null, updated_at: new Date().toISOString() }).eq("id", input.id).eq("status", "needs_input");
  if (upd.error) return bad(500, "تعذّر حفظ الإجابة.");
  await client.from(MISSION_EVENTS_TABLE).insert({ mission_id: input.id, kind: "answer", message_ar: "وصلت إجابتك وعاد الوكيل إلى التخطيط.", counts: {} });
  return { ok: true };
}

/** A short-lived link to a result file of the customer's own mission. */
export async function customerFileLink(client: any, input: { id: string; userId: string; name: string }): Promise<CustomerResult<{ url: string; /** ROUND 20: the name the file is saved under (the route that serves the file itself writes it into its own header) */ download: string }>> {
  const { data: mission } = await client.from(MISSION_TABLE).select("id,user_id,files,plan,request_text,delivered_units,updated_at").eq("id", input.id).maybeSingle();
  // a review request has no file of its own to hand out here: the published versions of the delivered file are served by their own route
  if (!mission || mission.user_id !== input.userId || hasAddonMarker(mission)) return bad(404, "الملف غير موجود.");
  const files = Array.isArray(mission.files) ? (mission.files as Array<{ name: string; path: string; kind?: string }>) : [];
  // ROUND 32: a CSV is never a stored file's link (the stored CSV is the deepest stage only) and never silently the Excel: a customer's CSV is built from the mission's Excel by `customerCsvFile`, which the route calls for a CSV name.
  // A mission that has only a CSV (the oldest) still gets an Excel built from it, saved in the mission's own folder
  if (input.name.toLowerCase().endsWith(".csv")) return bad(400, CSV_REQUEST_INVALID_AR);
  const customerName = input.name;
  let file = files.find((f) => f.name === customerName && f.kind !== "csv") ?? null;
  if (!file && /^result\.(xlsx|csv)$/.test(input.name)) {
    const csv = files.find((f) => f.kind === "csv" || f.name.toLowerCase().endsWith(".csv"));
    if (csv) {
      try {
        const { data } = await client.storage.from(AGENT_BUCKET).download(`${input.id}/${csv.path}`);
        const text = typeof data?.text === "function" ? await data.text() : String(data ?? "");
        if (text) {
          const path = "result/result.xlsx";
          const up = await client.storage.from(AGENT_BUCKET).upload(`${input.id}/${path}`, await excelFromCsv(text), { contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", upsert: true });
          if (!up?.error) file = { name: "result.xlsx", path, kind: "xlsx" };
        }
      } catch { /* the customer is told the file is missing; nothing was charged or changed */ }
    }
  }
  if (!file) return bad(404, "الملف غير موجود.");
  // the name the customer saves is the mission's name (the same function as «طلباتي» and the e-mail's link use), never «result.xlsx»
  const download = missionDownloadName({ files: mission.files, kind: file.kind ?? customerName.split(".").pop() ?? "", plan: mission.plan, requestText: mission.request_text, deliveredUnits: mission.delivered_units, date: mission.updated_at });
  const { data, error } = await client.storage.from(AGENT_BUCKET).createSignedUrl(`${input.id}/${file.path}`, 120, { download });
  if (error || !data?.signedUrl) return bad(500, "تعذّر إنشاء رابط الملف.");
  return { ok: true, url: String(data.signedUrl), download };
}

/** The words a customer reads when a CSV cannot be given (never a file of another kind in its place, never a technical word). */
export const CSV_REQUEST_INVALID_AR = "طلب الملف غير صالح.";
export const CSV_NOT_READY_AR = "ملف CSV غير جاهز لهذه المهمة بعد.";
export const CSV_SOURCE_MISSING_AR = "ملف النتائج غير متاح لهذه المهمة، فلا نستطيع تجهيز ملف CSV منها. جرّب ملف إكسل أو تواصل معنا.";
export const CSV_UNREADABLE_AR = "تعذّر تجهيز ملف CSV من ملف النتائج. جرّب ملف إكسل أو تواصل معنا.";
export const CSV_STORAGE_FAILED_AR = "تعذّر تجهيز ملف CSV الآن. حاول بعد قليل.";
/** The two CSV names a customer may ask for: the data (one CSV for one stage, an archive of CSVs for more) and the methodology. */
export const CUSTOMER_CSV_NAMES: readonly string[] = ["result.csv", METHODOLOGY_FILE_NAME];

const isMissingObject = (error: unknown): boolean => {
  const e = error as { status?: unknown; statusCode?: unknown; message?: unknown } | null;
  return String(e?.status ?? e?.statusCode ?? "") === "404" || /not.?found|does not exist|no such/i.test(String(e?.message ?? ""));
};

/**
 * THE CUSTOMER'S CSV of a mission of THEIR OWN (the same ownership check as every other file of a mission), built from the mission's own Excel (csvFromExcel.ts): ONE delivered stage is a plain CSV; MORE THAN ONE is an archive with a CSV per stage and the
 * methodology, so no delivered stage is left out of an export that calls itself the mission's; `methodology.csv` is the methodology alone. Reads the mission's files and nothing else: no admin file (`admin/…`) is ever read, nothing is written, nothing is charged.
 * A missing or unreadable file is an Arabic error with its own status; the Excel is never given in a CSV's place.
 */
export async function customerCsvFile(client: any, input: { id: string; userId: string; name: string }): Promise<CustomerResult<{ body: Buffer; download: string; kind: "csv" | "zip" }>> {
  if (!CUSTOMER_CSV_NAMES.includes(input.name)) return bad(400, CSV_REQUEST_INVALID_AR);
  const { data: mission } = await client.from(MISSION_TABLE).select("id,user_id,files,plan,request_text,delivered_units,updated_at").eq("id", input.id).maybeSingle();
  if (!mission || mission.user_id !== input.userId) return bad(404, "الملف غير موجود.");
  const files = Array.isArray(mission.files) ? (mission.files as Array<{ name?: string; path?: string; kind?: string }>) : [];
  const source = files.find((f) => typeof f?.path === "string" && (f.kind === "xlsx" || String(f.name ?? "").toLowerCase().endsWith(".xlsx")));
  if (!source) return bad(404, files.length === 0 ? CSV_NOT_READY_AR : CSV_SOURCE_MISSING_AR);
  let bytes: Buffer;
  try {
    const { data, error } = await client.storage.from(AGENT_BUCKET).download(`${input.id}/${source.path}`);
    if (error || !data) return isMissingObject(error) || !error ? bad(404, CSV_SOURCE_MISSING_AR) : bad(502, CSV_STORAGE_FAILED_AR);
    bytes = typeof data.arrayBuffer === "function" ? Buffer.from(await data.arrayBuffer()) : Buffer.from(data as Uint8Array);
  } catch (e) {
    return isMissingObject(e) ? bad(404, CSV_SOURCE_MISSING_AR) : bad(502, CSV_STORAGE_FAILED_AR);
  }
  let exp;
  try { exp = await csvExportFromWorkbook(bytes); } catch { return bad(500, CSV_UNREADABLE_AR); }
  const named = (kind: string) => missionDownloadName({ files: mission.files, kind, plan: mission.plan, requestText: mission.request_text, deliveredUnits: mission.delivered_units, date: mission.updated_at });
  if (input.name === METHODOLOGY_FILE_NAME) return { ok: true, body: Buffer.from(exp.methodologyCsv, "utf8"), download: `منهجية - ${named("csv")}`.replace(/\s+/g, " "), kind: "csv" };
  const pack = packageCsvExport(exp);
  return { ok: true, body: pack.body, download: named(pack.kind), kind: pack.kind };
}
