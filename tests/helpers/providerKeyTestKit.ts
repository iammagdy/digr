import { randomBytes } from "node:crypto";
import { vi } from "vitest";
import { encryptProviderKey, type ProviderId } from "../../src/lib/server/providerKeyCrypto";

/** Synthetic values only: random per run, never a real credential. */
export const newEncryptionKey = () => randomBytes(32).toString("base64");
export const fakeKey = (tag: string) => `testonly-${tag}-${randomBytes(9).toString("hex")}`;

/** Captures every console call so tests can assert that no key was logged anywhere. */
export function captureConsole() {
  const lines: string[] = [];
  const grab = (...args: unknown[]) => { lines.push(args.map((a) => (typeof a === "string" ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })())).join(" ")); };
  const spies = (["log", "warn", "error", "info", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(grab));
  return { lines, restore: () => spies.forEach((s) => s.mockRestore()), text: () => lines.join("\n") };
}

/**
 * A tiny in-memory stand-in for the provider_api_keys table and its two SQL functions, modelled on the real
 * functions (the real SQL is covered by the scratch-Postgres test).
 */
export function fakeKeyStore(options: { admins?: string[]; tableMissing?: boolean; functionsMissing?: boolean; readError?: boolean } = {}) {
  const admins = new Set(options.admins ?? ["admin-1"]);
  const rows = new Map<string, any>();
  const audit: Array<{ provider: string; action: string; last4: string; actor_id: string }> = [];
  const rpcCalls: Array<{ fn: string; args: any }> = [];
  const selects: string[] = [];
  const inserted: Array<{ table: string; row: any }> = [];
  const settings = new Map<string, any>();
  const missing = { code: "42P01", message: 'relation "public.provider_api_keys" does not exist' };
  const noFn = (fn: string) => ({ code: "PGRST202", message: `Could not find the function public.${fn} in the schema cache` });

  const client: any = {
    from: (table: string) => {
      const filters: Array<[string, any]> = [];
      const c: any = {
        select: (cols: string) => { selects.push(`${table}:${cols}`); return c; },
        eq: (col: string, val: any) => { filters.push([col, val]); return c; },
        gte: () => c, order: () => c, limit: () => c,
        maybeSingle: async () => {
          if (table === "settings_private") { const k = filters.find(([c]) => c === "key")?.[1]; return { data: settings.has(k) ? { value: settings.get(k) } : null, error: null }; }
          if (table !== "provider_api_keys") return { data: null, error: null };
          if (options.tableMissing) return { data: null, error: missing };
          if (options.readError) return { data: null, error: { code: "08006", message: "connection failure" } };
          const provider = filters.find(([k]) => k === "provider")?.[1];
          return { data: rows.get(provider) ?? null, error: null };
        },
        insert: async (row: any) => { inserted.push({ table, row }); return { error: null }; },
        upsert: async (row: any) => { if (table === "settings_private") settings.set(row.key, row.value); return { error: null }; },
        then: (resolve: any) => resolve({ data: [], error: null }),
      };
      return c;
    },
    rpc: async (fn: string, args: any) => {
      rpcCalls.push({ fn, args });
      if (options.functionsMissing || options.tableMissing) return { data: null, error: noFn(fn) };
      if (!admins.has(args.p_admin_id)) return { data: { success: false, error: "not_admin", error_ar: "هذا الإجراء مخصص للمسؤولين فقط." }, error: null };
      if (fn === "admin_set_provider_key_atomic") {
        const prev = rows.get(args.p_provider);
        rows.set(args.p_provider, {
          provider: args.p_provider, active_ciphertext: args.p_ciphertext, active_last4: args.p_last4, active_set_at: new Date().toISOString(),
          previous_ciphertext: prev?.active_ciphertext ?? null, previous_last4: prev?.active_last4 ?? null, previous_set_at: prev?.active_set_at ?? null,
          version: (prev?.version ?? 0) + 1,
        });
        audit.push({ provider: args.p_provider, action: "set", last4: args.p_last4, actor_id: args.p_admin_id });
        return { data: { success: true, version: rows.get(args.p_provider).version, last4: args.p_last4 }, error: null };
      }
      const row = rows.get(args.p_provider);
      if (!row?.previous_ciphertext) return { data: { success: false, error: "no_previous_key", error_ar: "لا يوجد مفتاح سابق للرجوع إليه." }, error: null };
      rows.set(args.p_provider, { ...row, active_ciphertext: row.previous_ciphertext, active_last4: row.previous_last4, previous_ciphertext: row.active_ciphertext, previous_last4: row.active_last4, version: row.version + 1 });
      audit.push({ provider: args.p_provider, action: "rollback", last4: row.previous_last4, actor_id: args.p_admin_id });
      return { data: { success: true, version: row.version + 1, last4: row.previous_last4 }, error: null };
    },
  };
  const seed = (provider: ProviderId, key: string, last4?: string, env?: NodeJS.ProcessEnv) => {
    rows.set(provider, { provider, active_ciphertext: encryptProviderKey(provider, key, env), active_last4: last4 ?? key.slice(-4), version: 1 });
  };
  return { client, rows, audit, rpcCalls, selects, inserted, settings, seed };
}

/** A fetch mock that answers by URL; records calls with their headers (never printed). */
export function mockProviderFetch(handler: (url: string, headers: Record<string, string>) => { status: number; body?: unknown } | Error) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const headers = Object.fromEntries(Object.entries((init?.headers as Record<string, string>) || {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
    calls.push({ url, headers });
    const r = handler(url, headers);
    if (r instanceof Error) throw r;
    return new Response(r.body === undefined ? "{}" : JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  });
  return { fn: fn as unknown as (input: string, init?: RequestInit) => Promise<Response>, calls, mock: fn };
}
