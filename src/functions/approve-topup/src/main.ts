import { Client, TablesDB, Users } from "../../shared/dbCompat";
import { applyTopup } from "../../shared/ledger";
import { notifyUser } from "../../shared/notify";
import { writeAudit } from "../../shared/auditLog";
import { normalizeDigits, toArabicDigits } from "../../../lib/arabicDigits";
import { z } from "zod";

// Rejection requires a reason: it is shown to the user and emailed.
const approveSchema = z.object({
  topupId: z.string().min(1),
  action: z.enum(["approve", "reject"]),
  confirmedAmountEgp: z.preprocess(
    (v) => (typeof v === "string" ? Number(normalizeDigits(v)) : v),
    z.number().positive().optional(),
  ),
  rejectReason: z.string().trim().min(3, "سبب الرفض مطلوب").max(256).optional(),
});

export default async ({ req, res, log, error }: any) => {
  const callerId = req.headers?.["x-appwrite-user-id"];
  if (!callerId) {
    return res.json({ success: false, error: "غير مصرح" }, 401);
  }

  const apiKey =
    req.headers?.["x-appwrite-key"] ||
    process.env.APPWRITE_FUNCTION_API_KEY ||
    process.env.APPWRITE_API_KEY;

  const client = new Client()
    .setEndpoint(process.env.APPWRITE_FUNCTION_API_ENDPOINT || process.env.NEXT_PUBLIC_APPWRITE_ENDPOINT!)
    .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID || process.env.NEXT_PUBLIC_APPWRITE_PROJECT_ID!)
    .setKey(apiKey);

  const users = new Users(client);
  const tables = new TablesDB(client);

  try {
    // 1. Verify admin label strictly via Users API (single source of truth)
    const caller = await users.get({ userId: callerId });
    const isAdmin = caller.labels?.includes("admin");

    if (!isAdmin) {
      return res.json({ success: false, error: "هذا الإجراء مخصص للمسؤولين فقط" }, 403);
    }

    const rawBody = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body;
    const { topupId, action, confirmedAmountEgp, rejectReason } = approveSchema.parse(rawBody);
    if (action === "reject" && !rejectReason) {
      return res.json({ success: false, error: "سبب الرفض مطلوب" }, 400);
    }
    const ip = String(req.headers?.["x-forwarded-for"] || req.headers?.["x-real-ip"] || "").split(",")[0].trim();
    const egp = (n: number) => `${toArabicDigits(Math.round(n))} ج.م`;

    // 2. Fetch topup row
    const topup: any = await tables.getRow({ databaseId: "digr", tableId: "topups", rowId: topupId });
    if (topup.status !== "pending") {
      return res.json({ success: false, error: "تمت مراجعة هذا الطلب مسبقاً" }, 400);
    }

    const now = new Date().toISOString();

    if (action === "approve") {
      // 3. Read credit price from settings_public
      const settingsPub: any = await tables.getRow({ databaseId: "digr", tableId: "settings_public", rowId: "pricing" });
      const creditValueEgp = settingsPub.creditValueEgp || 0.1;
      const effectiveAmount = confirmedAmountEgp || topup.amountEgp;
      const credits = Math.floor(effectiveAmount / creditValueEgp);

      // 4. Create deterministic ledger entry: top_<topupId>
      await applyTopup(tables, topup.userId, topupId, credits, `شحن عبر انستاباي (مرجع: ${topup.reference})`);

      // 5. Update topup row
      await tables.updateRow({
        databaseId: "digr",
        tableId: "topups",
        rowId: topupId,
        data: {
          status: "approved",
          confirmedAmountEgp: effectiveAmount,
          credits,
          reviewedBy: callerId,
          reviewedAt: now,
        },
      });

      log(`Approved topup ${topupId}: granted ${credits} credits to ${topup.userId}`);

      await notifyUser(client, {
        userId: topup.userId,
        kind: "topup_approved",
        title: "تم اعتماد شحن رصيدك",
        body: `أُضيف ${toArabicDigits(credits)} نقطة إلى محفظتك (${egp(effectiveAmount)}).`,
        link: "/dashboard/topup",
        emailVars: {
          ConfirmedAmountEgp: toArabicDigits(effectiveAmount),
          Credits: toArabicDigits(credits),
          Reference: topup.reference,
        },
      }, log);
      await writeAudit(client, {
        actorId: callerId, actorName: caller.name || "مسؤول", kind: "approve", label: "اعتماد شحن",
        target: `${topup.senderName || topup.userId} · ${egp(effectiveAmount)} → ${toArabicDigits(credits)} نقطة`,
        targetType: "topup", targetId: topupId, ip,
      }, log);
      return res.json({ success: true, status: "approved", credits });
    } else {
      // Reject
      await tables.updateRow({
        databaseId: "digr",
        tableId: "topups",
        rowId: topupId,
        data: {
          status: "rejected",
          rejectReason,
          reviewedBy: callerId,
          reviewedAt: now,
        },
      });

      log(`Rejected topup ${topupId} by admin ${callerId}`);

      await notifyUser(client, {
        userId: topup.userId,
        kind: "topup_rejected",
        title: "تم رفض طلب شحن",
        body: `السبب: ${rejectReason}`,
        link: "/dashboard/topup",
        emailVars: {
          AmountEgp: toArabicDigits(topup.amountEgp),
          Reference: topup.reference,
          RejectReason: rejectReason,
        },
      }, log);
      await writeAudit(client, {
        actorId: callerId, actorName: caller.name || "مسؤول", kind: "reject", label: "رفض شحن",
        target: `${topup.senderName || topup.userId} · السبب: ${rejectReason}`,
        targetType: "topup", targetId: topupId, ip,
      }, log);
      return res.json({ success: true, status: "rejected" });
    }
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.json({ success: false, error: err.issues[0]?.message || "مدخلات غير صالحة" }, 400);
    }
    error(`Topup review failed: ${err.message}`);
    return res.json({ success: false, error: err.message }, 500);
  }
};
