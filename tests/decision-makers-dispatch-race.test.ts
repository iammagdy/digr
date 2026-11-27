import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { WORKER_DISPATCH_TIMEOUT_MS } from "../src/lib/server/workerDispatch";
import { PEOPLE_LOOKUP_RESERVE_MS } from "../src/lib/server/tregAdapter";
import { startFailureStillApplies } from "../src/lib/server/workerStartFailure";
import { collectionCompleteBeforeSettlement } from "../src/lib/server/settlementPrecheck";

// PR #253: a late dispatch timeout must not roll a claimed job back to queued.
describe("the legacy worker timeout and settlement guards", () => {
  it("startFailureStillApplies: queued yes; running, completed, failed, cancelled no; an unreadable or missing job keeps the old behaviour (yes); other codes never read the job", async () => {
    const client = (rows: any[], fails = false) => ({ from: () => ({ select: () => ({ eq: (_c: string, id: string) => ({ maybeSingle: async () => (fails ? { data: null, error: new Error("x") } : { data: rows.find((r) => r.id === id) ?? null, error: null }) }) }) }) });
    const rows = [{ id: "q", status: "queued" }, { id: "r", status: "running" }, { id: "c", status: "completed" }, { id: "f", status: "failed" }, { id: "x", status: "cancelled" }];
    const applies = (id: string, code = "dispatch_timeout") => startFailureStillApplies(client(rows), id, code);
    expect(await applies("q")).toBe(true);
    for (const id of ["r", "c", "f", "x"]) expect(await applies(id), id).toBe(false);
    expect(await applies("missing")).toBe(true);
    expect(await startFailureStillApplies(client(rows, true), "r", "dispatch_timeout")).toBe(true);
    expect(await startFailureStillApplies({ from: () => { throw new Error("down"); } }, "r", "dispatch_timeout")).toBe(true);
    for (const code of ["worker_http_error", "protection_redirect", "dispatch_exception", undefined]) expect(await startFailureStillApplies(client(rows), "r", code as any), String(code)).toBe(true);
  });

  it("the settlement pre-check: running + completed cursor + the recorded count passes; any other status, cursor or count, or a read error, refuses", () => {
    const ok = { status: "running", current_cursor: "completed", delivered_units: 2 };
    expect(collectionCompleteBeforeSettlement(ok, null, 2)).toBe(true);
    expect(collectionCompleteBeforeSettlement({ ...ok, status: "queued" }, null, 2)).toBe(false);
    expect(collectionCompleteBeforeSettlement({ ...ok, status: "failed" }, null, 2)).toBe(false);
    expect(collectionCompleteBeforeSettlement({ ...ok, current_cursor: "page_2" }, null, 2)).toBe(false);
    expect(collectionCompleteBeforeSettlement({ ...ok, delivered_units: 3 }, null, 2)).toBe(false);
    expect(collectionCompleteBeforeSettlement(ok, new Error("x"), 2)).toBe(false);
    expect(collectionCompleteBeforeSettlement(null, null, 2)).toBe(false);
    // the worker route uses this function (and no longer compares inline)
    expect(readFileSync("src/app/api/worker/chunk/route.ts", "utf8")).toContain("collectionCompleteBeforeSettlement(persistedCompletion, persistedCompletionErr, recordedDeliveredUnits)");
  });
});

describe("the timing: the dispatcher waits longer than the worker can run", () => {
  it("arithmetic: the worker's deadline is 45 s; lookups stop starting 12 s before it (33 s); saving and settling took about 10 s (live: 15:00:39.7 to 15:00:49.3) = 43 s; the dispatcher waits 55 s, under maxDuration 60", () => {
    const workerDeadlineMs = 45_000;
    const savingAndSettlingMs = 10_000; // measured in the live job: lookup_log written 15:00:39.7, last event 15:00:49.3
    const lastLookupEndsMs = workerDeadlineMs - PEOPLE_LOOKUP_RESERVE_MS;
    expect(PEOPLE_LOOKUP_RESERVE_MS).toBe(12_000);
    expect(lastLookupEndsMs).toBe(33_000);
    expect(lastLookupEndsMs + savingAndSettlingMs).toBe(43_000);
    expect(lastLookupEndsMs + savingAndSettlingMs).toBeLessThanOrEqual(workerDeadlineMs);
    expect(WORKER_DISPATCH_TIMEOUT_MS).toBe(55_000);
    expect(WORKER_DISPATCH_TIMEOUT_MS - (lastLookupEndsMs + savingAndSettlingMs)).toBe(12_000); // margin over a normal chunk
    // the old numbers: lookups to 39 s + 10 s = 49 s > the 45 s wait (the live failure)
    expect(workerDeadlineMs - 6_000 + savingAndSettlingMs).toBeGreaterThan(45_000);
  });

  it("the sources agree: the worker deadline is routeStart + 45_000 with maxDuration 60; the nudge route allows 60 s; the dispatch default is the named constant", () => {
    const worker = readFileSync("src/app/api/worker/chunk/route.ts", "utf8");
    expect(worker).toContain("const deadlineMs = routeStart + 45_000;");
    expect(worker).toContain("export const maxDuration = 60;");
    expect(readFileSync("src/app/api/jobs/[id]/nudge/route.ts", "utf8")).toContain("export const maxDuration = 60;");
    expect(readFileSync("src/lib/server/workerDispatch.ts", "utf8")).toContain("timeoutMs = WORKER_DISPATCH_TIMEOUT_MS,");
    expect(WORKER_DISPATCH_TIMEOUT_MS).toBeLessThan(60_000);
  });
});
