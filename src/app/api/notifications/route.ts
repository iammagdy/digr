import { NextRequest, NextResponse } from "next/server";
import { Account, Client as ServerClient, Client as UserClient, Query, TablesDB } from "node-appwrite";

const endpoint = process.env.NEXT_PUBLIC_APPWRITE_ENDPOINT || "https://fra.cloud.appwrite.io/v1";
const projectId = process.env.NEXT_PUBLIC_APPWRITE_PROJECT_ID || "6ac947090008606ef482";
const apiKey = process.env.APPWRITE_API_KEY!;
const serverClient = new ServerClient().setEndpoint(endpoint).setProject(projectId).setKey(apiKey);
const tables = new TablesDB(serverClient);

async function authenticatedUserId(req: NextRequest): Promise<string | null> {
  const authHeader = req.headers.get("authorization");
  const bearerJwt = authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : null;
  const sessionCookie = req.cookies.get(`a_session_${projectId}`)?.value || req.cookies.get(`a_session_${projectId}_legacy`)?.value;
  if (!bearerJwt && !sessionCookie) return null;
  const client = new UserClient().setEndpoint(endpoint).setProject(projectId);
  if (bearerJwt) client.setJWT(bearerJwt);
  else client.setSession(sessionCookie!);
  try { return (await new Account(client).get()).$id; } catch { return null; }
}

export async function GET(req: NextRequest) {
  const userId = await authenticatedUserId(req);
  if (!userId) return NextResponse.json({ success: false, error: "انتهت صلاحية الجلسة." }, { status: 401 });
  if (process.env.GOODWILL_ENABLED !== "true") {
    return NextResponse.json({ success: true, enabled: false, items: [], unreadCount: 0 });
  }
  try {
    const result = await tables.listRows({
      databaseId: "digr", tableId: "notifications",
      queries: [Query.equal("userId", userId), Query.equal("kind", ["auto_refund", "customer_notice"]), Query.orderDesc("createdAt"), Query.limit(50)],
    });
    const items = result.rows.map((row: any) => ({
      id: row.$id,
      kind: row.kind,
      titleAr: String(row.titleAr || "إشعار جديد").slice(0, 256),
      bodyAr: String(row.bodyAr || "").slice(0, 2000),
      status: row.status === "read" ? "read" : "unread",
      delta: Number.isFinite(Number(row.delta)) ? Number(row.delta) : null,
      jobId: typeof row.jobId === "string" ? row.jobId : null,
      createdAt: typeof row.createdAt === "string" ? row.createdAt : "",
    }));
    return NextResponse.json({ success: true, enabled: true, items, unreadCount: items.filter((item) => item.status === "unread").length });
  } catch {
    return NextResponse.json({ success: true, enabled: true, items: [], unreadCount: 0, storageAvailable: false });
  }
}

export async function PATCH(req: NextRequest) {
  const userId = await authenticatedUserId(req);
  if (!userId) return NextResponse.json({ success: false, error: "انتهت صلاحية الجلسة." }, { status: 401 });
  if (process.env.GOODWILL_ENABLED !== "true") return NextResponse.json({ success: false, error: "الإشعارات غير متاحة حالياً." }, { status: 503 });
  const body = await req.json().catch(() => ({}));
  if (typeof body.id !== "string" || !/^[A-Za-z0-9_-]{1,36}$/.test(body.id)) {
    return NextResponse.json({ success: false, error: "معرف الإشعار غير صالح." }, { status: 400 });
  }
  try {
    const row: any = await tables.getRow({ databaseId: "digr", tableId: "notifications", rowId: body.id });
    if (row.userId !== userId || !["auto_refund", "customer_notice"].includes(row.kind)) {
      return NextResponse.json({ success: false, error: "غير مصرح بتحديث هذا الإشعار." }, { status: 403 });
    }
    if (row.status !== "read") {
      await tables.updateRow({ databaseId: "digr", tableId: "notifications", rowId: body.id, data: { status: "read" } });
    }
    return NextResponse.json({ success: true, id: body.id, status: "read" });
  } catch {
    return NextResponse.json({ success: false, error: "تعذر تحديث الإشعار." }, { status: 503 });
  }
}
