import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { NextRequest, NextResponse } from "next/server";
import { scopedFlagOn } from "../src/lib/agentMission/scopedFlag";
import {
  ACCEPTANCE_CAMPAIGN_KEY, ACCEPTANCE_FLAG_KEYS, CAMPAIGN_CEILING_USD, CHAT_RESEARCH_BRIEF_KEY, L4_FLAG_KEYS, PRODUCTION_BUDGET_GUARANTEE,
  SEMANTIC_NORMALIZATION_KEY, campaignStatus, restoreCampaign, startCampaign, type CampaignBudgetGuarantee,
} from "../src/lib/agentMission/acceptance/campaign";
import { B2B_ACCEPTANCE_REQUEST_AR, SCENARIOS, SCENARIOS_TOTAL_USD } from "../src/lib/agentMission/acceptance/scenarios";
import { loadAcceptanceSpend } from "../src/lib/agentMission/adminActions";
import { resolveAcceptanceAccount } from "../src/app/api/admin/acceptance/account";
import { createScenarioMission } from "../src/lib/agentMission/acceptance/run";
import { AGENT_TEST_ACCOUNT_EMAIL } from "../src/lib/agentMission/constants";

/**
 * LIVE ACCEPTANCE CAMPAIGNS (docs/intelligence/ACCEPTANCE-WORKFLOW.md). Everything here is offline: an in-memory `agent_settings` / `profiles` / `missions` with the real primary-key rule (a second insert of a key
 * fails 23505, atomically) and injectable failures. No provider, no model, no network.
 */
vi.stubGlobal("fetch", () => { throw new Error("a real network call was attempted"); });

const TEST_ID = "b0d08be8-db61-4860-841e-fa963045557e";
const OTHER_ID = "11111111-2222-4333-8444-555555555555";
const ENFORCEABLE: CampaignBudgetGuarantee = { enforceable: true, ceilingUsd: 0.3, reasons: [] };
const T0 = Date.parse("2026-11-14T12:00:00Z");
const ACCOUNT = { id: TEST_ID };

type Row = { key: string; value: unknown; updated_at?: string; updated_by?: string };
function fakeDb(opts: { testAccount?: { id: string; email: string } | null; settings?: Row[] } = {}) {
  const settings = new Map<string, Row>((opts.settings ?? [{ key: "redesign_flags", value: { companies: "test" } }, { key: "social_discovery", value: "test" }]).map((r) => [r.key, r]));
  const missions: Array<Record<string, unknown>> = [];
  const fail = { insert: new Set<string>(), delete: new Set<string>(), silentDelete: new Set<string>(), read: false };
  const inserts: string[] = [];
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const account = opts.testAccount === undefined ? { id: TEST_ID, email: AGENT_TEST_ACCOUNT_EMAIL } : opts.testAccount;
  const client = {
    from(table: string) {
      if (table === "profiles") {
        return { select: () => ({ eq: (_c: string, email: string) => ({ maybeSingle: async () => ({ data: account && account.email === email ? account : null, error: null }) }) }) };
      }
      if (table === "missions") {
        return {
          insert: async (row: Record<string, unknown>) => { missions.push(row); return { error: null }; },
          select: () => {
            const q: any = { eq: () => q, gte: () => q, order: () => q, limit: async () => ({ data: missions, error: null }) };
            return q;
          },
        };
      }
      if (table !== "agent_settings") throw new Error(`unexpected table ${table}`);
      return {
        select: () => ({
          in: async (_c: string, keys: string[]) => { await tick(); if (fail.read) return { data: null, error: { message: "down" } }; return { data: keys.filter((k) => settings.has(k)).map((k) => ({ key: k, value: structuredClone(settings.get(k)!.value) })), error: null }; },
        }),
        insert: async (row: Row) => {
          await tick();
          if (fail.insert.has(row.key)) return { error: { message: "write failed" } };
          // the primary key, atomically (no await between the check and the write)
          if (settings.has(row.key)) return { error: { code: "23505", message: "duplicate key" } };
          settings.set(row.key, structuredClone(row));
          inserts.push(row.key);
          return { error: null };
        },
        delete: () => ({ eq: async (_c: string, key: string) => { await tick(); if (fail.delete.has(key)) return { error: { message: "delete failed" } }; if (!fail.silentDelete.has(key)) settings.delete(key); return { error: null }; } }),
        upsert: () => { throw new Error("the campaign never upserts"); },
        update: () => { throw new Error("the campaign never updates"); },
      };
    },
  };
  const snapshot = () => JSON.stringify([...settings.entries()].sort().map(([k, r]) => [k, r.value]));
  return { client, settings, missions, fail, inserts, snapshot };
}

describe("scopedFlagOn: an expiring scoped value (the campaign's automatic switch-off)", () => {
  const v = { user_ids: [TEST_ID], expires_at: new Date(T0 + 60_000).toISOString() };
  it("ON for the listed account before expires_at, OFF from that instant, OFF for everyone else, OFF for an unreadable time", () => {
    expect(scopedFlagOn(v, TEST_ID, T0)).toBe(true);
    expect(scopedFlagOn(v, TEST_ID, T0 + 59_999)).toBe(true);
    expect(scopedFlagOn(v, TEST_ID, T0 + 60_000)).toBe(false);
    expect(scopedFlagOn(v, TEST_ID, T0 + 3_600_000)).toBe(false);
    expect(scopedFlagOn(v, OTHER_ID, T0)).toBe(false);
    expect(scopedFlagOn(v, null, T0)).toBe(false);
    for (const bad of ["soon", "", 123, null, {}, []]) expect(scopedFlagOn({ user_ids: [TEST_ID], expires_at: bad }, TEST_ID, T0), String(bad)).toBe(false);
  });
  it("a value WITHOUT expires_at reads exactly as before (true / \"on\" for all, user_ids for those ids, anything else off)", () => {
    expect(scopedFlagOn(true, OTHER_ID)).toBe(true);
    expect(scopedFlagOn("on", null)).toBe(true);
    expect(scopedFlagOn({ user_ids: [TEST_ID] }, TEST_ID)).toBe(true);
    expect(scopedFlagOn({ user_ids: [TEST_ID] }, OTHER_ID)).toBe(false);
    for (const off of [false, "off", "test", undefined, null, 1, "ON "]) expect(scopedFlagOn(off, TEST_ID)).toBe(false);
  });
});

describe("the budget gate: no switch and no paid mission while the hard ceiling is not enforceable", () => {
  it("PRODUCTION today: not enforceable, with the three audited reasons; a start writes NOTHING", async () => {
    expect(PRODUCTION_BUDGET_GUARANTEE).toEqual({ enforceable: false, ceilingUsd: null, reasons: ["model_calls_not_reserved", "provider_caps_shared_and_estimated", "no_aggregate_ledger"] });
    expect(Object.isFrozen(PRODUCTION_BUDGET_GUARANTEE)).toBe(true);
    const db = fakeDb();
    const before = db.snapshot();
    const r = await startCampaign(db.client, { account: ACCOUNT, adminId: "adm", keys: [...L4_FLAG_KEYS], minutes: 60, budget: PRODUCTION_BUDGET_GUARANTEE, nowMs: T0 });
    expect(r).toMatchObject({ ok: false, status: 409, error: "budget_not_enforceable", detail: PRODUCTION_BUDGET_GUARANTEE.reasons });
    expect(db.inserts).toEqual([]);
    expect(db.snapshot()).toBe(before);
  });
  it("PRODUCTION today: no L3 or L4 mission can be created (planning itself spends)", async () => {
    const db = fakeDb();
    for (const scenario of ["L3", "L4"]) expect(await createScenarioMission(db.client, { account: ACCOUNT, adminId: "adm", scenario, budget: PRODUCTION_BUDGET_GUARANTEE, nowMs: T0 })).toMatchObject({ ok: false, error: "budget_not_enforceable" });
    expect(db.missions).toHaveLength(0);
  });
  it("an 'enforceable' guarantee above the approved $0.30, with no ceiling, or not literally true, is refused too", async () => {
    for (const budget of [{ enforceable: true, ceilingUsd: 0.31, reasons: [] }, { enforceable: true, ceilingUsd: null, reasons: [] }, { enforceable: true, ceilingUsd: 0, reasons: [] }, { enforceable: "yes" as unknown as boolean, ceilingUsd: 0.3, reasons: [] }]) {
      const db = fakeDb();
      expect(await startCampaign(db.client, { account: ACCOUNT, adminId: "adm", keys: [...L4_FLAG_KEYS], minutes: 60, budget, nowMs: T0 })).toMatchObject({ ok: false, error: "budget_not_enforceable" });
      expect(await createScenarioMission(db.client, { account: ACCOUNT, adminId: "adm", scenario: "L3", budget, nowMs: T0 })).toMatchObject({ ok: false, error: "budget_not_enforceable" });
      expect(db.inserts).toEqual([]);
      expect(db.missions).toHaveLength(0);
    }
  });
});

describe("a campaign (with an enforceable ceiling, as it will be once the spend gate is approved)", () => {
  it("turns on exactly the chosen keys, for the designated test account only, until expires_at; no other account can see them", async () => {
    const db = fakeDb();
    const r = await startCampaign(db.client, { account: ACCOUNT, adminId: "adm", keys: [...L4_FLAG_KEYS], minutes: 90, budget: ENFORCEABLE, nowMs: T0 });
    expect(r.ok).toBe(true);
    const expiresAt = new Date(T0 + 90 * 60_000).toISOString();
    for (const k of L4_FLAG_KEYS) expect(db.settings.get(k)!.value).toEqual({ user_ids: [TEST_ID], expires_at: expiresAt });
    expect(db.settings.has("chat_research_brief_v1")).toBe(false);
    expect(db.settings.has("web_via_treg")).toBe(false);
    expect(db.settings.get(ACCEPTANCE_CAMPAIGN_KEY)!.value).toMatchObject({ v: 1, account_id: TEST_ID, keys: L4_FLAG_KEYS, started_by: "adm", expires_at: expiresAt, ceiling_usd: 0.3 });
    const s: any = await campaignStatus(db.client, ACCOUNT, T0 + 1000);
    expect(s.isolated).toBe(true);
    expect(s.flags.filter((f: any) => f.onForTestAccount).map((f: any) => f.key).sort()).toEqual([...L4_FLAG_KEYS].sort());
    expect(s.flags.some((f: any) => f.onForOthers)).toBe(false);
    for (const k of L4_FLAG_KEYS) expect(scopedFlagOn(db.settings.get(k)!.value, OTHER_ID, T0 + 1000)).toBe(false);
    // AUTOMATIC switch-off: at expires_at nothing is on for anybody, before anyone restores
    const later: any = await campaignStatus(db.client, ACCOUNT, T0 + 90 * 60_000);
    expect(later.campaign.expired).toBe(true);
    expect(later.flags.some((f: any) => f.onForTestAccount || f.onForOthers)).toBe(false);
  });

  it("no designated test account: refused, nothing written", async () => {
    const db = fakeDb();
    expect(await startCampaign(db.client, { account: null, adminId: "adm", keys: [...L4_FLAG_KEYS], minutes: 60, budget: ENFORCEABLE, nowMs: T0 })).toMatchObject({ ok: false, status: 404, error: "test_account_missing" });
    expect(await createScenarioMission(db.client, { account: null, adminId: "adm", scenario: "L3", budget: ENFORCEABLE, nowMs: T0 })).toMatchObject({ ok: false, status: 404, error: "test_account_missing" });
    expect(db.inserts).toEqual([]);
    expect(db.missions).toHaveLength(0);
  });

  it("the campaign account is the console's test account AND a test account by the shared classifier (defence in depth); the real lookup reads the console's profile", async () => {
    expect(await resolveAcceptanceAccount({}, async () => ({ id: TEST_ID, email: "customer@example.com" }))).toBeNull();
    expect(await resolveAcceptanceAccount({}, async () => ({ id: OTHER_ID, email: "someone@gmail.com" }))).toBeNull();
    expect(await resolveAcceptanceAccount({}, async () => { throw new Error("down"); })).toBeNull();
    expect(await resolveAcceptanceAccount({}, async () => null)).toBeNull();
    expect(await resolveAcceptanceAccount({}, async () => ({ id: ` ${TEST_ID.toUpperCase()} `, email: AGENT_TEST_ACCOUNT_EMAIL }))).toEqual({ id: TEST_ID });
    expect(await resolveAcceptanceAccount(fakeDb().client)).toEqual({ id: TEST_ID });
    expect(await resolveAcceptanceAccount(fakeDb({ testAccount: null }).client)).toBeNull();
    expect(await resolveAcceptanceAccount(fakeDb({ testAccount: { id: TEST_ID, email: "customer@example.com" } }).client)).toBeNull();
  });

  it("only the six named keys, each once, and 10 to 180 whole minutes", async () => {
    const db = fakeDb();
    for (const keys of [[], ["redesign_flags"], ["mission_pricing"], ["multi_stage_engine", "multi_stage_engine"], "multi_stage_engine", null, [...ACCEPTANCE_FLAG_KEYS, "x"]]) {
      expect(await startCampaign(db.client, { account: ACCOUNT, adminId: "adm", keys, minutes: 60, budget: ENFORCEABLE, nowMs: T0 }), JSON.stringify(keys)).toMatchObject({ ok: false, status: 400, error: "bad_keys" });
    }
    for (const minutes of [9, 181, 10.5, "60", null, -1]) {
      expect(await startCampaign(db.client, { account: ACCOUNT, adminId: "adm", keys: ["multi_stage_engine"], minutes, budget: ENFORCEABLE, nowMs: T0 }), String(minutes)).toMatchObject({ ok: false, status: 400, error: "bad_minutes" });
    }
    expect(db.inserts).toEqual([]);
    expect((await startCampaign(db.client, { account: ACCOUNT, adminId: "adm", keys: [...ACCEPTANCE_FLAG_KEYS], minutes: 10, budget: ENFORCEABLE, nowMs: T0 })).ok).toBe(true);
  });

  it("an owner's existing setting of a key is never overwritten: the start is refused and that value is intact", async () => {
    const db = fakeDb({ settings: [{ key: "multi_stage_engine", value: "on" }] });
    expect(await startCampaign(db.client, { account: ACCOUNT, adminId: "adm", keys: [...L4_FLAG_KEYS], minutes: 60, budget: ENFORCEABLE, nowMs: T0 })).toMatchObject({ ok: false, status: 409, error: "key_already_set", detail: ["multi_stage_engine"] });
    expect(db.settings.get("multi_stage_engine")!.value).toBe("on");
    expect(db.inserts).toEqual([]);
  });

  it("CONCURRENT starts by two admins: exactly one campaign; the other writes nothing", async () => {
    const db = fakeDb();
    const results = await Promise.all([
      startCampaign(db.client, { account: ACCOUNT, adminId: "adm1", keys: [...L4_FLAG_KEYS], minutes: 60, budget: ENFORCEABLE, nowMs: T0 }),
      startCampaign(db.client, { account: ACCOUNT, adminId: "adm2", keys: [...ACCEPTANCE_FLAG_KEYS], minutes: 120, budget: ENFORCEABLE, nowMs: T0 }),
      startCampaign(db.client, { account: ACCOUNT, adminId: "adm3", keys: ["web_via_treg"], minutes: 30, budget: ENFORCEABLE, nowMs: T0 }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).every((r: any) => r.status === 409 && r.error === "campaign_active")).toBe(true);
    const winner: any = results.find((r) => r.ok);
    expect(db.inserts.filter((k) => k === ACCEPTANCE_CAMPAIGN_KEY)).toHaveLength(1);
    expect(db.inserts.filter((k) => k !== ACCEPTANCE_CAMPAIGN_KEY).sort()).toEqual([...winner.record.keys].sort());
    // a start while one is active is refused too
    expect(await startCampaign(db.client, { account: ACCOUNT, adminId: "adm4", keys: ["web_via_treg"], minutes: 30, budget: ENFORCEABLE, nowMs: T0 })).toMatchObject({ error: "campaign_active" });
  });

  it("FAILURE half way through a start: what it wrote is removed, then the lock; the settings are exactly as before", async () => {
    const db = fakeDb();
    const before = db.snapshot();
    db.fail.insert.add(L4_FLAG_KEYS[2]);
    expect(await startCampaign(db.client, { account: ACCOUNT, adminId: "adm", keys: [...L4_FLAG_KEYS], minutes: 60, budget: ENFORCEABLE, nowMs: T0 })).toMatchObject({ ok: false, status: 503, error: "settings_write_failed" });
    expect(db.snapshot()).toBe(before);
  });

  it("FAILURE of the undo itself: reported, the lock is KEPT (so the screen shows it and a restore finishes it), and the leftovers still switch themselves off at expiry", async () => {
    const db = fakeDb();
    const before = db.snapshot();
    db.fail.insert.add(L4_FLAG_KEYS[2]);
    db.fail.delete.add(L4_FLAG_KEYS[0]);
    const r: any = await startCampaign(db.client, { account: ACCOUNT, adminId: "adm", keys: [...L4_FLAG_KEYS], minutes: 60, budget: ENFORCEABLE, nowMs: T0 });
    expect(r).toMatchObject({ ok: false, error: "start_failed_rollback_incomplete", detail: [L4_FLAG_KEYS[0]] });
    expect(db.settings.has(ACCEPTANCE_CAMPAIGN_KEY)).toBe(true);
    expect(scopedFlagOn(db.settings.get(L4_FLAG_KEYS[0])!.value, TEST_ID, T0 + 60 * 60_000)).toBe(false);
    db.fail.delete.clear();
    expect((await restoreCampaign(db.client)).ok).toBe(true);
    expect(db.snapshot()).toBe(before);
  });

  it("a settings read that fails refuses the start and the restore (nothing is assumed)", async () => {
    const db = fakeDb();
    db.fail.read = true;
    expect(await startCampaign(db.client, { account: ACCOUNT, adminId: "adm", keys: [...L4_FLAG_KEYS], minutes: 60, budget: ENFORCEABLE, nowMs: T0 })).toMatchObject({ ok: false, status: 503, error: "settings_unreadable" });
    expect(await restoreCampaign(db.client)).toMatchObject({ ok: false, status: 503 });
    expect(await campaignStatus(db.client, ACCOUNT, T0)).toMatchObject({ ok: false, status: 503 });
    expect(db.inserts).toEqual([]);
  });
});

describe("restore: exact, verified, idempotent", () => {
  it("restores the EXACT initial settings (unrelated keys untouched throughout), and a second restore is a no-op", async () => {
    const db = fakeDb();
    const before = db.snapshot();
    expect((await startCampaign(db.client, { account: ACCOUNT, adminId: "adm", keys: [...ACCEPTANCE_FLAG_KEYS], minutes: 60, budget: ENFORCEABLE, nowMs: T0 })).ok).toBe(true);
    expect(db.settings.get("redesign_flags")!.value).toEqual({ companies: "test" });
    const r: any = await restoreCampaign(db.client);
    expect(r).toMatchObject({ ok: true, already: false });
    expect([...r.removed].sort()).toEqual([...ACCEPTANCE_FLAG_KEYS].sort());
    expect(db.snapshot()).toBe(before);
    expect(await restoreCampaign(db.client)).toEqual({ ok: true, removed: [], already: true });
    const s: any = await campaignStatus(db.client, ACCOUNT, T0);
    expect(s.campaign).toBeNull();
    expect(s.flags.every((f: any) => !f.set)).toBe(true);
  });

  it("works after expiry too (the expired values are removed, not just ignored)", async () => {
    const db = fakeDb();
    const before = db.snapshot();
    await startCampaign(db.client, { account: ACCOUNT, adminId: "adm", keys: [...L4_FLAG_KEYS], minutes: 10, budget: ENFORCEABLE, nowMs: T0 });
    expect((await restoreCampaign(db.client)).ok).toBe(true);
    expect(db.snapshot()).toBe(before);
  });

  it("a key somebody CHANGED during the campaign is theirs: kept, reported, and the lock stays until it is resolved", async () => {
    const db = fakeDb();
    await startCampaign(db.client, { account: ACCOUNT, adminId: "adm", keys: [...L4_FLAG_KEYS], minutes: 60, budget: ENFORCEABLE, nowMs: T0 });
    db.settings.set("registry_router", { key: "registry_router", value: "on" });
    const r = await restoreCampaign(db.client);
    expect(r).toMatchObject({ ok: false, status: 409, error: "restore_conflict", detail: ["registry_router"] });
    expect(db.settings.get("registry_router")!.value).toBe("on");
    for (const k of L4_FLAG_KEYS.filter((k) => k !== "registry_router")) expect(db.settings.has(k)).toBe(false);
    expect(db.settings.has(ACCEPTANCE_CAMPAIGN_KEY)).toBe(true);
  });

  it("a delete that fails: 503 restore_incomplete naming the key, the lock is kept; retrying after the failure clears it", async () => {
    const db = fakeDb();
    const before = db.snapshot();
    await startCampaign(db.client, { account: ACCOUNT, adminId: "adm", keys: [...L4_FLAG_KEYS], minutes: 60, budget: ENFORCEABLE, nowMs: T0 });
    db.fail.delete.add("multi_stage_engine");
    expect(await restoreCampaign(db.client)).toMatchObject({ ok: false, status: 503, error: "restore_incomplete", detail: ["multi_stage_engine"] });
    expect(db.settings.has(ACCEPTANCE_CAMPAIGN_KEY)).toBe(true);
    db.fail.delete.clear();
    expect((await restoreCampaign(db.client)).ok).toBe(true);
    expect(db.snapshot()).toBe(before);
  });

  it("a delete that reports success but removes nothing (e.g. a row policy) is caught by the re-read: not «restored»", async () => {
    const db = fakeDb();
    await startCampaign(db.client, { account: ACCOUNT, adminId: "adm", keys: [...L4_FLAG_KEYS], minutes: 60, budget: ENFORCEABLE, nowMs: T0 });
    db.fail.silentDelete.add("registry_router");
    expect(await restoreCampaign(db.client)).toMatchObject({ ok: false, status: 503, error: "restore_incomplete", detail: ["registry_router"] });
    expect(db.settings.has(ACCEPTANCE_CAMPAIGN_KEY)).toBe(true);
  });

  it("the lock row is removed LAST: if it cannot be removed the restore says so", async () => {
    const db = fakeDb();
    await startCampaign(db.client, { account: ACCOUNT, adminId: "adm", keys: ["multi_stage_engine"], minutes: 60, budget: ENFORCEABLE, nowMs: T0 });
    db.fail.delete.add(ACCEPTANCE_CAMPAIGN_KEY);
    expect(await restoreCampaign(db.client)).toMatchObject({ ok: false, error: "restore_incomplete", detail: [ACCEPTANCE_CAMPAIGN_KEY] });
    expect(db.settings.has("multi_stage_engine")).toBe(false);
  });
});

describe("scenario missions: through the existing admin console action, with preconditions only", () => {
  it("L3 runs flags-OFF: refused while any Intelligence switch is on for the test account; otherwise one queued mission for the test account with the exact request", async () => {
    const db = fakeDb();
    await startCampaign(db.client, { account: ACCOUNT, adminId: "adm", keys: ["multi_stage_engine"], minutes: 60, budget: ENFORCEABLE, nowMs: T0 });
    expect(await createScenarioMission(db.client, { account: ACCOUNT, adminId: "adm", scenario: "L3", budget: ENFORCEABLE, nowMs: T0 })).toMatchObject({ ok: false, error: "intelligence_on", detail: ["multi_stage_engine"] });
    await restoreCampaign(db.client);
    const r = await createScenarioMission(db.client, { account: ACCOUNT, adminId: "adm", scenario: "L3", budget: ENFORCEABLE, nowMs: T0 });
    expect(r).toMatchObject({ ok: true, scenario: "L3" });
    expect(db.missions).toHaveLength(1);
    expect(db.missions[0]).toMatchObject({ user_id: TEST_ID, created_by: "adm", request_text: B2B_ACCEPTANCE_REQUEST_AR, status: "queued" });
    // NOT approved, NOT reserved: the money path is untouched (the admin approves the priced plan later, through the shared quote path)
    expect(Object.keys(db.missions[0]).sort()).toEqual(["created_by", "id", "request_text", "status", "user_id"]);
  });

  it("L4 needs a live, isolated campaign with every L4 switch on; refused without one, after expiry, or when a switch is on for everybody", async () => {
    const db = fakeDb();
    expect(await createScenarioMission(db.client, { account: ACCOUNT, adminId: "adm", scenario: "L4", budget: ENFORCEABLE, nowMs: T0 })).toMatchObject({ ok: false, error: "campaign_not_active" });
    await startCampaign(db.client, { account: ACCOUNT, adminId: "adm", keys: ["multi_stage_engine"], minutes: 60, budget: ENFORCEABLE, nowMs: T0 });
    expect(await createScenarioMission(db.client, { account: ACCOUNT, adminId: "adm", scenario: "L4", budget: ENFORCEABLE, nowMs: T0 })).toMatchObject({ ok: false, error: "campaign_not_active" });
    await restoreCampaign(db.client);
    await startCampaign(db.client, { account: ACCOUNT, adminId: "adm", keys: [...L4_FLAG_KEYS], minutes: 60, budget: ENFORCEABLE, nowMs: T0 });
    expect(await createScenarioMission(db.client, { account: ACCOUNT, adminId: "adm", scenario: "L4", budget: ENFORCEABLE, nowMs: T0 + 1000 })).toMatchObject({ ok: true, scenario: "L4" });
    expect(await createScenarioMission(db.client, { account: ACCOUNT, adminId: "adm", scenario: "L4", budget: ENFORCEABLE, nowMs: T0 + 61 * 60_000 })).toMatchObject({ ok: false, error: "campaign_not_active" });
    db.settings.set("web_via_treg", { key: "web_via_treg", value: "on" });
    expect(await createScenarioMission(db.client, { account: ACCOUNT, adminId: "adm", scenario: "L4", budget: ENFORCEABLE, nowMs: T0 + 1000 })).toMatchObject({ ok: false, error: "not_isolated" });
    expect(db.missions).toHaveLength(1);
  });

  it("L4 follows the CAMPAIGN's expiry even if a value claims a later one", async () => {
    const db = fakeDb();
    await startCampaign(db.client, { account: ACCOUNT, adminId: "adm", keys: [...L4_FLAG_KEYS], minutes: 60, budget: ENFORCEABLE, nowMs: T0 });
    const later = new Date(T0 + 5 * 3_600_000).toISOString();
    for (const k of L4_FLAG_KEYS) db.settings.set(k, { key: k, value: { user_ids: [TEST_ID], expires_at: later } });
    expect(await createScenarioMission(db.client, { account: ACCOUNT, adminId: "adm", scenario: "L4", budget: ENFORCEABLE, nowMs: T0 + 2 * 3_600_000 })).toMatchObject({ ok: false, error: "campaign_not_active" });
    expect(db.missions).toHaveLength(0);
  });

  it("L1 and L2 are never created here; unknown scenarios are refused", async () => {
    const db = fakeDb();
    for (const scenario of ["L1", "L2", "L5", null, { id: "L3" }]) expect(await createScenarioMission(db.client, { account: ACCOUNT, adminId: "adm", scenario, budget: ENFORCEABLE, nowMs: T0 })).toMatchObject({ ok: false, status: 400, error: "bad_scenario" });
    expect(db.missions).toHaveLength(0);
  });

  it("the scenarios' ceilings fit in the approved $0.30; the request needs no personal identifier", () => {
    expect(CAMPAIGN_CEILING_USD).toBe(0.3);
    expect(SCENARIOS_TOTAL_USD).toBeLessThanOrEqual(CAMPAIGN_CEILING_USD + 1e-12);
    expect(SCENARIOS.map((s) => s.id)).toEqual(["L1", "L2", "L3", "L4"]);
    expect(SCENARIOS.filter((s) => s.route === "reverse_lookup").every((s) => s.requestAr === null)).toBe(true);
    expect(B2B_ACCEPTANCE_REQUEST_AR).not.toMatch(/@|\+?\d{7,}/);
  });

  it("campaign spend adds every mission's model and source spend; an unreadable table is not a zero", async () => {
    const db = fakeDb();
    db.missions.push({ id: "m1", status: "completed", created_at: "x", planning_llm_usd: "0.01", execution_llm_usd: 0.002, planning_treg_usd: "0.003", execution_treg_usd: 0.004, reserved_points: 100, charged_points: 50 });
    db.missions.push({ id: "m2", status: "plan_ready", created_at: "y", planning_llm_usd: 0.02, execution_llm_usd: null, planning_treg_usd: 0.001, execution_treg_usd: null, reserved_points: null, charged_points: null, addon: { kind: "edit" } });
    const r: any = await loadAcceptanceSpend(db.client, TEST_ID, "2026-11-14T00:00:00Z");
    expect(r.ok).toBe(true);
    expect(r.totalUsd).toBeCloseTo(0.04, 9);
    expect(r.missions[1]).toMatchObject({ reserved_points: null, charged_points: null, execution_llm_usd: 0, is_addon: true });
    // an add-on row's spend counts; the marker column itself is not returned
    expect("addon" in r.missions[1]).toBe(false);
    expect("is_addon" in r.missions[0]).toBe(false);
    const broken = { from: () => ({ select: () => { const q: any = { eq: () => q, gte: () => q, order: () => q, limit: async () => ({ data: null, error: { message: "x" } }) }; return q; } }) };
    expect(await loadAcceptanceSpend(broken, TEST_ID, "x")).toEqual({ ok: false });
  });
});

// ------------------------------------------------------------------------------------------------ the admin route
const routeState: { admin: boolean; db: ReturnType<typeof fakeDb>; audit: ReturnType<typeof vi.fn> } = { admin: true, db: fakeDb(), audit: vi.fn(async () => undefined) };
vi.mock("../src/lib/server/adminAuth", () => ({
  authenticateAdmin: vi.fn(async () => (routeState.admin ? { ok: true, ctx: { adminId: "adm-1", audit: routeState.audit } } : { ok: false, response: NextResponse.json({ error: "forbidden" }, { status: 403 }) })),
}));
vi.mock("../src/lib/supabase/server", () => ({ createAdminClient: () => routeState.db.client, createServerSideClient: vi.fn() }));

describe("the admin route /api/admin/acceptance", () => {
  beforeEach(() => { routeState.admin = true; routeState.db = fakeDb(); routeState.audit = vi.fn(async () => undefined); });
  const post = async (body: unknown) => { const { POST } = await import("../src/app/api/admin/acceptance/route"); return POST(new NextRequest("http://x/api/admin/acceptance", { method: "POST", body: JSON.stringify(body) })); };
  const get = async () => { const { GET } = await import("../src/app/api/admin/acceptance/route"); return GET(new NextRequest("http://x/api/admin/acceptance")); };

  it("AUTH: a non-admin gets the auth refusal for GET and every POST action, and nothing is read, written or audited", async () => {
    routeState.admin = false;
    expect((await get()).status).toBe(403);
    for (const action of ["start", "restore", "create_scenario"]) expect((await post({ action, keys: [...L4_FLAG_KEYS], minutes: 60, scenario: "L3" })).status).toBe(403);
    expect(routeState.db.inserts).toEqual([]);
    expect(routeState.audit).not.toHaveBeenCalled();
  });

  it("START in production is refused (the ceiling is not enforceable), nothing is written, and the refusal is audited", async () => {
    const before = routeState.db.snapshot();
    const res = await post({ action: "start", keys: [...L4_FLAG_KEYS], minutes: 60 });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "budget_not_enforceable", detail: PRODUCTION_BUDGET_GUARANTEE.reasons });
    expect(routeState.db.snapshot()).toBe(before);
    expect(routeState.audit).toHaveBeenCalledWith("acceptance", "رفض بدء حملة قبول", expect.stringContaining("budget_not_enforceable"), { targetType: "agent_settings", targetId: "acceptance_campaign" });
  });

  it("CREATE_SCENARIO in production is refused, no mission is created, the refusal is audited", async () => {
    const res = await post({ action: "create_scenario", scenario: "L3" });
    expect(res.status).toBe(409);
    expect(routeState.db.missions).toHaveLength(0);
    expect(routeState.audit).toHaveBeenCalledWith("acceptance", "رفض إنشاء مهمة قبول", expect.stringContaining("budget_not_enforceable"), expect.anything());
  });

  it("RESTORE works in production (removing a campaign never spends) and is audited; with nothing active it is a no-op", async () => {
    // a campaign left by an earlier start (written directly here, as the route itself cannot start one today)
    await startCampaign(routeState.db.client, { account: ACCOUNT, adminId: "adm", keys: [...L4_FLAG_KEYS], minutes: 60, budget: ENFORCEABLE, nowMs: Date.now() });
    const res = await post({ action: "restore" });
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    for (const k of [...L4_FLAG_KEYS, ACCEPTANCE_CAMPAIGN_KEY]) expect(routeState.db.settings.has(k)).toBe(false);
    expect(routeState.audit).toHaveBeenCalledWith("acceptance", "استعادة مفاتيح حملة القبول", expect.stringContaining("removed="), expect.anything());
    expect(await (await post({ action: "restore" })).json()).toEqual({ ok: true, removed: [], already: true });
  });

  it("PRIVACY / INPUT: an unknown action, or ANY field beyond action/keys/minutes/scenario (an e-mail, a phone, a user id, an amount), is refused before anything is read or written", async () => {
    for (const body of [{ action: "approve" }, { action: "start", keys: ["multi_stage_engine"], minutes: 60, user_id: OTHER_ID }, { action: "create_scenario", scenario: "L1", email: "someone@example.com" }, { action: "create_scenario", scenario: "L2", phone: "+201000000000" }, { action: "start", keys: ["multi_stage_engine"], minutes: 60, ceiling_usd: 5 }, [], "x"]) {
      expect((await post(body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(routeState.db.inserts).toEqual([]);
    expect(routeState.audit).not.toHaveBeenCalled();
  });

  it("GET: the state, the budget guarantee and why, the scenarios and the spend; no e-mail address of anybody is in it", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.account).toEqual({ id: TEST_ID });
    expect(body.budget).toEqual(PRODUCTION_BUDGET_GUARANTEE);
    expect(body.isolated).toBe(true);
    expect(body.flags).toHaveLength(ACCEPTANCE_FLAG_KEYS.length);
    expect(body.scenarios.map((s: any) => s.id)).toEqual(["L1", "L2", "L3", "L4"]);
    expect(body.spend).toMatchObject({ totalUsd: 0, missions: [] });
    expect(JSON.stringify(body)).not.toMatch(/@/);
  });
});

describe("integrity pins", () => {
  it("the acceptance code never approves, reserves, charges, grants, prices or settles, and never upserts a setting", () => {
    for (const f of ["src/lib/agentMission/acceptance/campaign.ts", "src/lib/agentMission/acceptance/run.ts", "src/lib/agentMission/acceptance/scenarios.ts", "src/app/api/admin/acceptance/route.ts", "src/app/api/admin/acceptance/account.ts"]) {
      const src = readFileSync(f, "utf-8");
      expect(src, f).not.toMatch(/approvePlan|approveMissionOnce|approveFreeRerun|accept_quote|grantCredit|admin_grant_credit|settle_job|release_job|credit_ledger|priceMission|\.rpc\(|\.upsert\(|\.update\(/);
    }
  });
  it("the chat brief key equals the chat's own constant; the L4 keys are acceptance keys", async () => {
    const { CHAT_RESEARCH_BRIEF_FLAG_KEY } = await import("../src/lib/agentMission/chatTurn");
    expect(CHAT_RESEARCH_BRIEF_KEY).toBe(CHAT_RESEARCH_BRIEF_FLAG_KEY);
    const { SEMANTIC_NORMALIZATION_FLAG_KEY } = await import("../src/lib/agentMission/semantic/flag");
    expect(SEMANTIC_NORMALIZATION_KEY).toBe(SEMANTIC_NORMALIZATION_FLAG_KEY);
    const caps = await import("../src/lib/agentMission/capabilities/flag");
    expect([...ACCEPTANCE_FLAG_KEYS].sort()).toEqual([CHAT_RESEARCH_BRIEF_FLAG_KEY, SEMANTIC_NORMALIZATION_FLAG_KEY, caps.CAPABILITY_DISCOVERY_FLAG_KEY, caps.REGISTRY_ROUTER_FLAG_KEY, caps.WEB_VIA_TREG_FLAG_KEY, caps.MULTI_STAGE_ENGINE_FLAG_KEY].sort());
    for (const k of L4_FLAG_KEYS) expect(ACCEPTANCE_FLAG_KEYS).toContain(k);
  });
});
