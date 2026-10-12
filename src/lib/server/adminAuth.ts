import { NextRequest, NextResponse } from "next/server";
import { Account, Client, Query, TablesDB, Users } from "node-appwrite";
import { writeAudit, type AuditKind } from "../../functions/shared/auditLog";

export const ENDPOINT = process.env.NEXT_PUBLIC_APPWRITE_ENDPOINT || process.env.APPWRITE_ENDPOINT || "https://fra.cloud.appwrite.io/v1";
export const PROJECT_ID = process.env.NEXT_PUBLIC_APPWRITE_PROJECT_ID || process.env.APPWRITE_PROJECT_ID || "6ac947090008606ef482";

export function serverClient(): Client {
  return new Client().setEndpoint(ENDPOINT).setProject(PROJECT_ID).setKey(process.env.APPWRITE_API_KEY || "");
}

export function clientIp(req: Pick<NextRequest, "headers">): string {
  const xf = req.headers.get("x-forwarded-for") || req.headers.get("x-real-ip") || "";
  return xf.split(",")[0].trim();
}

function extractFallbackSession(headerVal: string | null): string | null {
  if (!headerVal) return null;
  try {
    const parsed = JSON.parse(headerVal);
    const v = parsed?.[`a_session_${PROJECT_ID}`] || parsed?.[`a_session_${PROJECT_ID}_legacy`];
    return typeof v === "string" && v.trim() ? v.trim() : null;
  } catch {
    return null;
  }
}

export interface AdminContext {
  adminId: string;
  adminName: string;
  adminEmail: string;
  ip: string;
  client: Client;
  tables: TablesDB;
  users: Users;
  audit: (kind: AuditKind, label: string, target: string, extra?: { targetType?: string; targetId?: string }) => Promise<void>;
}

import { createServerSideClient, createAdminClient } from "../supabase/server";

export async function authenticateAdmin(req: NextRequest): Promise<{ ok: true; ctx: AdminContext } | { ok: false; response: NextResponse }> {
  // 1. Try Supabase Admin session / Bearer token first
  try {
    const supabase = await createServerSideClient();
    const authHeader = req.headers.get("authorization");
    const bearer = authHeader?.startsWith("Bearer ") ? authHeader.substring(7).trim() : null;
    let sbUser = null;
    if (bearer) {
      const { data } = await supabase.auth.getUser(bearer);
      sbUser = data?.user;
    } else {
      const { data } = await supabase.auth.getUser();
      sbUser = data?.user;
    }

    if (sbUser) {
      if (sbUser.app_metadata?.role === "admin") {
        const adminClient = createAdminClient();
        const ip = clientIp(req);
        const client = serverClient();
        return {
          ok: true,
          ctx: {
            adminId: sbUser.id,
            adminName: sbUser.user_metadata?.name || sbUser.email || "مسؤول",
            adminEmail: sbUser.email || "",
            ip,
            client,
            tables: new TablesDB(client),
            users: new Users(client),
            audit: async (kind, label, target, extra) => {
              try {
                await adminClient.from("admin_audit_log").insert({
                  actor_id: sbUser.id,
                  action: kind,
                  target_type: extra?.targetType || "admin",
                  target_id: target,
                  details: { label, ip, ...extra },
                });
              } catch {
                writeAudit(client, { actorId: sbUser.id, actorName: sbUser.user_metadata?.name || "مسؤول", kind, label, target, ip, ...extra }).catch(() => {});
              }
            },
          },
        };
      } else {
        return {
          ok: false,
          response: NextResponse.json({ error: "ممنوع — هذه الواجهة مخصصة لمديري النظام فقط." }, { status: 403 }),
        };
      }
    }
  } catch {
    // Continue if Supabase client threw an error
  }

  // Appwrite fallback guard: disabled by default unless explicitly enabled via ENABLE_APPWRITE_ADMIN_FALLBACK=true
  const allowAppwriteFallback = process.env.ENABLE_APPWRITE_ADMIN_FALLBACK === "true";
  if (!allowAppwriteFallback) {
    return {
      ok: false,
      response: NextResponse.json({ error: "غير مصرح. يرجى تسجيل الدخول بحساب مسؤول في Supabase." }, { status: 401 }),
    };
  }

  const authHeader = req.headers.get("authorization");
  const bearer = authHeader?.startsWith("Bearer ") ? authHeader.substring(7).trim() : null;
  const cookieJwt = req.cookies.get("digr_jwt")?.value?.trim() || null;
  const jwt = bearer || cookieJwt;
  const session =
    req.cookies.get(`a_session_${PROJECT_ID}`)?.value ||
    req.cookies.get(`a_session_${PROJECT_ID}_legacy`)?.value ||
    extractFallbackSession(req.headers.get("x-fallback-cookies"));

  if (!jwt && !session) {
    return { ok: false, response: NextResponse.json({ error: "غير مصرح. يرجى تسجيل الدخول أولاً." }, { status: 401 }) };
  }

  const userClient = new Client().setEndpoint(ENDPOINT).setProject(PROJECT_ID);
  if (jwt) userClient.setJWT(jwt);
  else if (session) userClient.setSession(session);

  let me: any;
  try {
    me = await new Account(userClient).get();
  } catch {
    return { ok: false, response: NextResponse.json({ error: "انتهت صلاحية الجلسة أو أنها غير صالحة." }, { status: 401 }) };
  }
  if (!(Array.isArray(me?.labels) && me.labels.includes("admin"))) {
    return { ok: false, response: NextResponse.json({ error: "ممنوع — هذه الواجهة مخصصة لمديري النظام فقط." }, { status: 403 }) };
  }

  const client = serverClient();
  const ip = clientIp(req);
  return {
    ok: true,
    ctx: {
      adminId: me.$id, adminName: me.name || "مسؤول", adminEmail: me.email || "", ip, client,
      tables: new TablesDB(client), users: new Users(client),
      audit: (kind, label, target, extra) =>
        writeAudit(client, { actorId: me.$id, actorName: me.name || "مسؤول", kind, label, target, ip, ...extra }),
    },
  };
}

/** Pages through a table (100 per request) up to `cap` rows. */
export async function listAll(tables: TablesDB, tableId: string, queries: string[] = [], cap = 5000): Promise<any[]> {
  const out: any[] = [];
  for (let offset = 0; offset < cap; offset += 100) {
    const page = await tables.listRows({ databaseId: "digr", tableId, queries: [...queries, Query.limit(100), Query.offset(offset)] });
    out.push(...page.rows);
    if (page.rows.length < 100) break;
  }
  return out;
}

/** Same for the Users API. */
export async function listAllUsers(users: Users, queries: string[] = [], cap = 5000): Promise<any[]> {
  const out: any[] = [];
  for (let offset = 0; offset < cap; offset += 100) {
    const page = await users.list({ queries: [...queries, Query.limit(100), Query.offset(offset)] });
    out.push(...page.users);
    if (page.users.length < 100) break;
  }
  return out;
}

/** id → {name,email} for a set of users (20 parallel lookups at a time; unknown ids resolve to empty strings). */
export async function userDirectory(users: Users, ids: string[]): Promise<Map<string, { name: string; email: string }>> {
  const unique = [...new Set(ids.filter(Boolean))];
  const out = new Map<string, { name: string; email: string }>();
  for (let i = 0; i < unique.length; i += 20) {
    await Promise.all(unique.slice(i, i + 20).map(async (id) => {
      try { const u = await users.get({ userId: id }); out.set(id, { name: u.name || "", email: u.email || "" }); }
      catch { out.set(id, { name: "", email: "" }); }
    }));
  }
  return out;
}

/** Current EGP value of one point from settings_public (default 0.10). */
export async function creditValueEgp(tables: TablesDB): Promise<number> {
  try {
    const row: any = await tables.getRow({ databaseId: "digr", tableId: "settings_public", rowId: "pricing" });
    if (Number(row?.creditValueEgp) > 0) return Number(row.creditValueEgp);
  } catch { /* default */ }
  return 0.1;
}
