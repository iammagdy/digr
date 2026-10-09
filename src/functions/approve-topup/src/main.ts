import { Client, TablesDB, Users } from "node-appwrite";
import { applyTopup } from "../../shared/ledger";
import { z } from "zod";

const approveSchema = z.object({
  topupId: z.string().min(1),
  action: z.enum(["approve", "reject"]),
  confirmedAmountEgp: z.number().positive().optional(),
});

export default async ({ req, res, log, error }: any) => {
  const callerId = req.headers["x-appwrite-user-id"];
  if (!callerId) {
    return res.json({ success: false, error: "غير مصرح" }, 401);
  }

  const client = new Client()
    .setEndpoint(process.env.APPWRITE_FUNCTION_API_ENDPOINT || process.env.NEXT_PUBLIC_APPWRITE_ENDPOINT!)
    .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID || process.env.NEXT_PUBLIC_APPWRITE_PROJECT_ID!)
    .setKey(process.env.APPWRITE_API_KEY!);

  const users = new Users(client);
  const tables = new TablesDB(client);

  try {
    // 1. Verify admin label strictly via Users API (single source of truth)
    const caller = await users.get(callerId);
    const isAdmin = caller.labels?.includes("admin");

    if (!isAdmin) {
      return res.json({ success: false, error: "هذا الإجراء مخصص للمسؤولين فقط" }, 403);
    }

    const rawBody = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body;
    const { topupId, action, confirmedAmountEgp } = approveSchema.parse(rawBody);

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
      return res.json({ success: true, status: "approved", credits });
    } else {
      // Reject
      await tables.updateRow({
        databaseId: "digr",
        tableId: "topups",
        rowId: topupId,
        data: {
          status: "rejected",
          reviewedBy: callerId,
          reviewedAt: now,
        },
      });

      log(`Rejected topup ${topupId} by admin ${callerId}`);
      return res.json({ success: true, status: "rejected" });
    }
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return res.json({ success: false, error: "مدخلات غير صالحة" }, 400);
    }
    error(`Topup review failed: ${err.message}`);
    return res.json({ success: false, error: err.message }, 500);
  }
};
