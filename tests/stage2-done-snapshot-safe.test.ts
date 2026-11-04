import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { replay } from "./helpers/agentReplay";
import { replayGateway } from "./helpers/replayGateway";
import { planByCompiler } from "../agent/src/compiled";
import { ItemStore } from "../agent/src/items/itemStore";
import { NO_ABOUT_OPTIONS_AR } from "../src/lib/agentMission/foundation/topicChoice";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { ENDPOINT as _ENDPOINT, pages, planning } from "./helpers/engineXScenario";
import { createMemoryStore, type MemoryStore } from "../agent/src/memoryStore";
import { readSnapshot } from "../agent/src/items/itemStore";
import { writeDoneSnapshotSafely } from "../agent/src/stage2/liveWriter";

void _ENDPOINT;

/**
 * STAGE 2 safety fix: THE DONE SNAPSHOT NEVER STANDS BETWEEN A MISSION AND ITS SETTLEMENT. It is written AFTER `settleMission` has returned, and the whole of it (the flag check, building the facts and
 * the mailboxes, the write) is inside one try that logs and swallows. If building its arguments throws while DIGER_STAGE2_LIVE_SHEET is on for a test account, `settleMission` is still called once, with
 * exactly the arguments of the flag-off run, and the mission ends exactly as it does with the flag off. A whole mission (the replay harness, no real call) is run three ways: flag unset, flag on,
 * and flag on with the facts builder throwing on the Stage 2 call.
 */
const control = vi.hoisted(() => ({ factsCalls: 0, throwOnCall: null as number | null, settleArgs: [] as Array<Record<string, unknown>> }));

vi.mock("../agent/src/methodology", async (orig) => {
  const real = await orig<typeof import("../agent/src/methodology")>();
  return {
    ...real,
    missionFactsOf: (input: Parameters<typeof real.missionFactsOf>[0]) => {
      control.factsCalls += 1;
      if (control.throwOnCall !== null && control.factsCalls === control.throwOnCall) throw new Error("facts builder failed (test)");
      return real.missionFactsOf(input);
    },
  };
});
vi.mock("../src/lib/agentMission/lifecycle", async (orig) => {
  const real = await orig<typeof import("../src/lib/agentMission/lifecycle")>();
  return { ...real, settleMission: vi.fn(async (client: unknown, input: Record<string, unknown>) => { control.settleArgs.push({ ...input }); return real.settleMission(client, input as never); }) };
});

const REQUEST = "هات ٣٠٠ تغريدة عن محمد صلاح";
const testAccountStore = (): MemoryStore => { const s = createMemoryStore(); s.readUserEmail = async () => "tester@digr.local"; return s; };
async function run() {
  control.factsCalls = 0;
  control.settleArgs = [];
  const r = await replay({ request: REQUEST, planning: planning(), execution: () => [], answers: [pages(1)[0], ...pages(30)], makeStore: testAccountStore });
  const m = r.mission;
  return {
    r,
    // the job id is random in each run (it is inside `resultPath` too): everything else of the settlement's input must be identical
    settleArgs: control.settleArgs.map((a) => { const { jobId: _j, resultPath, ...rest } = a; void _j; return { ...rest, resultPath: String(resultPath).replace(/job_quote_[0-9a-f]+/, "job_quote_X") }; }),
    settleCalls: control.settleArgs.length,
    factsCalls: control.factsCalls,
    outcome: { status: m.status, delivered_units: m.delivered_units, charged_points: m.charged_points, reserved_points: m.reserved_points, error: m.error ?? null, summary_ar: m.summary_ar ?? null },
    balance: r.money.balance(),
    live: (await r.store.listFiles(r.missionId, "live")).map((f) => f.name),
  };
}

beforeEach(() => { control.throwOnCall = null; });
afterEach(() => { vi.unstubAllEnvs(); control.throwOnCall = null; });

describe("with the flag unset (today): nothing Stage 2 is evaluated or written", () => {
  it("the facts are built once (for the file), no live object exists, settlement ran once", async () => {
    vi.stubEnv("DIGER_STAGE2_LIVE_SHEET", "");
    const off = await run();
    expect(off.settleCalls).toBe(1);
    expect(off.factsCalls).toBe(1);
    expect(off.live).toEqual([]);
    expect(await off.r.store.getFile(off.r.missionId, "stage2/test_account.json")).toBeNull();
    expect(off.outcome.status).toBe("completed");
    expect((await readSnapshot(off.r.store, off.r.missionId)).counts("tweets").accepted).toBe(300);
  });
});

describe("the flag on for a test account", () => {
  it("control: nothing throws; one done snapshot is written AFTER the settlement, and the money is exactly the flag-off run's", async () => {
    vi.stubEnv("DIGER_STAGE2_LIVE_SHEET", "");
    const off = await run();
    vi.stubEnv("DIGER_STAGE2_LIVE_SHEET", "test");
    const on = await run();
    expect(on.factsCalls).toBe(2);
    expect(on.live.some((n) => n.endsWith("_done.json"))).toBe(true);
    expect(on.settleCalls).toBe(1);
    expect(on.settleArgs).toEqual(off.settleArgs);
    expect(on.outcome).toEqual(off.outcome);
    expect(on.balance).toBe(off.balance);
  });
  it("the facts builder THROWS on the Stage 2 call: settleMission is still called exactly once with the flag-off arguments, the mission and the money end identical, no error escapes, no done snapshot", async () => {
    vi.stubEnv("DIGER_STAGE2_LIVE_SHEET", "");
    const off = await run();
    vi.stubEnv("DIGER_STAGE2_LIVE_SHEET", "test");
    control.throwOnCall = 2;
    const on = await run();
    // the throwing call was the Stage 2 one (the file's own call is the first)
    expect(on.factsCalls).toBe(2);
    expect(on.settleCalls).toBe(1);
    expect(on.settleArgs).toEqual(off.settleArgs);
    expect(on.outcome).toEqual(off.outcome);
    expect(on.balance).toBe(off.balance);
    expect(on.live.some((n) => n.endsWith("_done.json"))).toBe(false);
    expect(on.outcome.status).toBe("completed");
  });
});

describe("writeDoneSnapshotSafely never throws and never waits for ever", () => {
  // REAL inputs (the stored rows of M12, msn_5851abc92a1e6645a9cd, planned on its stored pages), so a failure below is the one the test names, not a broken input
  const M12 = "msn_5851abc92a1e6645a9cd";
  async function real() {
    const catalog = loadTregCatalog();
    const store = createMemoryStore();
    const { gateway } = replayGateway(M12, catalog, store, "msn_safe");
    const planned = await planByCompiler({ mission: { id: "msn_safe", request_text: "هات فيديوهين تيك توك بالعربي عن الذكاء الاصطناعي من مصر، أكتر فيديوهات عليها تعليقات، و٢٠ تعليق من كل فيديو مع ردودهم", answer_text: NO_ABOUT_OPTIONS_AR.useAsIs, created_at: "2026-11-02T11:35:00Z" }, gateway, store, catalog, nowMs: Date.parse("2026-11-02T11:36:00Z") });
    if (planned.kind !== "plan") throw new Error(planned.kind);
    const items = await ItemStore.open(createMemoryStore(), "msn_safe");
    const videos = JSON.parse(readFileSync(new URL(`./fixtures/live/missions/${M12}/rows/videos.json`, import.meta.url), "utf8")) as Array<Record<string, unknown>>;
    await items.commit(videos.map((row) => ({ t: "item" as const, stage: "videos", id: String(row.id), state: "accepted" as const, by: "rule" as const, row })));
    return { store: createMemoryStore(), missionId: "msn_safe", plan: planned.plan, snap: items.snapshotOfMemory(), requestText: "x", reviewStop: null, resultPath: "p", mailboxesOf: () => ({}), isTest: async () => true };
  }
  it("flag unset: false, and neither the account check nor the builders are touched", async () => {
    vi.stubEnv("DIGER_STAGE2_LIVE_SHEET", "");
    const isTest = vi.fn(async () => true);
    const mailboxesOf = vi.fn(() => ({}));
    const input = await real();
    expect(await writeDoneSnapshotSafely({ ...input, isTest, mailboxesOf })).toBe(false);
    expect(isTest).not.toHaveBeenCalled();
    expect(mailboxesOf).not.toHaveBeenCalled();
    expect(await input.store.listFiles("msn_safe", "live")).toEqual([]);
  });
  it("no result file: false, nothing evaluated", async () => {
    vi.stubEnv("DIGER_STAGE2_LIVE_SHEET", "on");
    const mailboxesOf = vi.fn(() => ({}));
    expect(await writeDoneSnapshotSafely({ ...(await real()), resultPath: null, mailboxesOf })).toBe(false);
    expect(mailboxesOf).not.toHaveBeenCalled();
  });
  it("control: real inputs, the flag on: true, and one create-only done object", async () => {
    vi.stubEnv("DIGER_STAGE2_LIVE_SHEET", "on");
    const input = await real();
    expect(await writeDoneSnapshotSafely(input)).toBe(true);
    const names = (await input.store.listFiles("msn_safe", "live")).map((f) => f.name);
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^live\/snap_\d{9}_[a-z0-9]+_done\.json$/);
  });
  it("a mailbox builder, an account check or a store that throws: false, logged, nothing escapes", async () => {
    const lines: string[] = [];
    const log = (l: string) => lines.push(l);
    vi.stubEnv("DIGER_STAGE2_LIVE_SHEET", "on");
    await expect(writeDoneSnapshotSafely({ ...(await real()), log, mailboxesOf: () => { throw new Error("mailboxes failed"); } })).resolves.toBe(false);
    await expect(writeDoneSnapshotSafely({ ...(await real()), log, store: { putNew: async () => { throw new Error("storage down"); } } as never })).resolves.toBe(false);
    vi.stubEnv("DIGER_STAGE2_LIVE_SHEET", "test");
    await expect(writeDoneSnapshotSafely({ ...(await real()), log, isTest: async () => { throw new Error("lookup failed"); } })).resolves.toBe(false);
    expect(lines.filter((l) => l.startsWith("live_snapshot_not_written msn_safe"))).toHaveLength(3);
  });
  it("a write that never answers is given up after the time limit (the write WAS attempted)", async () => {
    vi.stubEnv("DIGER_STAGE2_LIVE_SHEET", "on");
    const lines: string[] = [];
    const putNew = vi.fn(() => new Promise<void>(() => undefined));
    const started = Date.now();
    expect(await writeDoneSnapshotSafely({ ...(await real()), store: { putNew } as never, timeoutMs: 30, log: (l) => lines.push(l) })).toBe(false);
    expect(putNew).toHaveBeenCalledTimes(1);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(lines.some((l) => /live_snapshot_not_written msn_safe .*time/.test(l))).toBe(true);
  });
});
