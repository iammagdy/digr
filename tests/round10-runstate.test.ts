import { describe, expect, it } from "vitest";
import { createMemoryStore } from "../agent/src/memoryStore";
import { readRunState, updateRunState } from "../agent/src/runState";

/** LIVE ROUND 10, decision 7: the occurrence the customer chose is kept in the mission's run note (the answer of a later question replaces `answer_text`); a note with no occurrence is exactly what it was. */
describe("the run note keeps the occurrence", () => {
  it("a note with no occurrence has no `occurrence` key; a chosen one survives a read, a year too, and a bad value is dropped", async () => {
    const store = createMemoryStore();
    expect(await readRunState(store, "msn_x")).toEqual({ planningStarts: 0, executionStarts: 0, memoryRequeues: 0, errorRequeues: 0, restartRequeues: 0 });
    await updateRunState(store, "msn_x", (s) => ({ ...s, occurrence: { kind: "latest" } }));
    expect((await readRunState(store, "msn_x")).occurrence).toEqual({ kind: "latest" });
    await updateRunState(store, "msn_x", (s) => ({ ...s, occurrence: { kind: "year", year: 2024 } }));
    expect((await readRunState(store, "msn_x")).occurrence).toEqual({ kind: "year", year: 2024 });
    await updateRunState(store, "msn_x", (s) => ({ ...s, planningStarts: 2, occurrence: { kind: "year", year: "x" } as never }));
    const after = await readRunState(store, "msn_x");
    expect(after.planningStarts).toBe(2);
    expect(after.occurrence).toBeUndefined();
  });
});
