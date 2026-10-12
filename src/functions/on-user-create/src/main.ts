import { Client, TablesDB, Permission, Role } from "node-appwrite";
import { notifyUser } from "../../shared/notify";

export default async ({ req, res, log, error }: any) => {
  const apiKey =
    req.headers?.["x-appwrite-key"] ||
    process.env.APPWRITE_FUNCTION_API_KEY ||
    process.env.APPWRITE_API_KEY;

  const client = new Client()
    .setEndpoint(process.env.APPWRITE_FUNCTION_API_ENDPOINT || process.env.NEXT_PUBLIC_APPWRITE_ENDPOINT!)
    .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID || process.env.NEXT_PUBLIC_APPWRITE_PROJECT_ID!)
    .setKey(apiKey);

  const tables = new TablesDB(client);

  try {
    // Appwrite user-create event payload
    const eventData = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body;
    const userId = eventData.$id || req.headers["x-appwrite-user-id"];
    const displayName = eventData.name || eventData.email?.split("@")[0] || "مستخدم";

    if (!userId) {
      error("Missing user ID in event");
      return res.json({ success: false, error: "Missing user ID" }, 400);
    }

    // Email verified (users.*.verification.*.update): welcome notification, nothing else to do.
    if (String(req.headers?.["x-appwrite-event"] || "").includes(".verification.")) {
      await notifyUser(client, {
        userId, kind: "welcome", title: "مرحبًا بك في ديجر",
        body: "أكّدت بريدك بنجاح. اشحن رصيدك وابدأ أول بحث.", link: "/dashboard/topup",
      }, log);
      return res.json({ success: true, userId, welcome: true });
    }

    log(`Creating profile for user: ${userId}`);

    // Create profile document with role = "user"
    await tables.createRow({
      databaseId: "digr",
      tableId: "profiles",
      rowId: userId, // Use userId as rowId for 1-to-1 mapping
      data: {
        userId,
        displayName,
        role: "user",
        createdAt: new Date().toISOString(),
      },
      permissions: [Permission.read(Role.user(userId))],
    });

    return res.json({ success: true, userId });
  } catch (err: any) {
    if (err.code === 409) {
      log("Profile already exists");
      return res.json({ success: true, message: "Profile already exists" });
    }
    error(`Failed to create profile: ${err.message}`);
    return res.json({ success: false, error: err.message }, 500);
  }
};
