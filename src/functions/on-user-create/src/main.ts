import { Client, Databases, Permission, Role } from "node-appwrite";

export default async ({ req, res, log, error }: any) => {
  const client = new Client()
    .setEndpoint(process.env.APPWRITE_FUNCTION_API_ENDPOINT || process.env.NEXT_PUBLIC_APPWRITE_ENDPOINT!)
    .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID || process.env.NEXT_PUBLIC_APPWRITE_PROJECT_ID!)
    .setKey(process.env.APPWRITE_API_KEY!);

  const db = new Databases(client);

  try {
    // Appwrite user-create event payload
    const eventData = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body;
    const userId = eventData.$id || req.headers["x-appwrite-user-id"];
    const displayName = eventData.name || eventData.email?.split("@")[0] || "مستخدم";

    if (!userId) {
      error("Missing user ID in event");
      return res.json({ success: false, error: "Missing user ID" }, 400);
    }

    log(`Creating profile for user: ${userId}`);

    // Create profile document with role = "user"
    await db.createDocument(
      "digr",
      "profiles",
      userId, // Use userId as docId for 1-to-1 mapping
      {
        userId,
        displayName,
        role: "user",
        createdAt: new Date().toISOString(),
      },
      [Permission.read(Role.user(userId))]
    );

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
