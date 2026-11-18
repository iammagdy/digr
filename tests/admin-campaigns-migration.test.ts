import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { afterAll, beforeAll } from "vitest";
import { replicaAvailable, startReplica, type ReplicaDb } from "./helpers/replicaDb";

/**
 * DT-20261118-06 phase 2B (Tier A; D-0094 point 2 under D-0093): the campaign tables. Additive only, admin only (RLS on, no policy, nothing for PUBLIC / anon / authenticated),
 * no money object, no address or body column, and one row per person per campaign.
 */
const FILE = join(process.cwd(), "supabase/migrations/20261119010000_admin_campaigns.sql");
const sql = readFileSync(FILE, "utf8");
const code = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").replace(/--.*$/gm, "");

describe("the campaign migration, as text", () => {
  it("only creates: two tables, two indexes, RLS, revoke and grant; nothing is altered, dropped or replaced except enabling RLS on its own tables", () => {
    expect(code).not.toMatch(/\bDROP\b|\bTRUNCATE\b|\bDELETE\b\s+FROM|CREATE\s+OR\s+REPLACE|\bFUNCTION\b|\bTRIGGER\b|\bPOLICY\b/i);
    const alters = code.match(/ALTER TABLE [^;]+;/gi) ?? [];
    expect(alters).toEqual(["ALTER TABLE public.admin_campaigns ENABLE ROW LEVEL SECURITY;", "ALTER TABLE public.admin_campaign_sends ENABLE ROW LEVEL SECURITY;"]);
    expect((code.match(/CREATE TABLE IF NOT EXISTS public\.(\w+)/gi) ?? []).map((s) => s.split(".")[1])).toEqual(["admin_campaigns", "admin_campaign_sends"]);
  });
  it("names no money object and stores no address or body of a customer", () => {
    expect(code).not.toMatch(/credit_ledger|balance|missions|reserve|charge|jobs|topup/i);
    const sendsTable = code.slice(code.indexOf("public.admin_campaign_sends ("), code.indexOf("PRIMARY KEY (campaign_id, user_id)"));
    expect(sendsTable).not.toMatch(/\bemail\b|\baddress\b|\bbody\b|\bhtml\b/i);
  });
  it("revokes everything from PUBLIC, anon, authenticated and gives service_role select, insert and update only", () => {
    expect(code).toContain("REVOKE ALL ON TABLE public.admin_campaigns, public.admin_campaign_sends FROM PUBLIC, anon, authenticated, service_role;");
    expect(code).toContain("GRANT SELECT, INSERT, UPDATE ON TABLE public.admin_campaigns, public.admin_campaign_sends TO service_role;");
    expect(code).not.toMatch(/GRANT[^;]*\b(anon|authenticated|PUBLIC)\b/); // case-sensitive: the schema name «public» is not the role PUBLIC
  });
  it("one row per person per campaign, and the audience is the news opt-in only (D-0094 point 4)", () => {
    expect(code).toContain("PRIMARY KEY (campaign_id, user_id)");
    expect(code).toMatch(/audience text NOT NULL DEFAULT 'news_opt_in' CHECK \(audience IN \('news_opt_in'\)\)/);
  });
});

describe.skipIf(!replicaAvailable())("the campaign migration, applied to a real PostgreSQL with Supabase's default grants", () => {
  let db: ReplicaDb;
  beforeAll(async () => {
    db = await startReplica();
    await db.reset();
    // what Supabase does for every new table in public, and the role it gives the server
    await db.exec("GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role; ALTER ROLE service_role BYPASSRLS;");
    await db.exec(sql);
  }, 90_000);
  afterAll(async () => { await db?.stop(); });
  const asRole = async (role: string, statement: string): Promise<string> => {
    const c = await db.pool.connect();
    try { await c.query("BEGIN"); await c.query(`SET LOCAL ROLE ${role}`); await c.query(statement); return "ok"; }
    catch (e) { return String((e as { code?: string }).code ?? "error"); }
    finally { await c.query("ROLLBACK").catch(() => undefined); c.release(); }
  };
  const insertCampaign = "INSERT INTO public.admin_campaigns (id, name, created_by, updated_by) VALUES ('11111111-1111-1111-1111-111111111111', 'تجربة', gen_random_uuid(), gen_random_uuid())";
  it("anon and authenticated can neither read nor write either table", async () => {
    for (const role of ["anon", "authenticated"]) {
      expect(await asRole(role, "SELECT * FROM public.admin_campaigns"), role).toBe("42501");
      expect(await asRole(role, "SELECT * FROM public.admin_campaign_sends"), role).toBe("42501");
      expect(await asRole(role, insertCampaign), role).toBe("42501");
    }
  });
  it("the server role reads, writes and updates, never deletes; RLS is on for both tables", async () => {
    expect(await asRole("service_role", insertCampaign)).toBe("ok");
    expect(await asRole("service_role", "DELETE FROM public.admin_campaigns")).toBe("42501");
    const rls = await db.pool.query("SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('admin_campaigns','admin_campaign_sends') ORDER BY relname");
    expect(rls.rows).toEqual([{ relname: "admin_campaign_sends", relrowsecurity: true }, { relname: "admin_campaigns", relrowsecurity: true }]);
  });
  it("the same person can never get two rows of one campaign", async () => {
    const r = await asRole("service_role", `${insertCampaign}; INSERT INTO public.admin_campaign_sends (campaign_id, user_id, status) VALUES ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'claimed'), ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'claimed')`);
    expect(r).toBe("23505");
  });
});
