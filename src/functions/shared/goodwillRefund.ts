import { createHash } from "crypto";
import { Permission, Query, Role, TablesDB } from "node-appwrite";
import type { RunFacts } from "./resultReview";
import { createGoodwillAdjustment } from "./ledger";

export interface GoodwillPolicy {
  autoRefundMaxPoints: number;
  monthlyRefundCountCap: number;
  monthlyRefundPointsCap: number;
}

export interface GoodwillDecision {
  eligible: boolean;
  points: number;
  reasonCode: string | null;
  reasonAr: string | null;
}

const DEFAULT_POLICY: GoodwillPolicy = {
  autoRefundMaxPoints: 100,
  monthlyRefundCountCap: 3,
  monthlyRefundPointsCap: 300,
};

const REFUNDABLE_CRITICAL_CODES = new Set(["empty_result", "replies_sparse", "critical_period_coverage"]);

function safeInt(value: unknown, fallback: number, max: number): number {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(max, Math.floor(parsed))) : fallback;
}

export function parseGoodwillPolicy(settings: unknown): GoodwillPolicy {
  const row = settings && typeof settings === "object" ? settings as Record<string, unknown> : {};
  return {
    autoRefundMaxPoints: safeInt(row.autoRefundMaxPoints, DEFAULT_POLICY.autoRefundMaxPoints, 1000),
    monthlyRefundCountCap: safeInt(row.autoRefundMonthlyCountCap, DEFAULT_POLICY.monthlyRefundCountCap, 10),
    monthlyRefundPointsCap: safeInt(row.autoRefundMonthlyPointsCap, DEFAULT_POLICY.monthlyRefundPointsCap, 3000),
  };
}

export function decideGoodwillRefund(facts: Pick<RunFacts, "findings" | "severity" | "requested" | "delivered">, chargedPoints: number, policy: GoodwillPolicy): GoodwillDecision {
  const charge = Math.max(0, Math.floor(Number(chargedPoints) || 0));
  if (charge < 1 || policy.autoRefundMaxPoints < 1 || policy.monthlyRefundCountCap < 1 || policy.monthlyRefundPointsCap < 1) {
    return { eligible: false, points: 0, reasonCode: null, reasonAr: null };
  }
  const requestedMinimum = Math.max(0, Math.floor(Number(facts.requested.min) || 0));
  const delivered = Math.max(0, Math.floor(Number(facts.delivered) || 0));
  if (requestedMinimum > delivered) return { eligible: false, points: 0, reasonCode: null, reasonAr: null };
  const finding = facts.findings.find((item) => item.severity === "critical" && REFUNDABLE_CRITICAL_CODES.has(item.code));
  if (!finding) return { eligible: false, points: 0, reasonCode: null, reasonAr: null };
  // Divide the monthly budget into atomic per-refund slots, so concurrent workers cannot exceed it.
  const perSlotCap = Math.floor(policy.monthlyRefundPointsCap / policy.monthlyRefundCountCap);
  const points = Math.min(charge, policy.autoRefundMaxPoints, perSlotCap);
  if (points < 1) return { eligible: false, points: 0, reasonCode: null, reasonAr: null };
  const reasonAr = String(finding.textAr || "ظهور مؤشر نتيجة جوهري").replace(/<[^>]*>/g, " ").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 400);
  return { eligible: true, points, reasonCode: finding.code, reasonAr };
}

export interface UserComplaintInput {
  userId: string;
  jobId: string;
  conversationId?: string;
  category: "data_type" | "period" | "count" | "quality" | "other";
  details?: string;
}

function compactHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 20);
}

function monthlyKey(date = new Date()): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function appwriteCode(error: any): number | undefined {
  return Number(error?.code ?? error?.status) || undefined;
}

async function readRefundRow(tables: TablesDB, jobId: string): Promise<any | null> {
  try { return await tables.getRow({ databaseId: "digr", tableId: "credit_ledger", rowId: `gwl_${jobId}` }); }
  catch (error: any) { if (appwriteCode(error) === 404) return null; throw error; }
}

async function ensureRefundNotice(tables: TablesDB, userId: string, jobId: string, points: number, reasonAr: string): Promise<void> {
  const rowId = `ntf_${compactHash(`refund|${jobId}`)}`;
  const bodyAr = `تم رد ${points.toLocaleString("ar-EG")} نقطة لأن النتيجة أظهرت: ${reasonAr}`.slice(0, 2000);
  try {
    await tables.createRow({
      databaseId: "digr", tableId: "notifications", rowId,
      data: { userId, jobId, kind: "auto_refund", status: "unread", titleAr: `تم رد ${points.toLocaleString("ar-EG")} نقطة`, bodyAr, delta: points, reasonCode: "objective_critical_finding", createdAt: new Date().toISOString() },
      permissions: [Permission.read(Role.user(userId)), Permission.read(Role.label("admin"))],
    });
  } catch (error: any) {
    if (appwriteCode(error) !== 409) console.warn("[goodwill:NOTICE_UNAVAILABLE]");
  }
}

async function enqueueSystemReview(tables: TablesDB, input: { userId: string; jobId: string; conversationId?: string; facts: RunFacts }): Promise<void> {
  const relevant = input.facts.findings.filter((finding) => finding.severity === "warning" || finding.severity === "critical").slice(0, 10);
  if (!relevant.length) return;
  const rowId = `rev_${compactHash(`system|${input.jobId}`)}`;
  try {
    await tables.createRow({
      databaseId: "digr", tableId: "notifications", rowId,
      data: {
        userId: input.userId, jobId: input.jobId, ...(input.conversationId ? { conversationId: input.conversationId } : {}),
        kind: "review_queue", status: "pending", titleAr: "نتيجة تحتاج مراجعة",
        bodyAr: relevant.map((item) => item.textAr).join(" ").slice(0, 2000),
        reasonCode: relevant.map((item) => item.code).join(",").slice(0, 120),
        createdAt: new Date().toISOString(),
      },
    });
  } catch (error: any) {
    if (appwriteCode(error) !== 409) console.warn("[goodwill:REVIEW_QUEUE_UNAVAILABLE]");
  }
}

async function getMonthlySlots(tables: TablesDB, userId: string, monthKey: string): Promise<any[]> {
  const rows: any[] = [];
  let offset = 0;
  const limit = 100;
  while (true) {
    const page = await tables.listRows({
      databaseId: "digr", tableId: "notifications",
      queries: [Query.equal("userId", userId), Query.equal("kind", "refund_slot"), Query.equal("monthKey", monthKey), Query.limit(limit), Query.offset(offset)],
    });
    rows.push(...page.rows);
    if (page.rows.length < limit) break;
    offset += limit;
    if (offset >= 5000) break;
  }
  return rows;
}

async function claimRefundSlot(tables: TablesDB, input: { userId: string; jobId: string; monthKey: string; policy: GoodwillPolicy; maxPoints: number }): Promise<{ row: any; points: number } | null> {
  for (let attempt = 0; attempt <= input.policy.monthlyRefundCountCap; attempt += 1) {
    const existing = await getMonthlySlots(tables, input.userId, input.monthKey);
    const sameJob = existing.find((row) => row.jobId === input.jobId);
    if (sameJob) {
      if (Number(sameJob.delta) < 1) return null;
      return { row: sameJob, points: Math.min(input.maxPoints, Math.floor(Number(sameJob.delta))) };
    }
    const bySlot = new Map<number, any>();
    for (const row of existing) {
      const slot = Number(row.slotNumber);
      if (Number.isInteger(slot) && slot > 0 && !bySlot.has(slot)) bySlot.set(slot, row);
    }
    const usedPoints = existing.reduce((sum, row) => sum + Math.max(0, Math.floor(Number(row.delta) || 0)), 0);
    const freeSlots = Array.from({ length: input.policy.monthlyRefundCountCap }, (_, index) => index + 1).filter((slot) => !bySlot.has(slot));
    if (!freeSlots.length || usedPoints >= input.policy.monthlyRefundPointsCap) return null;
    const perRemainingSlot = Math.floor((input.policy.monthlyRefundPointsCap - usedPoints) / freeSlots.length);
    const points = Math.min(input.maxPoints, perRemainingSlot);
    if (points < 1) return null;

    const slotNumber = freeSlots[0];
    const rowId = `gws_${compactHash(`${input.userId}|${input.monthKey}`)}_${slotNumber}`;
    try {
      const row = await tables.createRow({
        databaseId: "digr", tableId: "notifications", rowId,
        data: { userId: input.userId, jobId: input.jobId, kind: "refund_slot", status: "reserved", monthKey: input.monthKey, slotNumber, delta: points, createdAt: new Date().toISOString() },
      });
      return { row, points };
    } catch (error: any) {
      if (appwriteCode(error) !== 409) throw error;
      try {
        const row: any = await tables.getRow({ databaseId: "digr", tableId: "notifications", rowId });
        if (row.jobId === input.jobId) return { row, points: Math.min(input.maxPoints, Math.floor(Number(row.delta) || 0)) };
      } catch { /* another slot/state may have won; recalculate on the next bounded attempt */ }
    }
  }
  return null;
}

export async function applyGoodwillOutcome(
  tables: TablesDB,
  input: { userId: string; jobId: string; conversationId?: string; chargedPoints: number; facts: RunFacts }
): Promise<{ status: "disabled" | "no_refund" | "refunded" | "already_refunded" | "unavailable"; points: number; reasonAr?: string }> {
  if (process.env.GOODWILL_ENABLED !== "true") return { status: "disabled", points: 0 };
  const warningOrCritical = input.facts.findings.some((finding) => finding.severity === "warning" || finding.severity === "critical");
  if (warningOrCritical) await enqueueSystemReview(tables, { ...input, facts: input.facts });
  const existingRefund = await readRefundRow(tables, input.jobId).catch(() => null);
  if (existingRefund && existingRefund.userId === input.userId && existingRefund.jobId === input.jobId && existingRefund.type === "adjust" && Number(existingRefund.delta) > 0 && Number(existingRefund.delta) <= Math.max(0, input.chargedPoints)) {
    const reasonAr = typeof existingRefund.note === "string" ? existingRefund.note.replace(/^رد حسن نية:\s*/, "").slice(0, 400) : "مؤشر نتيجة جوهري";
    await ensureRefundNotice(tables, input.userId, input.jobId, Number(existingRefund.delta), reasonAr || "مؤشر نتيجة جوهري");
    return { status: "already_refunded", points: Number(existingRefund.delta), reasonAr: reasonAr || undefined };
  }

  if (!input.facts.findings.some((finding) => finding.severity === "critical" && REFUNDABLE_CRITICAL_CODES.has(finding.code))) {
    return { status: "no_refund", points: 0 };
  }

  let settings: any = {};
  try { settings = await tables.getRow({ databaseId: "digr", tableId: "settings", rowId: "pricing" }); }
  catch { console.warn("[goodwill:SETTINGS_DEFAULTS]"); }
  const policy = parseGoodwillPolicy(settings);
  const decision = decideGoodwillRefund(input.facts, input.chargedPoints, policy);
  if (!decision.eligible) return { status: "no_refund", points: 0 };

  const monthKey = monthlyKey();
  let slot: { row: any; points: number } | null;
  try {
    slot = await claimRefundSlot(tables, {
      userId: input.userId, jobId: input.jobId, monthKey, policy, maxPoints: Math.min(decision.points, input.chargedPoints),
    });
  } catch {
    console.warn("[goodwill:STORAGE_UNAVAILABLE]");
    return { status: "unavailable", points: 0 };
  }
  if (!slot || slot.points < 1) return { status: "no_refund", points: 0 };

  try {
    const adjustment = await createGoodwillAdjustment(tables, input.userId, input.jobId, slot.points, input.chargedPoints, decision.reasonAr || "مؤشر نتيجة جوهري");
    try {
      await tables.updateRow({ databaseId: "digr", tableId: "notifications", rowId: slot.row.$id, data: { status: "applied", delta: adjustment.points } });
    } catch { console.warn("[goodwill:SLOT_STATUS_UNAVAILABLE]"); }
    await ensureRefundNotice(tables, input.userId, input.jobId, adjustment.points, decision.reasonAr || "مؤشر نتيجة جوهري");
    return { status: adjustment.created ? "refunded" : "already_refunded", points: adjustment.points, reasonAr: decision.reasonAr || undefined };
  } catch {
    console.warn("[goodwill:LEDGER_WRITE_FAILED]");
    return { status: "unavailable", points: 0 };
  }
}

export function sanitizeComplaintDetails(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/<[^>]*>/g, " ").replace(/https?:\/\/\S+/gi, " ").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
}

export async function saveCustomerComplaint(tables: TablesDB, input: UserComplaintInput): Promise<void> {
  const rowId = `rev_${compactHash(`customer|${input.jobId}|${input.userId}`)}`;
  const details = sanitizeComplaintDetails(input.details);
  const categoryLabels: Record<UserComplaintInput["category"], string> = {
    data_type: "نوع البيانات", period: "الفترة", count: "العدد", quality: "الجودة", other: "أخرى",
  };
  try {
    await tables.createRow({
      databaseId: "digr", tableId: "notifications", rowId,
      data: {
        userId: input.userId, jobId: input.jobId, ...(input.conversationId ? { conversationId: input.conversationId } : {}),
        kind: "review_queue", status: "pending", titleAr: "ملاحظة من المستخدم",
        bodyAr: `نوع الملاحظة: ${categoryLabels[input.category]}.${details ? ` التفاصيل: ${details}` : ""}`.slice(0, 2000),
        customerCategory: input.category, customerDetails: details, reasonCode: "customer_feedback", createdAt: new Date().toISOString(),
      },
    });
  } catch (error: any) {
    if (appwriteCode(error) !== 409) throw error;
  }

  const noticeId = `ntf_${compactHash(`complaint|${input.jobId}|${input.userId}`)}`;
  try {
    await tables.createRow({
      databaseId: "digr", tableId: "notifications", rowId: noticeId,
      data: { userId: input.userId, jobId: input.jobId, kind: "customer_notice", status: "unread", titleAr: "تم استلام ملاحظتك", bodyAr: "استلمنا ملاحظتك وهنراجعها.", createdAt: new Date().toISOString() },
      permissions: [Permission.read(Role.user(input.userId)), Permission.read(Role.label("admin"))],
    });
  } catch (error: any) {
    if (appwriteCode(error) !== 409) throw error;
  }
}
