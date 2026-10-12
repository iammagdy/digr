import { NextRequest, NextResponse } from "next/server";
import { Query } from "node-appwrite";
import { authenticateAdmin } from "@/lib/server/adminAuth";

export const dynamic = "force-dynamic";

const GROUPS: Record<string, string[]> = {
  money: ["approve", "reject"],
  keys: ["key", "toggle"],
  settings: ["setting", "login"],
};

/** Read-only view of the append-only audit log. There is deliberately no update/delete handler. */
export async function GET(req: NextRequest) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;
  const group = req.nextUrl.searchParams.get("group") || "all";
  const queries = [Query.orderDesc("createdAt"), Query.limit(200)];
  if (GROUPS[group]) queries.push(Query.equal("action", GROUPS[group]));
  const res = await auth.ctx.tables.listRows({ databaseId: "digr", tableId: "admin_audit_log", queries });
  const entries = res.rows.map((r: any) => {
    let m: any = {};
    try { m = JSON.parse(r.meta || "{}"); } catch { /* legacy row */ }
    return { id: r.$id, kind: r.action, who: m.who || r.actorId, label: m.label || r.action, target: m.target || "", ip: r.ip || "", createdAt: r.createdAt };
  });
  return NextResponse.json({ entries });
}

/** One «تسجيل دخول» entry per admin browser session (called by the admin shell on first load). */
export async function POST(req: NextRequest) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;
  const ua = (req.headers.get("user-agent") || "").slice(0, 120);
  await auth.ctx.audit("login", "تسجيل دخول", `دخول إلى لوحة الإدارة · ${ua || "—"}`, { targetType: "session" });
  return NextResponse.json({ success: true });
}
