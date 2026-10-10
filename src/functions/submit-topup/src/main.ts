import { Client, TablesDB, Storage, Permission, Role, ID } from "node-appwrite";
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

    const topupId = ID.unique();
    log(`Submitting topup ${topupId} for caller ${callerId}`);

    // If receipt file was uploaded, enforce owner + admin read permissions
    if (validated.receiptFileId) {
      try {
        await storage.updateFile({
          bucketId: "receipts",
          fileId: validated.receiptFileId,
          permissions: [
            Permission.read(Role.user(callerId)),
            Permission.read(Role.label("admin")),
          ],
        });
        log(`✓ Updated receipt ${validated.receiptFileId} permissions to owner + admin`);
      } catch (fileErr: any) {
        log(`Warning: Could not update receipt file permissions: ${fileErr.message}`);
      }
    }

    // Create row forcing userId = caller and status = pending
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
    error(`Submit topup failed: ${err.message}`);
    return res.json({ success: false, error: "حدث خطأ أثناء إرسال طلب الشحن" }, 500);
  }
};
