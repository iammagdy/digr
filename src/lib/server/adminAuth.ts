import { NextRequest, NextResponse } from "next/server";
import { createServerSideClient, createAdminClient } from "../supabase/server";

export type AuditKind = "approve" | "reject" | "key" | "toggle" | "setting" | "login" | string;

export const Query = {
  equal: (attr: string, val: any) => JSON.stringify({ method: "equal", attribute: attr, values: [val] }),
  notEqual: (attr: string, val: any) => JSON.stringify({ method: "notEqual", attribute: attr, values: [val] }),
  greaterThanEqual: (attr: string, val: any) => JSON.stringify({ method: "greaterThanEqual", attribute: attr, values: [val] }),
  lessThanEqual: (attr: string, val: any) => JSON.stringify({ method: "lessThanEqual", attribute: attr, values: [val] }),
  orderDesc: (attr: string) => JSON.stringify({ method: "orderDesc", attribute: attr }),
  orderAsc: (attr: string) => JSON.stringify({ method: "orderAsc", attribute: attr }),
  limit: (limit: number) => JSON.stringify({ method: "limit", values: [limit] }),
  offset: (offset: number) => JSON.stringify({ method: "offset", values: [offset] }),
};

export function clientIp(req: Pick<NextRequest, "headers">): string {
  const xf = req.headers.get("x-forwarded-for") || req.headers.get("x-real-ip") || "";
  return xf.split(",")[0].trim();
}

export interface AdminContext {
  adminId: string;
  adminName: string;
  adminEmail: string;
  ip: string;
  client?: any;
  tables: any;
  users: any;
  audit: (kind: AuditKind, label: string, target: string, extra?: { targetType?: string; targetId?: string }) => Promise<void>;
}

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
    out.reviewedAt = row.reviewed_at ?? row.reviewedAt ?? null;
  }
  if (tableId === "settings_public" || tableId === "settings_private") {
    if (row.value && typeof row.value === "object") {
      Object.assign(out, row.value);
    }
    if (tableId === "settings_public") {
      out.creditValueEgp = Number(out.creditValueEgp ?? row.credit_value_egp ?? row.creditValueEgp ?? 0.1);
    }
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
  if (tableId === "settings_public" || tableId === "settings_private") {
    const cleanValue: Record<string, any> = {};
    for (const [k, v] of Object.entries(data || {})) {
      if (k === "$id" || k === "key" || k === "updated_at" || k === "updatedAt") continue;
      cleanValue[k] = v;
    }
    return { value: cleanValue, updated_at: new Date().toISOString() };
  }
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
          if (tableId === "topups" && col === "reviewed_at") {
            // public.topups does not have reviewed_at column in tracked Supabase schema.
            // Drop filter/order on reviewed_at defensively to avoid PostgreSQL error 42703.
            continue;
          }
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
      let payload = mapDataToSupabase(data, tableId);
      if (tableId === "settings_public" || tableId === "settings_private") {
        const { data: existing } = await adminClient.from(tableId).select("value").eq(pk, rowId).maybeSingle();
        const prevValue = existing?.value && typeof existing.value === "object" ? existing.value : {};
        payload = { value: { ...prevValue, ...payload.value }, updated_at: payload.updated_at };
      }
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

    if (!sbUser) {
      return {
        ok: false,
        response: NextResponse.json({ error: "غير مصرح. يرجى تسجيل الدخول بحساب مسؤول في Supabase." }, { status: 401 }),
      };
    }

    if (sbUser.app_metadata?.role !== "admin") {
      return {
        ok: false,
        response: NextResponse.json({ error: "ممنوع — هذه الواجهة مخصصة لمديري النظام فقط." }, { status: 403 }),
      };
    }

    const adminClient = createAdminClient();
    const ip = clientIp(req);
    return {
      ok: true,
      ctx: {
        adminId: sbUser.id,
        adminName: sbUser.user_metadata?.name || sbUser.email || "مسؤول",
        adminEmail: sbUser.email || "",
        ip,
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
          } catch {}
        },
      },
    };
  } catch {
    return {
      ok: false,
      response: NextResponse.json({ error: "غير مصرح. يرجى تسجيل الدخول بحساب مسؤول في Supabase." }, { status: 401 }),
    };
  }
}

/** Pages through a table (100 per request) up to `cap` rows. */
export async function listAll(tables: any, tableId: string, queries: string[] = [], cap = 5000): Promise<any[]> {
  const out: any[] = [];
  for (let offset = 0; offset < cap; offset += 100) {
    const page = await tables.listRows({ databaseId: "digr", tableId, queries: [...queries, Query.limit(100), Query.offset(offset)] });
    out.push(...page.rows);
    if (page.rows.length < 100) break;
  }
  return out;
}

/** Same for the Users API. */
export async function listAllUsers(users: any, queries: string[] = [], cap = 5000): Promise<any[]> {
  const out: any[] = [];
  for (let offset = 0; offset < cap; offset += 100) {
    const page = await users.list({ queries: [...queries, Query.limit(100), Query.offset(offset)] });
    out.push(...page.users);
    if (page.users.length < 100) break;
  }
  return out;
}

/** id → {name,email} for a set of users (20 parallel lookups at a time; unknown ids resolve to empty strings). */
export async function userDirectory(users: any, ids: string[]): Promise<Map<string, { name: string; email: string }>> {
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
export async function creditValueEgp(tables: any): Promise<number> {
  try {
    const row: any = await tables.getRow({ databaseId: "digr", tableId: "settings_public", rowId: "pricing" });
    if (Number(row?.creditValueEgp) > 0) return Number(row.creditValueEgp);
  } catch { /* default */ }
  return 0.1;
}

export interface TopupApprovalInfo {
  reviewedAt: string;
  credits: number;
}

/**
 * Derives true topup approval records (reviewedAt timestamp and granted credits)
 * directly from the append-only credit_ledger (read-only query).
 * Each approved topup creates an immutable row with id 'top_<topupId>' and type 'topup'.
 */
export async function getTopupApprovalMap(tables: any): Promise<Map<string, TopupApprovalInfo>> {
  const ledgerRows = await listAll(tables, "credit_ledger", [Query.equal("type", "topup")], 10000).catch(() => []);
  const map = new Map<string, TopupApprovalInfo>();
  for (const row of ledgerRows) {
    const rawId =
      row.topupId ||
      (typeof row.$id === "string" && row.$id.startsWith("top_") ? row.$id.slice(4) : null) ||
      (typeof row.id === "string" && row.id.startsWith("top_") ? row.id.slice(4) : null);
    if (rawId) {
      map.set(rawId, {
        reviewedAt: row.createdAt || row.created_at,
        credits: Number(row.delta) || 0,
      });
    }
  }
  return map;
}

/**
 * Enriches topup rows with approval data from credit_ledger without inventing timestamps.
 * If no corresponding ledger entry exists, reviewedAt is left null.
 */
export function enrichTopupsWithApprovals<T extends Record<string, any>>(
  topups: T[],
  approvalMap: Map<string, TopupApprovalInfo>
): T[] {
  for (const t of topups) {
    const raw = t as any;
    const id = raw.$id || raw.id;
    const app = id ? approvalMap.get(id) : undefined;
    if (app) {
      raw.reviewedAt = raw.reviewedAt || app.reviewedAt;
      raw.credits = raw.credits ?? app.credits;
    } else if (!raw.reviewedAt) {
      raw.reviewedAt = null;
    }
  }
  return topups;
}

