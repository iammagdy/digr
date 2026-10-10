import { Client, TablesDB, Storage, Query, Permission, Role, ID } from "node-appwrite";
import { z } from "zod";

const submitTopupSchema = z.object({
  amountEgp: z.number().positive("المبلغ يجب أن يكون أكبر من صفر"),
  reference: z.string().min(3, "رقم العملية مطلوب"),
  receiptFileId: z.string().optional(),
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

  try {
    const rawBody = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body;
    const validated = submitTopupSchema.parse(rawBody);

    // 2. Cap on pending top-ups per user (max 3)
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

    if (pendingCount >= 3) {
      return res.json(
        {
          success: false,
          error: "لديك 3 طلبات شحن معلقة بالفعل. يرجى انتظار معالجتها قبل تقديم طلب جديد.",
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

    // 4. Receipt verification (never trust client-supplied receiptFileId)
    if (validated.receiptFileId) {
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
        receiptFileId: validated.receiptFileId || null,
        status: "pending",
        createdAt: new Date().toISOString(),
      },
      permissions: [
        Permission.read(Role.user(callerId)),
        Permission.read(Role.label("admin")),
      ],
    });

    return res.json({
      success: true,
      topupId: row.$id,
      message: "تم استلام طلب الشحن بنجاح وهو قيد المراجعة",
    });
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.json({ success: false, error: err.errors[0]?.message || "بيانات غير صالحة" }, 400);
    }
    if (err.code === 409) {
      return res.json({ success: false, error: "رقم العملية أو الإيصال مستخدم مسبقاً." }, 400);
    }
    error(`Submit topup failed: ${err.message}`);
    return res.json({ success: false, error: "حدث خطأ أثناء إرسال طلب الشحن" }, 500);
  }
};
