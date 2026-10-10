import { NextRequest, NextResponse } from "next/server";
import { Account, Client as ServerClient, Client as UserClient, Query, TablesDB } from "node-appwrite";

const endpoint = process.env.NEXT_PUBLIC_APPWRITE_ENDPOINT || "https://fra.cloud.appwrite.io/v1";
const projectId = process.env.NEXT_PUBLIC_APPWRITE_PROJECT_ID || "6ac947090008606ef482";
const apiKey = process.env.APPWRITE_API_KEY!;
const tables = new TablesDB(new ServerClient().setEndpoint(endpoint).setProject(projectId).setKey(apiKey));

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  const bearerJwt = authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : null;
  const sessionCookie = req.cookies.get(`a_session_${projectId}`)?.value || req.cookies.get(`a_session_${projectId}_legacy`)?.value;
  if (!bearerJwt && !sessionCookie) return NextResponse.json({ success: false, error: "يرجى تسجيل الدخول أولاً." }, { status: 401 });
  const userClient = new UserClient().setEndpoint(endpoint).setProject(projectId);
  if (bearerJwt) userClient.setJWT(bearerJwt);
  else userClient.setSession(sessionCookie!);
  let user: any;
  try { user = await new Account(userClient).get(); }
  catch { return NextResponse.json({ success: false, error: "انتهت صلاحية الجلسة." }, { status: 401 }); }
  if (!Array.isArray(user.labels) || !user.labels.includes("admin")) return NextResponse.json({ success: false, error: "غير مصرح." }, { status: 403 });
  if (process.env.GOODWILL_ENABLED !== "true") return NextResponse.json({ success: true, enabled: false, refunds: [], reviews: [] });

  try {
    const [refundRows, reviewRows] = await Promise.all([
      tables.listRows({ databaseId: "digr", tableId: "notifications", queries: [Query.equal("kind", "auto_refund"), Query.orderDesc("createdAt"), Query.limit(100)] }),
      tables.listRows({ databaseId: "digr", tableId: "notifications", queries: [Query.equal("kind", "review_queue"), Query.orderDesc("createdAt"), Query.limit(100)] }),
    ]);
    const toItem = (row: any) => ({
      id: row.$id,
      userId: String(row.userId || ""),
      jobId: String(row.jobId || ""),
      titleAr: String(row.titleAr || "").slice(0, 256),
      bodyAr: String(row.bodyAr || "").slice(0, 2000),
      status: String(row.status || "pending"),
      reasonCode: String(row.reasonCode || "").slice(0, 128),
      customerCategory: String(row.customerCategory || ""),
      customerDetails: String(row.customerDetails || "").slice(0, 200),
      delta: Number.isFinite(Number(row.delta)) ? Number(row.delta) : null,
      createdAt: String(row.createdAt || ""),
    });
    return NextResponse.json({ success: true, enabled: true, refunds: refundRows.rows.map(toItem), reviews: reviewRows.rows.map(toItem) });
  } catch {
    return NextResponse.json({ success: true, enabled: true, refunds: [], reviews: [], storageAvailable: false });
  }
}
