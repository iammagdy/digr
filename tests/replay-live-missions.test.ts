import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildRequestContract, checkPlanAgainstContract, gateContract, CONTRACT_SEND_BACKS_MAX, type ContractPlan } from "../src/lib/agentMission/requestContract";
import { checkCustomerText } from "../src/lib/agentMission/text";

/**
 * THE ACCEPTANCE REPLAY (docs/ROOT-CAUSE.md, section 5.4): every one of the 20 live missions of the test account (2026-11-01 21:00 to 2026-11-02 19:30 Cairo) is replayed from its STORED request, plan and result records through the new code. For each: the contract is built from the
 * stored request, the stored plan is checked, the final gate runs as it does in planning (sent back while the budget lasts, then repaired by code), and the plan that comes out must satisfy the contract (every asked thing carried or stated, nothing missing). Where the stored records allow it,
 * the promise is compared with the delivery; the missions whose promise needs raw pages (storage) are listed with the reason and are NOT claimed. The fixture is `tests/fixtures/live/replay-missions.json` (read-only SELECTs, listed in the document).
 */
interface FxStage { key: string; parent_key: string | null; replies_of?: string; endpoint_id: string; planned: number; gaps?: string[]; params?: Record<string, unknown>; source_listing?: boolean; sources_n?: number }
interface FxMission { id: string; cairo: string; pipe: 0 | 1; request: string; summary_ar: string; replies_status: string | null; stages: FxStage[]; delivered: number[]; promise: { replayable: boolean; reason: string } }
const fixture = JSON.parse(readFileSync(new URL("./fixtures/live/replay-missions.json", import.meta.url), "utf8")) as { missions: FxMission[] };

const planOf = (m: FxMission): ContractPlan => ({
  summary_ar: m.summary_ar,
  ...(m.replies_status ? { replies_status: m.replies_status } : {}),
  stages: m.stages.map((s) => ({
    key: s.key, parent_key: s.parent_key, ...(s.replies_of ? { replies_of: s.replies_of } : {}), deliver: true, endpoint_id: s.endpoint_id, planned_rows: s.planned,
    ...(s.params ? { engine: { params: s.params, gaps: (s.gaps ?? []).map((g) => ({ cls: g.split(":")[0], reason: g.split(":")[1] })), ...(s.source_listing ? { source_listing: true } : {}), ...(s.sources_n ? { sources: Array.from({ length: s.sources_n }, () => ({ names: [], params: {} })) } : {}) } } : {}),
  })),
});

/** What the planner would be asked and the code would do, in order: the gate is called until it accepts. */
function runGate(m: FxMission) {
  const contract = buildRequestContract(m.request);
  const plan = planOf(m);
  const before = checkPlanAgainstContract(contract, planOf(m));
  let sendBacks = 0;
  for (;;) {
    const out = gateContract(contract, plan, sendBacks, { commentsTools: [] });
    if (out.kind === "send_back") { sendBacks += 1; continue; }
    return { contract, plan, before, sendBacks, added: out.added, after: out.verdict };
  }
}

/** The stored facts the gate must find (each is a defect of the live record, docs/ROOT-CAUSE.md, class A). */
const MISSING_BEFORE: Record<string, string[]> = {
  msn_adcfafabcdebc27ff803: ["comments", "replies"], // the 19:00 YouTube regression: the plan dropped both
  msn_a6dacebce7e7b7432aa1: ["replies"],
  msn_afe9bb0b436670e35a3c: ["replies"],
};
const OVERCLAIM_BEFORE: Record<string, string[]> = {
  msn_a254618740b9b9878126: ["replies"], msn_ee599cdbbde993073b15: ["replies"], msn_3594a5ab6311c8691f20: ["replies"],
};

describe("the fixture is the stored record", () => {
  it("twenty missions, each with a plan whose rows add up and a delivery per stage", () => {
    expect(fixture.missions).toHaveLength(20);
    for (const m of fixture.missions) {
      expect(m.delivered, m.id).toHaveLength(m.stages.length);
      expect(new Set(m.stages.map((s) => s.key)).size, m.id).toBe(m.stages.length);
    }
    expect(fixture.missions.filter((m) => m.pipe === 0)).toHaveLength(8);
  });
});

describe("every mission: the new code yields a plan that satisfies the contract", () => {
  for (const m of fixture.missions) {
    it(`${m.id} (${m.cairo})`, () => {
      const r = runGate(m);
      // what the stored plan lacked, found by the contract alone
      expect(r.before.missingStages, "stored plan").toEqual(MISSING_BEFORE[m.id] ?? []);
      expect(r.before.overclaims, "stored plan summary").toEqual(OVERCLAIM_BEFORE[m.id] ?? []);
      // the planner is sent back only for a missing comments stage, at most the budget
      expect(r.sendBacks).toBe((MISSING_BEFORE[m.id] ?? []).includes("comments") ? CONTRACT_SEND_BACKS_MAX : 0);
      // the plan that is stored has nothing missing: everything asked is carried or stated
      expect(r.after.missingStages).toEqual([]);
      expect(r.after.items.filter((i) => i.status === "missing"), "items still missing").toEqual([]);
      // the platform and the count of the stored plan equal the request's
      expect(r.contract.platform).not.toBeNull();
      expect(r.after.items.find((i) => i.what === "platform")?.status).toBe("carried");
      expect(r.after.items.find((i) => i.what === "count")?.status).toBe("carried");
      // everything the code wrote for the customer is plain Arabic with no source name and no number of ours
      const lines = [...(r.plan.notes_ar ?? []), ...(r.plan.unserved_steps ?? []).flatMap((u) => [u.what_ar, u.reason_ar])];
      for (const l of lines) { expect(checkCustomerText(l).issues, l).toEqual([]); expect(l).not.toMatch(/[A-Za-z0-9]/); }
      // idempotent: the gate run again on its own output accepts with nothing added
      const again = gateContract(r.contract, r.plan, 99);
      expect(again.kind === "accept" && again.added).toEqual([]);
    });
  }
  it("the plan that dropped the comments and the replies (the 19:00 regression) now states both as steps not included", () => {
    const r = runGate(fixture.missions.find((m) => m.id === "msn_adcfafabcdebc27ff803")!);
    expect(r.plan.unserved_steps!.map((u) => u.what_ar).join("|")).toMatch(/التعليقات.*\|الردود/);
  });
  it("the Instagram plan whose replies stage was lost without a word now states it (the 15:35 mission)", () => {
    const r = runGate(fixture.missions.find((m) => m.id === "msn_afe9bb0b436670e35a3c")!);
    expect(r.plan.unserved_steps!.map((u) => u.what_ar)).toEqual(["الردود على كل تعليق"]);
  });
  it("the TikTok plans whose country was only in the search words now say it is not enforced; the ones with a region field are untouched", () => {
    const byId = (id: string) => runGate(fixture.missions.find((m) => m.id === id)!);
    expect(byId("msn_c796a6ff13d79f7a973d").added).toContain("country");
    expect(byId("msn_5851abc92a1e6645a9cd").added).toEqual([]);
  });
  it("the Facebook plans: the topic and the source of a page listing are stated or carried, the period is stated by the tool's own gap", () => {
    const r = runGate(fixture.missions.find((m) => m.id === "msn_6bb78c15d116268b0b9b")!);
    expect(r.before.items.find((i) => i.what === "source")?.status).toBe("carried");
    expect(r.before.items.find((i) => i.what === "period")?.status).toBe("stated");
    expect(r.before.items.find((i) => i.what === "topic")?.status).toBe("missing");
    expect(r.after.items.find((i) => i.what === "topic")?.status).toBe("stated");
  });
  it("the X plans carry the period, the language and the topic in the query itself and need nothing added", () => {
    for (const id of ["msn_e3d679014c58168c3227", "msn_b060d3347ed7660f972e"]) expect(runGate(fixture.missions.find((m) => m.id === id)!).added, id).toEqual([]);
  });
});

describe("the promise against the delivery, where the stored records allow it", () => {
  const total = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const promised = (m: FxMission) => total(m.stages.map((s) => s.planned));
  it("the six missions whose stored records prove it: promised equals delivered", () => {
    const ok = fixture.missions.filter((m) => m.promise.replayable);
    expect(ok.map((m) => m.id)).toEqual(["msn_e3d679014c58168c3227", "msn_5851abc92a1e6645a9cd", "msn_b060d3347ed7660f972e", "msn_afe9bb0b436670e35a3c", "msn_e3e7632e2fb2d42f9c19", "msn_adcfafabcdebc27ff803"]);
    for (const m of ok) expect(promised(m), m.id).toBe(total(m.delivered));
  });
  it("the other fourteen are NOT claimed: each differs, and each says why a replay cannot decide it (raw pages, counters or the model's number are in storage)", () => {
    const rest = fixture.missions.filter((m) => !m.promise.replayable);
    expect(rest).toHaveLength(14);
    for (const m of rest) { expect(promised(m), m.id).not.toBe(total(m.delivered)); expect(m.promise.reason.length, m.id).toBeGreaterThan(20); }
  });
  it("the totals the report states: 20 replayed, 20 satisfy the contract, 6 promise-verified, 14 not replayable for the promise", () => {
    const rows = fixture.missions.map((m) => runGate(m));
    expect(rows.filter((r) => r.after.missingStages.length === 0 && r.after.items.every((i) => i.status !== "missing"))).toHaveLength(20);
    expect(fixture.missions.filter((m) => m.promise.replayable)).toHaveLength(6);
  });
});
