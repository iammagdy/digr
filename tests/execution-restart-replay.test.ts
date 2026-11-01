import { afterEach, describe, expect, it, vi } from "vitest";
import { readSnapshot } from "../agent/src/items/itemStore";
import { runExecution, type RunnerDeps } from "../agent/src/runMission";
import { abortActiveRuns } from "../agent/src/sessions";
import type { MemoryStore } from "../agent/src/memoryStore";
import { replay, readWorkbook } from "./helpers/agentReplay";
import { pages, planning } from "./helpers/engineXScenario";

/**
 * S1 item 1.12: EXECUTION RESUME PROOF. A run stopped after page 3 of the read (the worker's memory guard) and started again must end with the file of an uninterrupted run: the provider calls after the restart start at page 4, no row is twice, and the money rows
 * (reserve, charge, release) are exactly those of the uninterrupted run, written once. Proven for the old pipeline (every flag off) and for the redesigned one.
 */
afterEach(() => { vi.unstubAllGlobals(); });
const answers = () => [pages(1)[0], ...pages(30)];

async function run(flags: unknown, stopAfterCalls: number | null) {
  let captured: RunnerDeps | null = null;
  let calls = 0;
  const r = await replay({
    request: "هات ٣٠٠ تغريدة عن محمد صلاح", planning: planning(), execution: () => [], answers: answers(),
    deps: (d) => {
      (d.store as MemoryStore).settings.redesign_flags = flags;
      const inner = d.call;
      captured = { ...d, call: (async (o: Parameters<typeof inner>[0]) => { const out = await inner(o); calls += 1; if (stopAfterCalls !== null && calls === stopAfterCalls) abortActiveRuns("memory"); return out; }) as typeof inner };
      return captured;
    },
  });
  return { r, deps: captured as unknown as RunnerDeps };
}
const ledger = (r: Awaited<ReturnType<typeof run>>["r"]) => r.money.calls.map((c) => c.name);
const cursorsOf = (r: Awaited<ReturnType<typeof run>>["r"]) => r.call.mock.calls.map((c) => (c[0] as { params: Record<string, unknown> }).params.cursor ?? null);

describe.each([["every flag off (the old pipeline)", {}], ["the redesigned pipeline", { social_posts: "on" }]])("kill after page 3, restart: %s", (_name, flags) => {
  it("the final file, the provider calls and the ledger are those of an uninterrupted run", async () => {
    const whole = await run(flags, null);
    const cut = await run(flags, 4); // call 1 is the planning sample, calls 2 to 4 are pages 1 to 3
    expect(cut.r.mission.status).toBe("approved"); // the guard put the mission back in the queue with everything it saved
    const items = await readSnapshot(cut.r.store, cut.r.missionId);
    expect(items.counts("tweets").pages).toBe(3);
    const claimed = await cut.r.store.claimMission("w_replay", 120);
    expect(claimed?.status).toBe("executing");
    await runExecution(cut.deps, cut.r.store.missions.get(cut.r.missionId)!);
    const final = cut.r.store.missions.get(cut.r.missionId)!;
    expect(final.status).toBe("completed");
    // the rows: the same, none twice
    const a = (await readSnapshot(cut.r.store, cut.r.missionId)).acceptedRows("tweets").map((x) => String(x.id));
    const b = (await readSnapshot(whole.r.store, whole.r.missionId)).acceptedRows("tweets").map((x) => String(x.id));
    expect(new Set(a).size).toBe(a.length);
    expect(a).toEqual(b);
    // the provider calls: pages 1 to 3 once each before the stop, then page 4 on: the cursor of page 3 first, the same sequence as the uninterrupted run
    expect(cursorsOf(cut.r)).toEqual(cursorsOf(whole.r));
    expect(cursorsOf(cut.r)[4]).toBe("cur_60");
    // the file and the numbers
    expect(final.delivered_units).toBe(whole.r.mission.delivered_units);
    expect(final.charged_points).toBe(whole.r.mission.charged_points);
    expect((await readWorkbook(cut.r)).getWorksheet("التغريدات")!.rowCount).toBe((await readWorkbook(whole.r)).getWorksheet("التغريدات")!.rowCount);
    // the money: the same ledger calls, each once (a restart reserves nothing again and settles once)
    expect(ledger(cut.r)).toEqual(ledger(whole.r));
  });
});
