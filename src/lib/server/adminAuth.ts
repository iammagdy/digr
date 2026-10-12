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

function toSnakeCaseKey(key: string, tableId?: string): string {
  if (tableId === "provider_costs" && key === "at") return "created_at";
  if (key === "registration" || key === "createdAt" || key === "$createdAt") return "created_at";
  if (key === "accessedAt" || key === "updatedAt" || key === "$updatedAt") return "updated_at";
  if (key === "$id") {
    return tableId === "settings_public" || tableId === "settings_private" ? "key" : "id";
  }
  return key.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
}

function toCamelCaseKey(key: string): string {
  return key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

function mapRowFromSupabase(row: any, tableId?: string): any {
  if (!row || typeof row !== "object") return row;
  const out: Record<string, any> = { ...row };
  for (const [k, v] of Object.entries(row)) {
    out[toCamelCaseKey(k)] = v;
  }
  out.$id = row.id ?? row.key ?? row.$id;
  out.createdAt = row.created_at ?? row.createdAt;
  out.updatedAt = row.updated_at ?? row.updatedAt;

  if (tableId === "provider_costs") {
    out.at = row.created_at ?? row.at;
    out.costEgp = Number(row.cost_egp ?? row.costEgp ?? 0);
    out.costUsd = Number(row.cost_usd ?? row.costUsd ?? 0);
  }
  if (tableId === "topups") {
    out.amountEgp = Number(row.amount_egp ?? row.amountEgp ?? 0);
    out.confirmedAmountEgp =
      row.confirmed_amount_egp != null
        ? Number(row.confirmed_amount_egp)
        : (row.confirmedAmountEgp ?? null);
  }
  if (tableId === "settings_public") {
    out.creditValueEgp = Number(row.credit_value_egp ?? row.creditValueEgp ?? 0.1);
  }
  if (tableId === "admin_audit_log") {
    const details = typeof row.details === "object" && row.details ? row.details : {};
    out.actorId = row.actor_id ?? row.actorId ?? "";
    out.ip = details.ip ?? row.ip ?? "";
    out.meta =
      row.meta ??
      JSON.stringify({
        who: details.actorName || row.actor_id || "مسؤول",
        label: details.label || row.action || "",
        target: row.target_id || details.target || "",
      });
  }
  return out;
}

function mapDataToSupabase(data: Record<string, any>, tableId?: string): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(data || {})) {
    if (k === "$id") continue;
    out[toSnakeCaseKey(k, tableId)] = v;
  }
  return out;
}

function createSupabaseTablesAdapter(adminClient: any): any {
  return {
    async listRows({ tableId, queries = [] }: { databaseId?: string; tableId: string; queries?: string[] }) {
      let qb = adminClient.from(tableId).select("*", { count: "exact" });
      let limitVal = 100;
      let offsetVal = 0;

      for (const qStr of queries) {
        try {
          const q = JSON.parse(qStr);
          const col = q.attribute ? toSnakeCaseKey(q.attribute, tableId) : "";
          const vals = Array.isArray(q.values) ? q.values : [];
          if (q.method === "equal" && col) {
            if (vals.length === 1) qb = qb.eq(col, vals[0]);
            else if (vals.length > 1) qb = qb.in(col, vals);
          } else if (q.method === "greaterThanEqual" && col && vals.length) {
            qb = qb.gte(col, vals[0]);
          } else if (q.method === "lessThanEqual" && col && vals.length) {
            qb = qb.lte(col, vals[0]);
          } else if (q.method === "orderDesc" && col) {
            qb = qb.order(col, { ascending: false });
          } else if (q.method === "orderAsc" && col) {
            qb = qb.order(col, { ascending: true });
          } else if (q.method === "limit" && vals.length) {
            limitVal = Math.max(1, Number(vals[0]) || 100);
          } else if (q.method === "offset" && vals.length) {
            offsetVal = Math.max(0, Number(vals[0]) || 0);
          }
        } catch {
          // ignore malformed query string
        }
      }

      qb = qb.range(offsetVal, offsetVal + limitVal - 1);
      const { data, count, error } = await qb;
      if (error) throw error;
      const rows = (data || []).map((r: any) => mapRowFromSupabase(r, tableId));
      return { rows, total: count ?? rows.length };
    },
    async getRow({ tableId, rowId }: { databaseId?: string; tableId: string; rowId: string }) {
      const pk = tableId === "settings_public" || tableId === "settings_private" ? "key" : "id";
      const { data, error } = await adminClient.from(tableId).select("*").eq(pk, rowId).single();
      if (error || !data) throw error || new Error("not_found");
      return mapRowFromSupabase(data, tableId);
    },
    async createRow({ tableId, rowId, data }: { databaseId?: string; tableId: string; rowId: string; data: Record<string, any> }) {
      const pk = tableId === "settings_public" || tableId === "settings_private" ? "key" : "id";
      const payload = { [pk]: rowId, ...mapDataToSupabase(data, tableId) };
      const { data: created, error } = await adminClient.from(tableId).insert(payload).select("*").single();
      if (error) throw error;
      return mapRowFromSupabase(created, tableId);
    },
    async updateRow({ tableId, rowId, data }: { databaseId?: string; tableId: string; rowId: string; data: Record<string, any> }) {
      const pk = tableId === "settings_public" || tableId === "settings_private" ? "key" : "id";
      const payload = mapDataToSupabase(data, tableId);
      const { data: updated, error } = await adminClient.from(tableId).update(payload).eq(pk, rowId).select("*").single();
      if (error) throw error;
      return mapRowFromSupabase(updated, tableId);
    },
  };
}

function mapProfileToAdminUser(p: any): any {
  return {
    $id: p.id,
    id: p.id,
    name: p.name || "",
    email: p.email || "",
    registration: p.created_at || new Date().toISOString(),
    accessedAt: p.updated_at || p.created_at || null,
    emailVerification: true,
    status: !p.deletion_scheduled_for,
    labels: [],
  };
}

function createSupabaseUsersAdapter(adminClient: any): any {
  return {
    async list({ queries = [], search }: { queries?: string[]; search?: string } = {}) {
      let qb = adminClient.from("profiles").select("*", { count: "exact" });
      let limitVal = 100;
      let offsetVal = 0;

      for (const qStr of queries) {
        try {
          const q = JSON.parse(qStr);
          if (q.attribute === "labels") continue;
          const col = q.attribute ? toSnakeCaseKey(q.attribute, "profiles") : "";
          const vals = Array.isArray(q.values) ? q.values : [];
          if (q.method === "equal" && col && vals.length === 1) {
            qb = qb.eq(col, vals[0]);
          } else if (q.method === "greaterThanEqual" && col && vals.length) {
            qb = qb.gte(col, vals[0]);
          } else if (q.method === "orderDesc" && col) {
            qb = qb.order(col, { ascending: false });
          } else if (q.method === "orderAsc" && col) {
            qb = qb.order(col, { ascending: true });
          } else if (q.method === "limit" && vals.length) {
            limitVal = Math.max(1, Number(vals[0]) || 100);
          } else if (q.method === "offset" && vals.length) {
            offsetVal = Math.max(0, Number(vals[0]) || 0);
          }
        } catch {
          // ignore
        }
      }

      if (search && search.trim()) {
        const s = search.trim().replace(/[,%]/g, "");
        if (s) qb = qb.or(`name.ilike.%${s}%,email.ilike.%${s}%`);
      }

      qb = qb.range(offsetVal, offsetVal + limitVal - 1);
      const { data, count, error } = await qb;
      if (error) return { users: [], total: 0 };
      const users = (data || []).map(mapProfileToAdminUser);
      return { users, total: count ?? users.length };
    },
    async get({ userId }: { userId: string }) {
      const { data, error } = await adminClient.from("profiles").select("*").eq("id", userId).single();
      if (error || !data) throw error || new Error("user_not_found");
      return mapProfileToAdminUser(data);
    },
  };
}

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
            tables: createSupabaseTablesAdapter(adminClient),
            users: createSupabaseUsersAdapter(adminClient),
            audit: async (kind, label, target, extra) => {
              try {
                await adminClient.from("admin_audit_log").insert({
                  actor_id: sbUser.id,
                  action: kind,
                  target_type: extra?.targetType || "admin",
                  target_id: target,
                  details: { actorName: sbUser.user_metadata?.name || "مسؤول", label, target, ip, ...extra },
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
