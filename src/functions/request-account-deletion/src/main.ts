import { Client, TablesDB, Users, Query } from "../../shared/dbCompat";

const GRACE_DAYS = 30;

/**
 * Schedules the caller's account for deletion in 30 days: marks the profile and prefs, revokes every session
 * and disables sign-in. The scheduled `purge-deleted-accounts` function removes files and the account itself.
 */
export default async ({ req, res, log, error }: any) => {
  const callerId = req.headers?.["x-appwrite-user-id"];
  if (!callerId) return res.json({ success: false, error: "غير مصرح — يرجى تسجيل الدخول أولاً" }, 401);

  const apiKey = req.headers?.["x-appwrite-key"] || process.env.APPWRITE_FUNCTION_API_KEY || process.env.APPWRITE_API_KEY;
  const client = new Client()
    .setEndpoint(process.env.APPWRITE_FUNCTION_API_ENDPOINT || process.env.NEXT_PUBLIC_APPWRITE_ENDPOINT!)
    .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID || process.env.NEXT_PUBLIC_APPWRITE_PROJECT_ID!)
    .setKey(apiKey);
  const users = new Users(client);
  const tables = new TablesDB(client);

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    // The UI makes the user type «حذف»; the server re-checks so a forged call cannot delete an account by accident.
    if (String(body.confirm ?? "").trim() !== "حذف") {
      return res.json({ success: false, error: "اكتب «حذف» للتأكيد" }, 400);
    }

    const scheduledFor = new Date(Date.now() + GRACE_DAYS * 86400000).toISOString();
    const user = await users.get({ userId: callerId });

    await users.updatePrefs({ userId: callerId, prefs: { ...(user.prefs || {}), deletionScheduledFor: scheduledFor } });

    const profiles = await tables.listRows({ databaseId: "digr", tableId: "profiles", queries: [Query.equal("userId", callerId), Query.limit(1)] });
    const profile = profiles.rows?.[0];
    if (profile) {
      await tables.updateRow({ databaseId: "digr", tableId: "profiles", rowId: profile.$id, data: { deletionScheduledFor: scheduledFor } });
    }

    await users.deleteSessions({ userId: callerId });
    await users.updateStatus({ userId: callerId, status: false });

    log(`Account ${callerId} scheduled for deletion at ${scheduledFor}`);
    return res.json({ success: true, scheduledFor });
  } catch (err: any) {
    error(`request-account-deletion failed: ${err.message}`);
    return res.json({ success: false, error: "تعذّر تنفيذ طلب حذف الحساب. حاول مرة أخرى." }, 500);
  }
};
