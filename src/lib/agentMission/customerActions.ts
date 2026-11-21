import { stage3QueueOn } from "./stage3/queueView";
import { createHash, randomBytes } from "node:crypto";
import { AGENT_BUCKET, AGENT_MAX_MISSIONS_PER_HOUR, AGENT_MAX_OPEN_MISSIONS_PER_USER, MISSION_CALLS_TABLE, MISSION_EVENTS_TABLE, MISSION_TABLE, AGENT_HEARTBEAT_TABLE } from "./constants";
import { approveMissionOnce, STALE_MISSION_PLAN_AR, type ApprovalSnapshot } from "./approval";
import { MISSION_APPROVAL_PENDING_AR, repriceStoredPlan } from "./lifecycle";
import { CREDIT_LEDGER_TABLE } from "../supabase/ledger";
import { effectiveJobPointsCap } from "../jobPointsCap";
import { DEFAULT_MISSION_PRICING_SETTINGS } from "../missionPricing";
import { planNeedsRequote } from "./catalogPriceGuard";
import { countAr, itemNounOf } from "./itemNoun";
import { EXPIRED_SOCIAL_PLAN_AR, isStaleSocialPlan } from "./staleSocialPlan";
import { modelPlanningForTests } from "./testSeam";
import { customerMissionView, type EventForCustomer, type MissionRowForCustomer, type QueueInfo } from "./customerView";
import { latestBeat, workerAlive } from "./heartbeat";
import { userWillBeEmailed } from "./emailEligibility";
import { fixedCountBasket, type PricedPlan, type PricedStage } from "./plan";
import { applyPlanEdits } from "./planEdit";
import { resealCapabilitySelection } from "./capabilities/selection";
import { affordableVersionOf, publicPlanOf } from "./overLimit";
import { missionDownloadName } from "./fileNames";
import { listOpenMissions, openLimitMessageAr, type OpenMissionView } from "./openMissions";
import { excelFromCsv } from "../server/excelFromCsv";
import { csvExportFromWorkbook, METHODOLOGY_FILE_NAME, packageCsvExport } from "../server/csvFromExcel";
import { ADDON_MARKER_COLUMN, hasAddonMarker, withoutAddonRows } from "./addonMarker";
import { sensitiveRequestRefusalAr } from "./guardRules";

/**
 * What a CUSTOMER does with a mission, on the server, with the service-role client and an explicit owner check on every call (a customer reaches only their own missions; the browser never
 * holds the service key). The agent plans and works in the worker; the site creates the mission, shows it, approves it through the existing money functions, and cancels or answers it.
 */
export type CustomerResult<T = Record<string, unknown>> = ({ ok: true } & T) | { ok: false; status: number; error: string; code?: "stale_plan" | "affordability_changed" | "approval_pending"; blockers?: OpenMissionView[]; /** MULTI-OBJECTIVE RELIABILITY: the id the caller chose already exists (another turn created it); nothing was written. */ conflict?: true };
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
/** The form of a mission id (random, or chosen by the chat for one part of a multi-part request: `msn_` and 20 hex). */
export const MISSION_ID_FORM = /^msn_[a-f0-9]{20}$/;

export async function createCustomerMission(client: any, input: { userId: string; text: unknown; /** MULTI-OBJECTIVE RELIABILITY: an id chosen by the server (never the customer) so a retried or concurrent turn cannot create the same part twice: the primary key refuses the second insert. */ id?: string }): Promise<CustomerResult<{ id: string }>> {
  const text = String(input.text ?? "").replace(/\s+/g, " ").trim();
  if (text.length < MIN_TEXT) return bad(400, "اكتب نص المهمة.");
  if (text.length > MAX_TEXT) return bad(400, "نص المهمة أطول من المسموح.");
  // SECURITY: the chat's fixed refusal of private conversations and personal identifiers, repeated where the words become a request, so no caller of this function can skip it (the personal-contact rule stays in the chat, as before)
  const refusal = sensitiveRequestRefusalAr(text);
  if (refusal) return bad(422, refusal);
  // the limit counts exactly the missions `listOpenMissions` shows as the worker's (one definition, `openMissions.ts`); a planning mission with no live worker is ended there, and a question or plan that waits for the customer never blocks
  const blockers = (await listOpenMissions(client, { userId: input.userId })).filter((m) => m.blocksNewRequests);
  if (blockers.length >= AGENT_MAX_OPEN_MISSIONS_PER_USER) return { ...bad(429, openLimitMessageAr(blockers)), blockers };
  const hourAgo = new Date(Date.now() - 3600_000).toISOString();
  const recent = await client.from(MISSION_TABLE).select("id", { count: "exact", head: true }).eq("user_id", input.userId).gte("created_at", hourAgo);
  if (!recent?.error && typeof recent?.count === "number" && recent.count >= AGENT_MAX_MISSIONS_PER_HOUR && (await researchMissionsInTheHour(client, input.userId, hourAgo, recent.count)) >= AGENT_MAX_MISSIONS_PER_HOUR) {
    return bad(429, "أرسلت عددًا كبيرًا من الطلبات في ساعة واحدة. جرّب بعد قليل؛ لن يُخصم شيء.");
  }
  if (input.id !== undefined && !MISSION_ID_FORM.test(input.id)) return bad(400, "تعذّر بدء المهمة الآن. حاول بعد قليل؛ لم يُخصم شيء.");
  const id = input.id ?? `msn_${randomBytes(10).toString("hex")}`;
  const { error } = await client.from(MISSION_TABLE).insert({ id, user_id: input.userId, created_by: input.userId, request_text: text, status: "queued" });
  if (error) return { ...bad(500, "تعذّر بدء المهمة الآن. حاول بعد قليل؛ لم يُخصم شيء."), ...(input.id !== undefined && String(error?.code ?? "") === "23505" ? { conflict: true as const } : {}) };
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

type ApprovalVersion = Readonly<{ updatedAt: string; planHash: string }>;

function approvalVersionOf(snapshot: ApprovalSnapshot): ApprovalVersion | null {
  if (!snapshot.plan || typeof snapshot.plan !== "object" || Array.isArray(snapshot.plan)
    || Object.keys(snapshot.plan).length === 0 || typeof snapshot.updated_at !== "string"
    || !Number.isFinite(Date.parse(snapshot.updated_at))) return null;

  const plan = JSON.stringify([snapshot.user_id, snapshot.id, snapshot.plan], (_key, value: unknown) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
    const fields = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(fields).sort().map((key) => [key, fields[key]]));
  });
  return { updatedAt: snapshot.updated_at, planHash: createHash("sha256").update(plan).digest("hex") };
}

function matchesApprovalVersion(supplied: unknown, version: ApprovalVersion | null): boolean {
  if (!version || supplied === null || typeof supplied !== "object" || Array.isArray(supplied)) return false;
  const { updatedAt, planHash } = supplied as Partial<ApprovalVersion>;
  return updatedAt === version.updatedAt && typeof planHash === "string"
    && /^[0-9a-f]{64}$/.test(planHash) && planHash === version.planHash;
}

function hasApprovalLink(row: { job_id?: unknown; quote_id?: unknown }): boolean {
  return typeof row.job_id === "string" && row.job_id.length > 0
    && typeof row.quote_id === "string" && row.quote_id.length > 0;
}

type CustomerApprovalState = "confirmed" | "pending" | "unapproved";

function approvalStateOf(mission: { status: string; job_id?: unknown; quote_id?: unknown }): CustomerApprovalState {
  if (hasApprovalLink(mission) && ["approved", "executing", "completed", "failed", "unserved"].includes(mission.status)) return "confirmed";
  return ["approved", "executing"].includes(mission.status) ? "pending" : "unapproved";
}

const staleApproval = () => ({ ...bad(409, STALE_MISSION_PLAN_AR), code: "stale_plan" as const });

type OfferSelection = { kind: "count" | "per_post"; count: number; reservePoints: number };
export type CustomerAffordability = {
  mode: "ready" | "offer" | "top_up" | "unavailable" | "edit";
  capPoints: number;
  availablePoints: number | null;
  reservePoints: number | null;
  limitedBy: "wallet" | "cap" | null;
  offer?: OfferSelection & { maxChargePoints: number; countAr: string };
};

const AFFORDABILITY_CHANGED_AR = "تغيّر الرصيد أو الخطة. راجع العدد والحجز المؤقت ثم حاول مرة أخرى.";
const affordabilityChanged = (status: 402 | 409, error = AFFORDABILITY_CHANGED_AR) =>
  ({ ...bad(status, error), code: "affordability_changed" as const });

type VerifiedWallet = {
  points: number;
  wholePoints: number;
  lt: (points: number) => boolean;
  gte: (points: number) => boolean;
};

function parseDecimal(raw: unknown): { num: bigint; denExp: number } | null {
  if (typeof raw !== "string") return null;
  let str = raw.trim();
  if (str === "") return null;
  if (/[eE]/.test(str)) {
    const [coeff, expStr] = str.split(/[eE]/);
    const exp = Number(expStr);
    if (!Number.isSafeInteger(exp)) return null;
    const sign = coeff.startsWith("-") ? "-" : "";
    const cleanCoeff = coeff.replace(/^[+-]/, "");
    const parts = cleanCoeff.split(".");
    if (parts.length > 2) return null;
    const intPart = parts[0] || "0";
    const fracPart = parts[1] || "";
    if (exp >= 0) {
      if (exp >= fracPart.length) {
        str = sign + intPart + fracPart + "0".repeat(exp - fracPart.length);
      } else {
        str = sign + intPart + fracPart.slice(0, exp) + "." + fracPart.slice(exp);
      }
    } else {
      const absExp = -exp;
      if (absExp <= intPart.length) {
        str = sign + intPart.slice(0, intPart.length - absExp) + "." + intPart.slice(intPart.length - absExp) + fracPart;
      } else {
        str = sign + "0." + "0".repeat(absExp - intPart.length) + intPart + fracPart;
      }
    }
  }
  if (!/^[+-]?\d+(\.\d+)?$/.test(str)) return null;
  const isNegative = str.startsWith("-");
  const clean = str.replace(/^[+-]/, "");
  let [intStr, fracStr = ""] = clean.split(".");
  while (fracStr.endsWith("0")) fracStr = fracStr.slice(0, -1);
  const digits = intStr + fracStr;
  let num = BigInt(digits);
  if (isNegative) num = -num;
  return { num, denExp: fracStr.length };
}

const ZERO_BIG = BigInt(0);
const TEN_BIG = BigInt(10);
const pow10Big = (exp: number): bigint => TEN_BIG ** BigInt(exp);

async function readVerifiedWallet(client: any, userId: string): Promise<VerifiedWallet | null> {
  const countRows = () => client.from(CREDIT_LEDGER_TABLE).select("id", { count: "exact", head: true }).eq("user_id", userId);
  try {
    const first = await countRows();
    if (first.error || !Number.isSafeInteger(first.count) || first.count < 0) return null;
    const ids = new Set<unknown>();
    let totalNum = ZERO_BIG;
    let totalExp = 0;
    for (let offset = 0; offset < first.count; offset += 1000) {
      const length = Math.min(1000, first.count - offset);
      const page = await client.from(CREDIT_LEDGER_TABLE).select("id,delta::text").eq("user_id", userId)
        .order("id", { ascending: true }).range(offset, offset + length - 1);
      if (page.error || !Array.isArray(page.data) || page.data.length !== length) return null;
      for (const row of page.data) {
        if (!row || (typeof row.id !== "string" && !Number.isSafeInteger(row.id)) || row.id === ""
          || ids.has(row.id)) return null;
        ids.add(row.id);
        const parsed = parseDecimal(row.delta);
        if (!parsed) return null;
        if (parsed.denExp > totalExp) {
          totalNum = totalNum * pow10Big(parsed.denExp - totalExp) + parsed.num;
          totalExp = parsed.denExp;
        } else {
          totalNum = totalNum + parsed.num * pow10Big(totalExp - parsed.denExp);
        }
      }
    }
    const last = await countRows();
    if (last.error || last.count !== first.count) return null;
    if (totalNum <= ZERO_BIG) {
      totalNum = ZERO_BIG;
      totalExp = 0;
    }
    const points = totalNum === ZERO_BIG ? 0 : Number(totalNum) / Number(pow10Big(totalExp));
    const wholeBig = totalNum === ZERO_BIG ? ZERO_BIG : totalNum / pow10Big(totalExp);
    const wholePoints = Number(wholeBig);
    return {
      points,
      wholePoints,
      lt: (p: number) => wholePoints < p,
      gte: (p: number) => wholePoints >= p,
    };
  } catch {
    return null;
  }
}

function checkedPrice(plan: PricedPlan) {
  try {
    if (planNeedsRequote(plan)) return null;
    const price = repriceStoredPlan(plan);
    return price.reservePoints === plan.price.reservePoints && price.unitPricePoints === plan.price.unitPricePoints
      && price.deliveredRows === plan.price.deliveredRows ? price : null;
  } catch {
    return null;
  }
}

async function affordabilityOf(client: any, userId: string, plan: PricedPlan): Promise<{
  view: CustomerAffordability;
  candidate?: PricedPlan;
  limit?: number;
}> {
  const price = checkedPrice(plan);
  const capPoints = effectiveJobPointsCap();
  const base = { capPoints, availablePoints: null, reservePoints: price?.reservePoints ?? null, limitedBy: null };
  if (!price) return { view: { ...base, mode: "edit" } };
  const wallet = await readVerifiedWallet(client, userId);
  if (!wallet) return { view: { ...base, mode: "unavailable" } };
  const availablePoints = wallet.points;
  const limit = Math.min(wallet.wholePoints, capPoints);
  const info = { ...base, availablePoints };
  const minimum = price.settings?.minChargePoints ?? DEFAULT_MISSION_PRICING_SETTINGS.minChargePoints;
  if (wallet.wholePoints < minimum) return { view: { ...info, mode: "top_up", limitedBy: "wallet" }, limit };
  const fits = !price.overCap && price.reservePoints <= limit;
  if (fits && !plan.hold_cap_preview) return { view: { ...info, mode: "ready" }, limit };

  const limitedBy = wallet.wholePoints < capPoints && price.reservePoints > wallet.wholePoints ? "wallet" : "cap";
  const root = fits && plan.hold_cap_preview ? fixedCountBasket(plan)?.root : undefined;
  const candidate = root
    ? { kind: "count" as const, count: root.planned_rows, plan, countAr: countAr(root.planned_rows, itemNounOf(root.title_ar)) }
    : affordableVersionOf(plan, limit);
  if (!candidate) return { view: { ...info, limitedBy, mode: "edit" }, limit };
  return {
    view: {
      ...info, limitedBy, mode: "offer",
      offer: { kind: candidate.kind, count: candidate.count, countAr: candidate.countAr,
        reservePoints: candidate.plan.price.reservePoints, maxChargePoints: candidate.plan.price.maxChargePoints },
    },
    candidate: candidate.plan,
    limit,
  };
}

/** One mission as the customer reads it (never the plan's endpoints, costs, errors or workers): the view the card and the live panel draw. */
export async function loadCustomerMission(client: any, input: { id: string; userId: string; now?: number; isGuest?: boolean }) {
  // STAGE 3 S5: the approval time is read only when DIGER_STAGE3_QUEUE is on (unset: the select is exactly what it was)
  const stage3Queue = stage3QueueOn();
  const { data: mission } = await client.from(MISSION_TABLE).select(`${SAFE_COLUMNS},plan,updated_at,quote_id${stage3Queue ? ",approved_at" : ""}`).eq("id", input.id).eq("user_id", input.userId).maybeSingle();
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
  const view = customerMissionView({ mission: row, requestText: String(mission.request_text ?? ""), events: evs, queue, callsMade: typeof calls?.count === "number" ? calls.count : 0, now: input.now, emailWillBeSent, ...(stage3Queue ? { stage3Queue: { approvedAtMs: Date.parse(String(mission.approved_at ?? "")) || null } } : {}) });
  const approvalVersion = mission.status === "plan_ready" ? approvalVersionOf(mission) : null;
  const approvalState = approvalStateOf(mission);
  const affordability = !input.isGuest && approvalVersion && approvalState === "unapproved"
    ? (await affordabilityOf(client, input.userId, mission.plan)).view : undefined;
  return {
    ok: true as const, status: mission.status as string, requestText: String(mission.request_text ?? ""),
    view: { ...view, approvalState, ...(approvalVersion ? { approvalVersion } : {}), ...(affordability ? { affordability } : {}) },
  };
}

const APPROVE_MESSAGES: Record<string, string> = {
  insufficient_balance: "رصيدك لا يكفي لحجز هذه المهمة. اشحن رصيدك ثم اعتمدها؛ خطتك محفوظة ولم يُخصم شيء.",
  concurrency_limit: "عندك مهام شغالة بالفعل. انتظر اكتمال إحداها ثم اعتمد هذه؛ خطتك محفوظة ولم يُخصم شيء.",
  quote_expired: "انتهت صلاحية السعر المعروض، ولم يُخصم أي رصيد. اضغط «اعتمد» مجددًا لتحديث السعر وتأكيد البدء.",
  plan_changed: "تغيّر سعر الخطة في النظام، ولم يُخصم شيء من رصيدك. أعد إرسال الطلب ليُحسب لك بالسعر المحدّث.",
  quote_failed: "المهمة أكبر من الحد المسموح للحجز الواحد. قلّل العدد المطلوب ثم أعد الطلب؛ لم يُخصم شيء.",
  accept_failed: "تعذّر حجز الرصيد الآن؛ حاول بعد قليل ولم يُخصم شيء.",
};

/**
 * Approve. A guest is told to sign up first, an unverified account to verify its e-mail. `precheck` is the route's own gate (provider gate, busy state, concurrency): it runs before anything is reserved.
 * The reserve itself is the shared approval path (the existing money functions); on success the customer is told once that the page may be closed.
 */
const NOT_A_MISSION_AR = "هذا طلب على ملف سُلّم من قبل، وليس طلب بيانات جديدًا؛ لا يُعتمد من هنا.";

export async function approveForCustomer(client: any, input: { id: string; userId: string; isGuest: boolean; emailVerified: boolean; approvalVersion?: unknown; precheck?: () => Promise<{ ok: true } | { ok: false; status: number; error: string }>; onApproved?: (r: { jobId: string }) => Promise<void> }): Promise<CustomerResult<{ jobId: string; reservePoints: number }>> {
  if (input.isGuest) return bad(401, SIGNUP_TO_APPROVE_AR);
  if (!input.emailVerified) return bad(403, "فعّل بريدك الإلكتروني أولًا ثم اعتمد المهمة.");
  const { data: mission } = await client.from(MISSION_TABLE).select("id,user_id,status,plan,updated_at,job_id,quote_id")
    .eq("id", input.id).eq("user_id", input.userId).maybeSingle();
  if (!mission || mission.user_id !== input.userId) return bad(404, "المهمة غير موجودة.");
  if (mission.status === "approved" || mission.status === "executing") {
    return bad(409, hasApprovalLink(mission) ? "هذه المهمة معتمدة وتعمل بالفعل." : MISSION_APPROVAL_PENDING_AR);
  }
  if (mission.status !== "plan_ready") return bad(409, "لا توجد خطة جاهزة للاعتماد.");
  // MONEY PR 7d: a review, review-fix or edit request of a DELIVERED file is a row of this table whose plan is `{ addon }`, not a mission plan. It is approved by its own function (a later task), never here: refused BEFORE anything is read or held
  if (hasAddonMarker(mission)) return bad(409, NOT_A_MISSION_AR);
  // PR B: a social plan the compiler did not build is refused BEFORE the reserve (nothing is held, no money function is called)
  if (!modelPlanningForTests() && isStaleSocialPlan(mission.plan)) return bad(410, EXPIRED_SOCIAL_PLAN_AR);
  const snapshot: ApprovalSnapshot = {
    id: mission.id, user_id: mission.user_id, status: mission.status, plan: mission.plan, updated_at: mission.updated_at,
  };
  if (!matchesApprovalVersion(input.approvalVersion, approvalVersionOf(snapshot))) return staleApproval();
  if (input.precheck) {
    const gate = await input.precheck();
    if (!gate.ok) return bad(gate.status, gate.error);
  }
  const price = checkedPrice(snapshot.plan);
  if (!price) return bad(409, APPROVE_MESSAGES.plan_changed);
  if (snapshot.plan.hold_cap_preview || price.overCap || price.reservePoints > effectiveJobPointsCap()) return affordabilityChanged(409);
  const wallet = await readVerifiedWallet(client, input.userId);
  if (!wallet) return affordabilityChanged(409);
  if (wallet.wholePoints < price.reservePoints) return affordabilityChanged(402, APPROVE_MESSAGES.insufficient_balance);
  const r = await approveMissionOnce(client, { id: input.id, actorId: input.userId, expectUserId: input.userId, snapshot, messages: APPROVE_MESSAGES });
  if (!r.ok) {
    if (r.code === "stale_plan") return staleApproval();
    if (r.code === "approval_pending") return { ...bad(r.status, r.error), code: "approval_pending" };
    if (r.code === "insufficient_balance") return affordabilityChanged(402, r.error);
    return bad(r.status, r.error);
  }
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

/**
 * ROUND 57: «اكتب الطلب من جديد» READS the request's words back into the chat box and changes NOTHING: the plan on the card stays until the customer sends the new request (the chat then replaces it, as any new request does).
 * 13 Nov: the button cancelled the plan first, so a customer who opened the box and changed their mind had lost the plan. Read only; the customer's own mission only.
 */
export async function requestTextForCustomer(client: any, input: { id: string; userId: string }): Promise<CustomerResult<{ requestText: string }>> {
  const { data } = await client.from(MISSION_TABLE).select(`id,user_id,request_text,${ADDON_MARKER_COLUMN}`).eq("id", input.id).maybeSingle();
  if (!data || data.user_id !== input.userId || hasAddonMarker(data)) return bad(404, "المهمة غير موجودة.");
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
export async function editPlanForCustomer(client: any, input: { id: string; userId: string; edits: unknown; approvalVersion?: unknown; requireApprovalVersion?: boolean }): Promise<CustomerResult<{ status: string; requestText: string }>> {
  const { data: mission } = await client.from(MISSION_TABLE).select("id,user_id,status,plan,request_text,updated_at").eq("id", input.id).eq("user_id", input.userId).maybeSingle();
  if (!mission || mission.user_id !== input.userId) return bad(404, "المهمة غير موجودة.");
  if (hasAddonMarker(mission)) return bad(409, ADDON_ROW_REFUSAL_AR);
  if (mission.status !== "plan_ready" || !mission.plan) return bad(409, "لا يمكن تعديل الخطة الآن.");
  const version = approvalVersionOf(mission);
  if (input.requireApprovalVersion && !matchesApprovalVersion(input.approvalVersion, version)) return staleApproval();
  const plan = mission.plan as PricedPlan;
  const rows = await readYieldRows(client, input.id, plan);
  const r = applyPlanEdits(plan, input.edits, { yieldRows: (s: PricedStage) => rows.get(s.key) ?? null });
  if (!r.ok) return bad(400, r.errorAr);
  // capability_discovery_v1 plans only: the customer's edit is the one change of the stored parameters allowed before approval; the record of the approved scope follows it (no record: unchanged)
  const edited = resealCapabilitySelection(r.plan);
  const upd = await saveReadyPlan(client, mission, edited);
  if (upd.error) return bad(500, "تعذّر حفظ تعديلك.");
  if (!Array.isArray(upd.data) || upd.data.length !== 1) return staleApproval();
  await client.from(MISSION_EVENTS_TABLE).insert({ mission_id: input.id, kind: "plan", message_ar: "حدّثنا الخطة بحسب تعديلك، والسعر محسوب من جديد.", counts: { stages: edited.stages.length, rows: edited.price.deliveredRows, unit_points_x1000: Math.round(edited.price.unitPricePoints * 1000), reserve_points: edited.price.reservePoints } });
  return { ok: true, status: "plan_ready", requestText: String(mission.request_text ?? "") };
}

function saveReadyPlan(client: any, mission: ApprovalSnapshot, plan: PricedPlan) {
  const previous = Date.parse(mission.updated_at);
  const next = new Date(Number.isFinite(previous) ? Math.max(Date.now(), previous + 1) : Date.now()).toISOString();
  const update = client.from(MISSION_TABLE).update({
    plan, plan_public: publicPlanOf(plan), unit_price_points: plan.price.unitPricePoints,
    reserved_points: plan.price.reservePoints, updated_at: next,
  }).eq("id", mission.id).eq("user_id", mission.user_id).eq("status", "plan_ready");
  return (mission.updated_at == null ? update.is("updated_at", null) : update.eq("updated_at", mission.updated_at)).select("id");
}

function matchesOffer(supplied: unknown, offer: OfferSelection): boolean {
  if (!supplied || typeof supplied !== "object") return false;
  const candidate = supplied as Partial<OfferSelection>;
  return candidate.kind === offer.kind && candidate.count === offer.count && candidate.reservePoints === offer.reservePoints;
}

/** Select the server's current offer for this exact owned plan. Nothing is held here. */
export async function smallerVersionForCustomer(client: any, input: { id: string; userId: string; approvalVersion: unknown; offer: unknown }): Promise<CustomerResult<{ status: string }>> {
  const { data: mission } = await client.from(MISSION_TABLE).select("id,user_id,status,plan,updated_at").eq("id", input.id).eq("user_id", input.userId).maybeSingle();
  if (!mission || mission.user_id !== input.userId) return bad(404, "المهمة غير موجودة.");
  if (hasAddonMarker(mission)) return bad(409, ADDON_ROW_REFUSAL_AR);
  if (mission.status !== "plan_ready" || !mission.plan) return bad(409, "لا يمكن تعديل الخطة الآن.");
  if (!matchesApprovalVersion(input.approvalVersion, approvalVersionOf(mission))) return staleApproval();
  const { view, candidate, limit } = await affordabilityOf(client, input.userId, mission.plan);
  if (!candidate || !view.offer || limit == null) {
    if (input.offer != null || view.mode === "unavailable") return affordabilityChanged(409);
    return bad(400, "لا توجد نسخة أصغر تناسب الحد المسموح أو رصيدك. غيّر طلبك أو ألغِ المهمة؛ ولم يُخصم شيء.");
  }
  if (!matchesOffer(input.offer, view.offer)) return affordabilityChanged(409);
  const { hold_cap_preview: _preview, ...selected } = candidate;
  const next = resealCapabilitySelection(selected);
  const price = checkedPrice(next);
  if (!price || price.overCap || price.reservePoints !== view.offer.reservePoints
    || price.reservePoints > limit
    || (view.offer.kind === "count" && fixedCountBasket(next)?.root.planned_rows !== view.offer.count)) return affordabilityChanged(409);
  const upd = await saveReadyPlan(client, mission, next);
  if (upd.error) return bad(500, "تعذّر حفظ النسخة الأصغر.");
  if (!Array.isArray(upd.data) || upd.data.length !== 1) return staleApproval();
  await client.from(MISSION_EVENTS_TABLE).insert({ mission_id: input.id, kind: "plan", message_ar: "جهّزنا نسخة أصغر من الخطة تناسب الحد المسموح، والسعر محسوب من جديد.", counts: { stages: next.stages.length, rows: next.price.deliveredRows, unit_points_x1000: Math.round(next.price.unitPricePoints * 1000), reserve_points: next.price.reservePoints, ...(view.offer.kind === "per_post" ? { smaller_per_post: view.offer.count } : {}) } });
  return { ok: true, status: "plan_ready" };
}

export async function answerForCustomer(client: any, input: { id: string; userId: string; text: unknown }): Promise<CustomerResult> {
  const text = String(input.text ?? "").replace(/\s+/g, " ").trim();
  if (text.length < 1 || text.length > 1000) return bad(400, "اكتب إجابتك.");
  const { data } = await client.from(MISSION_TABLE).select(`id,user_id,status,request_text,${ADDON_MARKER_COLUMN}`).eq("id", input.id).maybeSingle();
  if (!data || data.user_id !== input.userId) return bad(404, "المهمة غير موجودة.");
  if (hasAddonMarker(data)) return bad(409, ADDON_ROW_REFUSAL_AR);
  if (data.status !== "needs_input") return bad(409, "المهمة لا تنتظر إجابة.");
  // SECURITY: an answer is read WITH the request (the worker reads both as one text), so a request that was allowed alone cannot become a private-conversation or identifier request by its answer. Nothing is written when it is refused.
  const refusal = sensitiveRequestRefusalAr(`${String(data.request_text ?? "")} ${text}`);
  if (refusal) return bad(422, refusal);
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
