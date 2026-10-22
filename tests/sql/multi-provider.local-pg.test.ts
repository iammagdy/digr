import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createScratchDb, scratchPgTarget, type ScratchDb } from "./localPg";

/**
 * The three SQL PROPOSALS of docs/proposals/multi-provider/ and their rollbacks, run on a real scratch Postgres (set DIGR_TEST_PG; skipped
 * visibly when none is set). Nothing connects to Supabase. The proposals are applied here, never to a real database by this work.
 */
const DIR = path.resolve(__dirname, "../../docs/proposals/multi-provider");
const file = (name: string) => readFileSync(path.join(DIR, name), "utf8");
const ADMIN = "00000000-0000-0000-0000-0000000000a1";
const PLAIN = "00000000-0000-0000-0000-000000000001";
const S = "SET ROLE service_role;";
const CIPHER = "v1.AAAAAAAAAAAAAAAA.BBBBBBBBBBBB.CCCCCCCCCCCCCCCCCCCCCC";

describe.skipIf(!scratchPgTarget())("multi-provider SQL proposals on a real Postgres", () => {
  let db: ScratchDb;
  const setKey = (admin: string, provider: string) => JSON.parse(db.sql(`${S} select public.admin_set_provider_key_atomic('${admin}', '${provider}', '${CIPHER}', 'abcd')`));
  const rollbackKey = (admin: string, provider: string) => JSON.parse(db.sql(`${S} select public.admin_rollback_provider_key_atomic('${admin}', '${provider}')`));
  const setLimits = (admin: string, limits: string) => JSON.parse(db.sql(`${S} select public.admin_set_provider_limits_atomic('${admin}', '${limits}'::jsonb)`));

  beforeAll(() => {
    db = createScratchDb();
    db.sql(`INSERT INTO auth.users (id,email,raw_app_meta_data) VALUES ('${ADMIN}','admin@t','{"role":"admin"}'),('${PLAIN}','plain@t','{}')`);
  }, 120000);
  afterAll(() => db?.drop());

  describe("01 provider key store: two more providers", () => {
    it("before the proposal the new providers are refused", () => {
      expect(setKey(ADMIN, "firecrawl")).toMatchObject({ success: false, error: "invalid_provider" });
      expect(() => db.sql(`insert into provider_api_keys (provider) values ('contextdev')`)).toThrow(/check constraint/);
    });

    it("after it an admin can set, replace and roll back a key of each new provider, with an audit row each time (last 4 only)", () => {
      db.sql(file("01_provider_key_store_new_providers.sql"));
      for (const provider of ["firecrawl", "contextdev"]) {
        expect(setKey(ADMIN, provider)).toMatchObject({ success: true, provider, version: 1, last4: "abcd" });
        expect(setKey(ADMIN, provider)).toMatchObject({ success: true, version: 2 });
        expect(rollbackKey(ADMIN, provider)).toMatchObject({ success: true, version: 3 });
      }
      expect(db.sql("select count(*) from provider_key_audit where provider in ('firecrawl','contextdev')")).toBe("6");
      expect(db.sql("select string_agg(distinct action, ',' order by action) from provider_key_audit where provider='firecrawl'")).toBe("rollback,set");
      // an unknown provider and a non-admin are still refused INSIDE the function
      expect(setKey(ADMIN, "openai")).toMatchObject({ success: false, error: "invalid_provider" });
      expect(setKey(PLAIN, "firecrawl")).toMatchObject({ success: false, error: "not_admin" });
      // the old providers behave exactly as before
      expect(setKey(ADMIN, "treg")).toMatchObject({ success: true, version: 1 });
    });

    it("the functions stay service_role only, security definer, with a pinned search_path", () => {
      const row = db.sql(`select has_function_privilege('anon','public.admin_set_provider_key_atomic(uuid,text,text,text)','execute'), has_function_privilege('authenticated','public.admin_set_provider_key_atomic(uuid,text,text,text)','execute'), has_function_privilege('service_role','public.admin_set_provider_key_atomic(uuid,text,text,text)','execute'), (select prosecdef from pg_proc where proname='admin_set_provider_key_atomic'), (select proconfig::text from pg_proc where proname='admin_set_provider_key_atomic')`);
      expect(row).toMatch(/^f\|f\|t\|t\|\{.*search_path=public, pg_temp.*\}$/);
    });

    it("the audit stays append-only", () => {
      expect(() => db.sql("update provider_key_audit set last4 = 'zzzz'")).toThrow(/append-only/);
      expect(() => db.sql("delete from provider_key_audit")).toThrow(/append-only/);
    });

    it("the rollback restores the two-provider whitelist and keeps the rows already written", () => {
      db.sql(file("01_provider_key_store_new_providers.rollback.sql"));
      expect(setKey(ADMIN, "firecrawl")).toMatchObject({ success: false, error: "invalid_provider" });
      expect(setKey(ADMIN, "anthropic")).toMatchObject({ success: true });
      expect(db.sql("select count(*) from provider_key_audit where provider in ('firecrawl','contextdev')")).toBe("6");
      expect(db.sql("select count(*) from provider_api_keys where provider in ('firecrawl','contextdev')")).toBe("2");
      // and it can be applied again
      db.sql(file("01_provider_key_store_new_providers.sql"));
      expect(setKey(ADMIN, "contextdev")).toMatchObject({ success: true });
    });
  });

  describe("02 per-provider daily limits", () => {
    it("before the proposal the new keys are refused as unknown", () => {
      expect(setLimits(ADMIN, '{"firecrawlDailyUsd": 1}')).toMatchObject({ success: false, error: "unknown_key" });
    });

    it("after it they are validated like the existing daily limit, stored in the same row and audited with old and new value", () => {
      db.sql(file("02_provider_limits_per_provider.sql"));
      expect(setLimits(ADMIN, '{"dailyUsd": 0.8, "firecrawlDailyUsd": 2, "contextdevDailyUsd": 1.5}')).toMatchObject({ success: true, limits: { dailyUsd: 0.8, firecrawlDailyUsd: 2, contextdevDailyUsd: 1.5 } });
      expect(setLimits(ADMIN, '{"firecrawlDailyUsd": -1}').error).toBe("negative");
      expect(setLimits(ADMIN, '{"firecrawlDailyUsd": "x"}').error).toBe("not_a_number");
      expect(setLimits(ADMIN, '{"contextdevDailyUsd": 1e13}').error).toBe("too_large");
      expect(setLimits(ADMIN, '{"other": 1}').error).toBe("unknown_key");
      expect(setLimits(PLAIN, '{"firecrawlDailyUsd": 1}').error).toBe("not_admin");
      expect(JSON.parse(db.sql("select value from settings_private where key='provider_limits'"))).toEqual({ dailyUsd: 0.8, firecrawlDailyUsd: 2, contextdevDailyUsd: 1.5 });
      expect(db.sql("select count(*) from provider_limits_audit")).toBe("1");
      expect(JSON.parse(db.sql("select new_value from provider_limits_audit order by id desc limit 1"))).toMatchObject({ firecrawlDailyUsd: 2 });
    });

    it("the rollback restores the five-key function; saved values stay in the row", () => {
      db.sql(file("02_provider_limits_per_provider.rollback.sql"));
      expect(setLimits(ADMIN, '{"contextdevDailyUsd": 3}').error).toBe("unknown_key");
      expect(setLimits(ADMIN, '{"dailyUsd": 0.9}')).toMatchObject({ success: true });
      expect(JSON.parse(db.sql("select value from settings_private where key='provider_limits'")).firecrawlDailyUsd).toBe(2);
      db.sql(file("02_provider_limits_per_provider.sql"));
    });
  });

  describe("03 provider call metadata", () => {
    const reserve = (provider: string, est: number, cap: number) => JSON.parse(db.sql(`${S} select public.reserve_provider_spend_atomic(NULL, '${provider}', ${est}, ${cap})`));
    const commitV1 = (id: number, cost: number, units: number) => db.sql(`${S} select public.commit_provider_spend(${id}, ${cost}, ${units})`);
    const commitV2 = (id: number, cost: number, units: number, cap: string, status: string, ms: number) => db.sql(`${S} select public.commit_provider_spend_v2(${id}, ${cost}, ${units}, '${cap}', '${status}', ${ms})`);
    let oldRowId: number;
    let moneyBefore: string;

    it("old rows exist before the proposal (written the old way) and the new function does not exist yet", () => {
      const r = reserve("treg", 0.01, 0.8);
      oldRowId = r.cost_id;
      commitV1(r.cost_id, 0.0123, 3);
      moneyBefore = db.sql("select coalesce(sum(cost_usd),0)::text || '|' || count(*) from provider_costs");
      expect(() => commitV2(r.cost_id, 0, 0, "x", "failed", 1)).toThrow(/does not exist/);
    });

    it("after it a reserved estimate is committed with its capability, status and duration; failed and empty calls are recorded with cost 0", () => {
      db.sql(file("03_provider_costs_call_metadata.sql"));
      const ok = reserve("firecrawl", 0.005, 1);
      commitV2(ok.cost_id, 0.005, 1, "firecrawl.scrape", "success", 420);
      const failed = reserve("firecrawl", 0.005, 1);
      commitV2(failed.cost_id, 0, 0, "firecrawl.scrape", "failed", 15);
      const empty = reserve("contextdev", 0.00254, 1);
      commitV2(empty.cost_id, 0, 0, "contextdev.search", "empty", 33);
      const rows = db.sql("select provider, capability, status, duration_ms, cost_usd::text, units, is_estimate from provider_costs where provider in ('firecrawl','contextdev') order by id").split("\n");
      expect(rows).toEqual(["firecrawl|firecrawl.scrape|success|420|0.005|1|f", "firecrawl|firecrawl.scrape|failed|15|0|0|f", "contextdev|contextdev.search|empty|33|0|0|f"]);
      // the old row is untouched: its metadata is NULL
      expect(db.sql(`select capability is null and status is null and duration_ms is null from provider_costs where id=${oldRowId}`)).toBe("t");
    });

    it("the daily cap is per provider: another provider's rows never count against it", () => {
      expect(reserve("firecrawl", 0.5, 0.51)).toMatchObject({ allowed: true });
      expect(reserve("firecrawl", 0.5, 0.51)).toMatchObject({ allowed: false });
      // TREG's 0.0123 and Context.dev's rows are not in firecrawl's sum
      expect(reserve("contextdev", 0.5, 0.51)).toMatchObject({ allowed: true });
      expect(Number(reserve("treg", 0.001, 0.8).current_spend)).toBeGreaterThan(0.0123);
    });

    it("a committed row cannot be committed again, a bad status or a negative cost is refused, and the cost is never negative", () => {
      const r = reserve("contextdev", 0.001, 5);
      commitV2(r.cost_id, 0.001, 1, "contextdev.scrape", "success", 10);
      expect(() => commitV2(r.cost_id, 0.5, 9, "contextdev.scrape", "success", 10)).toThrow(/not found or already committed/);
      const r2 = reserve("contextdev", 0.001, 5);
      expect(() => commitV2(r2.cost_id, 0.001, 1, "x", "weird", 10)).toThrow(/status must be/);
      expect(() => commitV2(r2.cost_id, -1, 1, "x", "failed", 10)).toThrow(/must not be negative/);
      expect(() => commitV2(999999, 0, 0, "x", "failed", 1)).toThrow(/not found or already committed/);
      expect(() => db.sql(`update provider_costs set status='nope' where id=${r2.cost_id}`)).toThrow(/check constraint/);
    });

    it("the new function is service_role only (not anon, not authenticated, not PUBLIC) and the table cannot be written directly by them", () => {
      const sig = "public.commit_provider_spend_v2(bigint,numeric,integer,text,text,integer)";
      expect(db.sql(`select has_function_privilege('anon','${sig}','execute'), has_function_privilege('authenticated','${sig}','execute'), has_function_privilege('service_role','${sig}','execute'), (select prosecdef from pg_proc where proname='commit_provider_spend_v2')`)).toBe("f|f|t|t");
      expect(() => db.sql("SET ROLE authenticated; insert into provider_costs (provider, cost_usd) values ('firecrawl', 1)")).toThrow(/permission denied/);
      expect(() => db.sql("SET ROLE anon; update provider_costs set cost_usd = 0")).toThrow(/permission denied/);
    });

    it("the rollback removes the function and the columns and changes no money figure", () => {
      const before = db.sql("select coalesce(sum(cost_usd),0)::text || '|' || count(*) from provider_costs");
      db.sql(file("03_provider_costs_call_metadata.rollback.sql"));
      expect(db.sql("select count(*) from information_schema.columns where table_name='provider_costs' and column_name in ('capability','status','duration_ms')")).toBe("0");
      expect(() => commitV2(1, 0, 0, "x", "failed", 1)).toThrow(/does not exist/);
      expect(db.sql("select coalesce(sum(cost_usd),0)::text || '|' || count(*) from provider_costs")).toBe(before);
      expect(before.split("|")[1]).not.toBe(moneyBefore.split("|")[1]);
      // the old path still works
      const r = reserve("firecrawl", 0.001, 100);
      expect(() => commitV1(r.cost_id, 0.001, 1)).not.toThrow();
      // applying again works
      db.sql(file("03_provider_costs_call_metadata.sql"));
    });
  });
});
