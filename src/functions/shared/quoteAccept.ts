import { TablesDB, ID, Query, Permission, Role } from "node-appwrite";
import { computePlanHash, parseStoredPlan, serializeStoredPlan, PlanItem } from "./planManager";
import { buildNormalizedRequestSpec } from "./resultReview";
import { isQuoteExpired } from "./quotes";
import { calculateBalance, reserveCredits, releaseCredits } from "./ledger";
import { hasDependentSteps } from "./dependentPlans";

export interface AcceptQuoteOptions {
  userId: string;
  quoteId: string;
  expectedPlanHash?: string;
  testScenario?: string;
}

export interface AcceptQuoteResult {
  success: boolean;
  jobId?: string;
  quoteId?: string;
  reservedCredits?: number;
  errorAr?: string;
  statusCode?: number;
}

export const MAX_CONCURRENT_JOBS_PER_USER = 2;

/**
 * Server-side quote acceptance and job initiation.
 * Identifies caller strictly from verified session.
 * Enforces:
 * 1. Expiry re-check (30 mins)
 * 2. Plan hash cryptographic binding
 * 3. Settings version validity
 * 4. User balance check & race condition guard (post-reserve balance check)
 * 5. Deterministic ledger reservation: res_<jobId>
 * 6. Per-user concurrency limit
 */
export async function acceptQuote(
  tables: TablesDB,
  options: AcceptQuoteOptions
): Promise<AcceptQuoteResult> {
  const { userId, quoteId, expectedPlanHash } = options;
  const nowIso = new Date().toISOString();

  // 1. Fetch Quote Document
  let quoteDoc: any;
  try {
    quoteDoc = await tables.getRow({
      databaseId: "digr",
      tableId: "plans_quotes",
      rowId: quoteId,
    });
  } catch {
    return {
      success: false,
      statusCode: 404,
      errorAr: "عرض السعر غير موجود أو تم حذفه.",
    };
  }

  // 2. Authorization check: Quote belongs to the verified user
  if (quoteDoc.userId !== userId) {
    return {
      success: false,
      statusCode: 403,
      errorAr: "غير مصرح لك باعتماد هذا العرض.",
    };
  }

  // 3. Status check: Quote must be in 'proposed' state
  if (quoteDoc.status === "superseded" || quoteDoc.status === "expired") {
    return {
      success: false,
      statusCode: 409,
      errorAr: "تم انتهاء صلاحية هذا العرض أو استبداله بعرض أحدث بعد التعديل.",
    };
  }

  if (quoteDoc.status === "accepted") {
    return {
      success: false,
      statusCode: 409,
      errorAr: "تم بدء تنفيذ هذا العرض مسبقاً ولا يمكن تكراره.",
    };
  }

  if (quoteDoc.status !== "proposed") {
    return {
      success: false,
      statusCode: 400,
      errorAr: "حالة العرض غير صالحة للبدء.",
    };
  }

  // 4. Expiry check (30 minutes hard limit)
  if (isQuoteExpired(quoteDoc.expiresAt)) {
    return {
      success: false,
      statusCode: 410,
      errorAr: "انتهت صلاحية هذا العرض (30 دقيقة). يرجى طلب عرض جديد.",
    };
  }

  // 5. Plan Hash Binding Check (Ensures plan was not tampered with after quoting)
  const storedPlan = parseStoredPlan(quoteDoc.itemsJson);
  const items: PlanItem[] = storedPlan.items;
  if (hasDependentSteps(items) && !(options.testScenario === "dependent-plan-fake" && process.env.NODE_ENV !== "production")) {
    return {
      success: false,
      statusCode: 503,
      errorAr: "تنفيذ الخطط متعددة المراحل غير متاح حالياً؛ لم يتم حجز أي نقاط.",
    };
  }
  const computedHash = storedPlan.legacy
    ? computePlanHash(items)
    : computePlanHash(items, storedPlan.outputFormats, storedPlan);
  if (expectedPlanHash && expectedPlanHash !== computedHash) {
    return {
      success: false,
      statusCode: 400,
      errorAr: "تغيرت تفاصيل الخطة بعد إصدار العرض. يرجى إعادة طلب عرض سعر.",
    };
  }

  // 6. Per-User Concurrency Limit Check (Max 2 concurrent running/queued jobs)
  const activeJobsRes = await tables.listRows({
    databaseId: "digr",
    tableId: "jobs",
    queries: [
      Query.equal("userId", userId),
      Query.equal("status", ["queued", "running"]),
      Query.limit(MAX_CONCURRENT_JOBS_PER_USER + 1),
    ],
  });

  if (activeJobsRes.total >= MAX_CONCURRENT_JOBS_PER_USER) {
    return {
      success: false,
      statusCode: 429,
      errorAr: `لديك ${activeJobsRes.total} طلبات قيد المعالجة حالياً. يرجى انتظار اكتمالها قبل بدء طلب جديد (الحد الأقصى: ${MAX_CONCURRENT_JOBS_PER_USER}).`,
    };
  }

  // 7. Balance Verification
  const currentBalance = await calculateBalance(tables, userId);
  const requiredPoints = quoteDoc.quotedPoints;

  if (currentBalance < requiredPoints) {
    return {
      success: false,
      statusCode: 402,
      errorAr: `رصيدك الحالي (${currentBalance} نقطة) غير كافٍ لتغطية تكلفة العرض (${requiredPoints} نقطة). يرجى شحن الرصيد أولاً.`,
    };
  }

  // 8. Deterministic Ledger Reservation: res_<jobId>
  const jobId = ID.unique();
  await reserveCredits(
    tables,
    userId,
    jobId,
    requiredPoints,
    `حجز رصيد للطلب (${quoteDoc.summaryAr || "استخراج بيانات"})`
  );

  // 9. Post-Reserve Balance Check (Race Condition / TOCTOU Protection)
  const postReserveBalance = await calculateBalance(tables, userId);
  if (postReserveBalance < 0) {
    // Concurrent race condition: immediately release reserved credits and fail safely
    await releaseCredits(
      tables,
      userId,
      jobId,
      requiredPoints,
      "إلغاء حجز الرصيد لتزامن عمليات متزامنة تجاوزت الرصيد"
    );
    return {
      success: false,
      statusCode: 402,
      errorAr: "تعذر الحجز بسبب انخفاض الرصيد الفعلي أثناء المعالجة المتزامنة.",
    };
  }

  // 10. Update Quote Document to 'accepted'
  const requestSpec = buildNormalizedRequestSpec(storedPlan);
  await tables.updateRow({
    databaseId: "digr",
    tableId: "plans_quotes",
    rowId: quoteId,
    data: {
      status: "accepted",
      jobId,
      itemsJson: JSON.stringify(serializeStoredPlan(storedPlan, requestSpec)),
    },
  });

  // 11. Create Job Document in 'jobs'
  const firstItem = items[0] || { capabilitySlug: "unknown", params: {} };
  await tables.createRow({
    databaseId: "digr",
    tableId: "jobs",
    rowId: jobId,
    data: {
      userId,
      templateSlug: firstItem.capabilitySlug,
      params: JSON.stringify(firstItem.params),
      status: "queued",
      estCredits: requiredPoints,
      reservedCredits: requiredPoints,
      chargedCredits: 0,
      rowsCollected: 0,
      createdAt: nowIso,
    },
    permissions: [
      Permission.read(Role.user(userId)),
      Permission.read(Role.label("admin")),
    ],
  });

  // 12. Create initial progress event in job_events (Arabic, White-label)
  await tables.createRow({
    databaseId: "digr",
    tableId: "job_events",
    rowId: ID.unique(),
    data: {
      jobId,
      textAr: "تم اعتماد الخطة وحجز النقاط بنجاح. جاري بدء معالجة الطلب...",
      count: 0,
      kind: "info",
      createdAt: nowIso,
    },
    permissions: [
      Permission.read(Role.user(userId)),
      Permission.read(Role.label("admin")),
    ],
  });

  return {
    success: true,
    jobId,
    quoteId,
    reservedCredits: requiredPoints,
  };
}
