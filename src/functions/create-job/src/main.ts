import { Client, TablesDB, Functions, Query, Permission, Role, ID } from "node-appwrite";
import { z } from "zod";
import {
  reserveCredits,
  releaseCredits,
  calculateBalance,
} from "../../shared/ledger";

const createJobSchema = z.object({
  templateSlug: z.string().min(1, "معرّف القالب مطلوب"),
  params: z.record(z.any()).default({}),
});

export default async ({ req, res, log, error }: any) => {
  // 1. Identify caller strictly from header
  const callerId = req.headers?.["x-appwrite-user-id"];
  if (!callerId) {
    return res.json({ success: false, error: "غير مصرح — يرجى تسجيل الدخول أولاً" }, 401);
  }

  const apiKey =
    req.headers?.["x-appwrite-key"] ||
    process.env.APPWRITE_FUNCTION_API_KEY ||
    process.env.APPWRITE_API_KEY;

  const client = new Client()
    .setEndpoint(process.env.APPWRITE_FUNCTION_API_ENDPOINT || process.env.NEXT_PUBLIC_APPWRITE_ENDPOINT!)
    .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID || process.env.NEXT_PUBLIC_APPWRITE_PROJECT_ID!)
    .setKey(apiKey);

  const tables = new TablesDB(client);
  const functions = new Functions(client);

  try {
    const rawBody = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body;
    const validated = createJobSchema.parse(rawBody);

    // 2. Active jobs rate limit: max 5 active (queued or running) jobs per user
    const activeJobs = await tables.listRows({
      databaseId: "digr",
      tableId: "jobs",
      queries: [
        Query.equal("userId", callerId),
        Query.equal("status", ["queued", "running"]),
        Query.limit(10),
      ],
    });

    const activeCount =
      typeof activeJobs.total === "number"
        ? activeJobs.total
        : activeJobs.rows?.length || 0;

    if (activeCount >= 5) {
      return res.json(
        {
          success: false,
          error: "لديك 5 طلبات قيد المعالجة بالفعل. يرجى انتظار اكتمالها قبل إنشاء طلب جديد.",
        },
        429
      );
    }

    // 3. Lookup template and verify pricing
    let template: any;
    try {
      template = await tables.getRow({
        databaseId: "digr",
        tableId: "templates",
        rowId: validated.templateSlug,
      });
    } catch {
      return res.json({ success: false, error: "قالب البيانات غير موجود." }, 404);
    }

    if (!template.enabled) {
      return res.json({ success: false, error: "هذا القالب غير متاح حاليًا." }, 400);
    }

    // Validate parameters against paramsSchema if provided
    if (template.paramsSchema) {
      try {
        const schemaObj = typeof template.paramsSchema === "string"
          ? JSON.parse(template.paramsSchema)
          : template.paramsSchema;
        if (schemaObj.required && Array.isArray(schemaObj.required)) {
          for (const reqField of schemaObj.required) {
            if (!validated.params[reqField]) {
              return res.json(
                { success: false, error: `الحقل المطلوب '${reqField}' مفقود في المدخلات.` },
                400
              );
            }
          }
        }
      } catch (schemaErr: any) {
        log(`Schema validation note: ${schemaErr.message}`);
      }
    }

    const priceCreditsPerUnit = template.priceCreditsPerUnit || 1;
    const requestedUnits = 1; // single-call templates
    const reservedCredits = priceCreditsPerUnit * requestedUnits;

    // 4. Reserve first (deterministic ID: res_<jobId>)
    const jobId = ID.unique();
    log(`[create-job] Reserving ${reservedCredits} credits for job ${jobId} (caller: ${callerId})`);

    await reserveCredits(tables, callerId, jobId, reservedCredits, `حجز رصيد للطلب: ${template.nameAr}`);

    // 5. Paginated balance check across all pages
    const balanceAfterReserve = await calculateBalance(tables, callerId);
    log(`[create-job] Caller ${callerId} balance after reserve: ${balanceAfterReserve}`);

    if (balanceAfterReserve < 0) {
      // Immediately issue compensating release rel_<jobId> and reject
      log(`[create-job] Insufficient balance (${balanceAfterReserve} < 0). Issuing compensating release rel_${jobId}...`);
      await releaseCredits(tables, callerId, jobId, reservedCredits, "إلغاء حجز الرصيد لعدم كفاية الرصيد");

      return res.json(
        {
          success: false,
          error: "رصيدك غير كافٍ لإتمام هذا الطلب. يرجى شحن رصيدك والمحاولة مرة أخرى.",
        },
        400
      );
    }

    // 6. Create Job document (Status: queued) with document security
    const now = new Date().toISOString();
    const jobDoc = await tables.createRow({
      databaseId: "digr",
      tableId: "jobs",
      rowId: jobId,
      data: {
        userId: callerId,
        templateSlug: validated.templateSlug,
        params: JSON.stringify(validated.params),
        status: "queued",
        estCredits: reservedCredits,
        reservedCredits: reservedCredits,
        createdAt: now,
      },
      permissions: [
        Permission.read(Role.user(callerId)),
        Permission.read(Role.label("admin")),
      ],
    });

    // 7. Create initial job event
    await tables.createRow({
      databaseId: "digr",
      tableId: "job_events",
      rowId: ID.unique(),
      data: {
        jobId,
        textAr: "تم إنشاء الطلب وحجز الرصيد بنجاح",
        count: 0,
        kind: "info",
        createdAt: now,
      },
      permissions: [
        Permission.read(Role.user(callerId)),
        Permission.read(Role.label("admin")),
      ],
    });

    // 8. Trigger async job-worker execution
    try {
      await functions.createExecution(
        "job-worker",
        JSON.stringify({
          jobId,
        }),
        true // async
      );
      log(`[create-job] Dispatched async job-worker for job ${jobId}`);
    } catch (dispatchErr: any) {
      error(`[create-job] Could not dispatch worker: ${dispatchErr.message}`);
    }

    return res.json(
      {
        success: true,
        jobId,
        templateSlug: validated.templateSlug,
        reservedCredits,
        status: "queued",
        createdAt: now,
      },
      200
    );
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.json({ success: false, error: err.errors[0]?.message || "مدخلات غير صالحة" }, 400);
    }
    error(`[create-job] Failed: ${err.message}`);
    return res.json({ success: false, error: "حدث خطأ غير متوقع أثناء إنشاء الطلب" }, 500);
  }
};
