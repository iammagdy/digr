import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createMemoryStore } from "../agent/src/memoryStore";
import { markStage2TestAccount } from "../agent/src/stage2/testMarker";
import { STAGE2_TEST_MARKER, anyStage2TestMode } from "../src/lib/agentMission/stage2/flags";
import { stage2FlagForMission } from "../src/lib/agentMission/stage2/askEditAction";

/**
 * STAGE 2 «test» mode on the site: the WORKER marks a test account's mission (create-only `stage2/test_account.json`) only when some Stage 2 flag says «test»; the site reads only that
 * marker, never the test-account rule (tests/admin-calls-log.test.ts keeps `server/testAccounts` out of customer code).
 */
describe("the worker's marker", () => {
  it("written only for a test account AND a Stage 2 flag in «test»; flags unset or «on»: nothing is written", async () => {
    const store = createMemoryStore();
    expect(await markStage2TestAccount(store, "m1", true, {})).toBe(false);
    expect(await markStage2TestAccount(store, "m2", true, { DIGER_STAGE2_LIVE_SHEET: "on" })).toBe(false);
    expect(await markStage2TestAccount(store, "m3", false, { DIGER_STAGE2_LIVE_SHEET: "test" })).toBe(false);
    expect(await markStage2TestAccount(store, "m4", true, { DIGER_STAGE2_ASK_CARD: "test" })).toBe(true);
    for (const m of ["m1", "m2", "m3"]) expect(await store.getFile(m, STAGE2_TEST_MARKER)).toBeNull();
    expect(await store.getFile("m4", STAGE2_TEST_MARKER)).not.toBeNull();
    expect(anyStage2TestMode({})).toBe(false);
  });
  it("a store that fails never fails the run", async () => {
    expect(await markStage2TestAccount({ putNew: async () => { throw new Error("down"); } }, "m", true, { DIGER_STAGE2_ASK_CARD: "test" })).toBe(false);
  });
  it("runMission.ts writes it during planning (the account's test-ness the redesign flags already use)", () => {
    expect(readFileSync(new URL("../agent/src/runMission.ts", import.meta.url), "utf8")).toContain("await markStage2TestAccount(store, mission.id, redesign.isTest);");
  });
});

describe("the site reads the marker only in «test» mode", () => {
  const client = (names: string[], calls: { n: number }) => ({ storage: { from: () => ({ list: async () => { calls.n += 1; return { data: names.map((name) => ({ name })), error: null }; } }) } });
  it("unset: off with no read; «on»: on with no read; «test»: on only with the marker", async () => {
    const calls = { n: 0 };
    expect(await stage2FlagForMission(client(["test_account.json"], calls), "DIGER_STAGE2_LIVE_SHEET", "m", {})).toBe(false);
    expect(await stage2FlagForMission(client([], calls), "DIGER_STAGE2_LIVE_SHEET", "m", { DIGER_STAGE2_LIVE_SHEET: "on" })).toBe(true);
    expect(calls.n).toBe(0);
    expect(await stage2FlagForMission(client([], calls), "DIGER_STAGE2_LIVE_SHEET", "m", { DIGER_STAGE2_LIVE_SHEET: "test" })).toBe(false);
    expect(await stage2FlagForMission(client(["test_account.json"], calls), "DIGER_STAGE2_LIVE_SHEET", "m", { DIGER_STAGE2_LIVE_SHEET: "test" })).toBe(true);
  });
  it("no Stage 2 file of the site imports the test-account rule", () => {
    for (const f of ["src/lib/agentMission/stage2/askEditAction.ts", "src/app/api/missions/[id]/live/route.ts", "src/app/api/missions/[id]/route.ts"]) expect(readFileSync(f, "utf8"), f).not.toContain("testAccounts");
  });
});
