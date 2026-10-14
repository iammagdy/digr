import { Client, TablesDB, Storage, Users, Query, Permission, Role, ID } from "../../shared/dbCompat";
import { z } from "zod";
import { EG_MOBILE_RE, isThreePartName, normalizeDigits, normalizePhone, normalizeSenderName, toArabicDigits } from "../../../lib/arabicDigits";
import { notifyUser } from "../../shared/notify";
import { formatArabicDate } from "../../shared/emailTemplates";

const DEFAULT_MAX_PENDING = 3;

// Arabic digits are normalised on the server too: the client is never trusted to have done it.
const submitTopupSchema = z.object({
  amountEgp: z.preprocess(
    (v) => (typeof v === "string" ? Number(normalizeDigits(v)) : v),
    z.number("المبلغ يجب أن يكون أكبر من صفر").positive("المبلغ يجب أن يكون أكبر من صفر"),
  ),
  reference: z.preprocess(
    (v) => (typeof v === "string" ? normalizeDigits(v).trim() : v),
    z.string("رقم العملية مطلوب").min(3, "رقم العملية مطلوب").max(128, "رقم العملية مطلوب"),
  ),
  senderName: z.preprocess(
    (v) => (typeof v === "string" ? normalizeSenderName(v) : v),
    z.string("اكتب اسم المحوِّل الثلاثي كما يظهر في إنستاباي")
      .max(120, "اكتب اسم المحوِّل الثلاثي كما يظهر في إنستاباي")
      .refine(isThreePartName, "اكتب اسم المحوِّل الثلاثي كما يظهر في إنستاباي"),
  ),
  senderPhone: z.preprocess(
    (v) => (typeof v === "string" ? normalizePhone(v) : v),
    z.string("رقم الموبايل غير صحيح — ١١ رقمًا يبدأ بـ 01").regex(EG_MOBILE_RE, "رقم الموبايل غير صحيح — ١١ رقمًا يبدأ بـ 01"),
  ),
  // Required since the V7 redesign: a top-up cannot be reviewed without the transfer receipt.
  receiptFileId: z.string("صورة إيصال التحويل مطلوبة لمراجعة الطلب").min(1, "صورة إيصال التحويل مطلوبة لمراجعة الطلب"),
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
  const storage = new Storage(client);
  const users = new Users(client);

  try {
    const rawBody = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body;
    const validated = submitTopupSchema.parse(rawBody);

    // 1b. Top-ups require a verified email (enforced here, not only in the UI)
    const caller = await users.get({ userId: callerId });
    if (!caller.emailVerification) {
      return res.json({ success: false, error: "يرجى تأكيد بريدك الإلكتروني أولاً قبل شحن الرصيد." }, 403);
    }

    // 2. Cap on pending top-ups per user (settings_public.maxPendingTopups, default 3)
    let maxPending = DEFAULT_MAX_PENDING;
    let creditValueEgp = 0.1;
    try {
      const pub: any = await tables.getRow({ databaseId: "digr", tableId: "settings_public", rowId: "pricing" });
      if (Number.isInteger(pub?.maxPendingTopups) && pub.maxPendingTopups > 0) maxPending = pub.maxPendingTopups;
      if (typeof pub?.creditValueEgp === "number" && pub.creditValueEgp > 0) creditValueEgp = pub.creditValueEgp;
    } catch { /* settings row or column missing: keep the defaults */ }
    const pendingTopups = await tables.listRows({
      databaseId: "digr",
      tableId: "topups",
      queries: [
        Query.equal("userId", callerId),
        Query.equal("status", "pending"),
        Query.limit(5),
      ],
    });

    const pendingCount =
      typeof pendingTopups.total === "number"
        ? pendingTopups.total
        : pendingTopups.rows?.length || 0;

    if (pendingCount >= maxPending) {
      return res.json(
        {
          success: false,
          error: `لديك ${maxPending} طلبات شحن معلقة بالفعل. يرجى انتظار معالجتها قبل تقديم طلب جديد.`,
        },
        400
      );
    }

    // 3. Unique reference check
    const existingRef = await tables.listRows({
      databaseId: "digr",
      tableId: "topups",
      queries: [
        Query.equal("reference", validated.reference),
        Query.limit(1),
      ],
    });

    const refCount =
      typeof existingRef.total === "number"
        ? existingRef.total
        : existingRef.rows?.length || 0;

    if (refCount > 0) {
      return res.json(
        {
          success: false,
          error: "رقم العملية مستخدم مسبقاً في طلب آخر.",
        },
        400
      );
    }

    // 4. Receipt verification (never trust client-supplied receiptFileId). The receipt is mandatory.
    {
      // 4a. Fetch file with server/dynamic key
      let file: any;
      try {
        file = await storage.getFile("receipts", validated.receiptFileId);
      } catch (fileErr: any) {
        return res.json({ success: false, error: "ملف الإيصال غير موجود." }, 400);
      }

      // 4b. Verify file was uploaded by the caller (permissions contain user:<callerId>)
      const filePerms: string[] = file.$permissions || file.permissions || [];
      const isOwner = filePerms.some((p: string) => p.includes(`user:${callerId}`));

      if (!isOwner) {
        log(`Security Alert: Caller ${callerId} attempted to submit unowned receipt ${validated.receiptFileId}`);
        return res.json(
          {
            success: false,
            error: "ملف الإيصال المحدد غير مملوك للمستخدم الحالي.",
          },
          403
        );
      }

      // 4c. Verify no other top-up already references this receipt
      const existingReceipt = await tables.listRows({
        databaseId: "digr",
        tableId: "topups",
        queries: [
          Query.equal("receiptFileId", validated.receiptFileId),
          Query.limit(1),
        ],
      });

      const receiptCount =
        typeof existingReceipt.total === "number"
          ? existingReceipt.total
          : existingReceipt.rows?.length || 0;

      if (receiptCount > 0) {
        return res.json(
          {
            success: false,
            error: "تم استخدام هذا الإيصال مسبقاً في طلب شحن آخر.",
          },
          400
        );
      }

      // 4d. ONLY after all validations pass, set final permissions: owner read + admin-label read
      await storage.updateFile({
        bucketId: "receipts",
        fileId: validated.receiptFileId,
        permissions: [
          Permission.read(Role.user(callerId)),
          Permission.read(Role.label("admin")),
        ],
      });
      log(`✓ Updated receipt ${validated.receiptFileId} permissions to owner (${callerId}) + admin`);
    }

    // 5. Create topup row forcing userId = caller and status = pending
    const topupId = ID.unique();
    log(`Creating topup ${topupId} for caller ${callerId}`);

    const row = await tables.createRow({
      databaseId: "digr",
      tableId: "topups",
      rowId: topupId,
      data: {
        userId: callerId,
        amountEgp: validated.amountEgp,
        reference: validated.reference,
        senderName: validated.senderName,
        senderPhone: validated.senderPhone,
        receiptFileId: validated.receiptFileId,
        status: "pending",
        createdAt: new Date().toISOString(),
      },
      permissions: [
        Permission.read(Role.user(callerId)),
        Permission.read(Role.label("admin")),
      ],
    });

    // 6. Notify the user (in-app + branded topup-received email). Never blocks the submission:
    // notifyUser swallows its own failures, and the row above is already created.
    await notifyUser(client, {
      userId: callerId,
      kind: "topup_received",
      title: "تم استلام طلب الشحن",
      body: `طلب شحن بقيمة ${toArabicDigits(validated.amountEgp)} ج.م — قيد المراجعة.`,
      link: "/dashboard/topup",
      emailVars: {
        AmountEgp: toArabicDigits(validated.amountEgp),
        CreatedAt: formatArabicDate(new Date().toISOString()),
        Credits: toArabicDigits(Math.floor(validated.amountEgp / creditValueEgp)),
        Reference: validated.reference,
      },
    }, log);

    return res.json({
      success: true,
      topupId: row.$id,
      message: "تم استلام طلب الشحن بنجاح وهو قيد المراجعة",
    });
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.json({ success: false, error: err.issues[0]?.message || "بيانات غير صالحة" }, 400);
    }
    if (err.code === 409) {
      return res.json({ success: false, error: "رقم العملية أو الإيصال مستخدم مسبقاً." }, 400);
    }
    error(`Submit topup failed: ${err.message}`);
    return res.json({ success: false, error: "حدث خطأ أثناء إرسال طلب الشحن" }, 500);
  }
};
