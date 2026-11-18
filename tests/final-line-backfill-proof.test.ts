import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { backfillChainFinalLines } from "@/lib/server/multiProvider/finalLineBackfill";
import { NEUTRAL_STOP_REASON_AR } from "@/lib/multiProvider/copy";
import { checkCustomerText } from "@/lib/agentMission/text";

/**
 * PR-11 final-line backfill PROOF (D-0071), QA gaps of tests/final-line-backfill.test.ts: a NEW independent file with its own fake database and
 * storage, asserting the COMPLETE observable result (the exact inserted row, or no insert at all):
 *  1. a malformed stored file => the EXACT fallback: «المسلَّم X من N مطلوب.» + NEUTRAL_STOP_REASON_AR when short, the count only when full
 *  2. an event read that THROWS => no insert; an event read that answers {error} => no insert (the job is deferred, never duplicated)
 *  3. an unparseable updated_at => skipped (no event read, no insert)
 *  4. a download that REJECTS (and one that answers {error}) => the exact fallback
 *  5. a valid stored final line => its messageAr exactly; an invalid one (wrong X, wrong N, wrong version, wrong prefix, a customer-text issue,
 *     a non-string message) => the exact fallback
 *  6. NOT INCLUDED: the T4(d) literal expected charge of the ordinary settle lives in tests/multi-provider-worker.test.ts, which exports no helper
 *     (its fake world is private to that file) and may not be edited; it needs its own change in that file.
 * Nothing here changes source code.
 */

const nowMs = Date.parse("2026-11-18T12:00:00.000Z");
const idOf = (quoteId: string) => `job_quote_${createHash("md5").update(quoteId).digest("hex")}`;
const iso = (agoSec: number) => new Date(nowMs - agoSec * 1000).toISOString();
const SHORT_COUNT = "المسلَّم ٣ من ٥ مطلوب.";
const FULL_COUNT = "المسلَّم ٥ من ٥ مطلوب.";
const FALLBACK_SHORT = `${SHORT_COUNT} ${NEUTRAL_STOP_REASON_AR}`;
const FALLBACK_FULL = FULL_COUNT;
const GOOD_STORED = `${SHORT_COUNT} السبب: وصلنا إلى آخر النتائج المتاحة لهذا الطلب.`;    // different from the fallback, and clean customer text

interface World {
  quotes: Array<{ id: string; user_id: string; items: any }>;
  jobs: Record<string, any>;
  events: Record<string, Array<{ message: string }>>;
  eventMode: Record<string, "throw" | "error" | "error_with_data">;
  files: Record<string, string>;
  downloadMode: Record<string, "reject" | "error" | "nodata">;
  inserted: Array<Record<string, any>>;
  eventReads: string[];
}
function fake(w: World) {
  return {
    from(table: string) {
      const eq: Record<string, any> = {};
      const q: any = {
        select: () => q,
        gte: () => q, order: () => q, limit: () => q,
        eq: (k: string, v: any) => { eq[k] = v; return q; },
        maybeSingle: async () => ({ data: table === "jobs" ? (w.jobs[eq.id] ?? null) : null, error: null }),
        insert: async (row: any) => { w.inserted.push(row); return { error: null }; },
        then: (ok: any, bad: any) => {
          if (table === "plans_quotes") return Promise.resolve({ data: w.quotes, error: null }).then(ok, bad);
          if (table === "job_events") {
            w.eventReads.push(eq.job_id);
            const mode = w.eventMode[eq.job_id];
            if (mode === "throw") return Promise.reject(new Error("event read exploded")).then(ok, bad);
            if (mode === "error") return Promise.resolve({ data: null, error: { message: "event read failed" } }).then(ok, bad);
            if (mode === "error_with_data") return Promise.resolve({ data: [], error: { message: "partial failure" } }).then(ok, bad);
            return Promise.resolve({ data: w.events[eq.job_id] ?? [], error: null }).then(ok, bad);
          }
          return Promise.resolve({ data: [], error: null }).then(ok, bad);
        },
      };
      return q;
    },
    storage: {
      from: () => ({
        download: async (path: string) => {
          const mode = w.downloadMode[path];
          if (mode === "reject") throw new Error("storage exploded");
          if (mode === "error") return { data: null, error: new Error("storage 500") };
          if (mode === "nodata") return { data: null, error: null };
          return w.files[path] !== undefined ? { data: new Blob([w.files[path]]), error: null } : { data: null, error: new Error("missing") };
        },
      }),
    },
  };
}
/** one chain quote with a completed, quiet job (x of n delivered); `ageSec` = seconds since updated_at (181 = just quiet). */
function world(opts: { id: string; x?: number; n?: number; ageSec?: number; updatedAt?: any; file?: string; eventMode?: "throw" | "error" | "error_with_data"; downloadMode?: "reject" | "error" | "nodata"; events?: Array<{ message: string }> }): { w: World; job: string } {
  const job = idOf(opts.id);
  const w: World = {
    quotes: [{ id: opts.id, user_id: "u", items: [{ capabilitySlug: "mp-business-contacts" }] }],
    jobs: { [job]: { id: job, user_id: "u", status: "completed", delivered_units: opts.x ?? 3, target_volume_max: opts.n ?? 5, updated_at: "updatedAt" in opts ? opts.updatedAt : iso(opts.ageSec ?? 181) } },
    events: opts.events ? { [job]: opts.events } : {},
    eventMode: opts.eventMode ? { [job]: opts.eventMode } : {},
    files: opts.file !== undefined ? { [`final_line/${job}.json`]: opts.file } : {},
    downloadMode: opts.downloadMode ? { [`final_line/${job}.json`]: opts.downloadMode } : {},
    inserted: [], eventReads: [],
  };
  return { w, job };
}
const run = (w: World) => backfillChainFinalLines(fake(w), { nowMs });
const stored = (over: Record<string, any> = {}, x = 3, n = 5, messageAr = GOOD_STORED) => JSON.stringify({ v: 1, deliveredUnits: x, targetMax: n, messageAr, ...over });
/** the complete inserted row for a job */
const row = (job: string, message: string) => ({ job_id: job, user_id: "u", message, units: 0, event_type: "info" });

// ---------------------------------------------------------------------------------------------------------------------------------------------------
describe("1. a malformed stored final-line file => the EXACT fallback", () => {
  const malformed: [string, string][] = [["a lone brace", "{"], ["an empty file", ""], ["truncated json", '{"v":1,"deliveredUnits":3,"targetMax":5,"messageAr":"المسل'], ["not json at all", "<html>502 Bad Gateway</html>"], ["json null", "null"], ["a json array", "[]"], ["a json string", '"المسلَّم ٣ من ٥ مطلوب."']];
  it.each(malformed)("%s, short delivery (3 of 5) => count + the neutral reason, exactly one row", async (_label, file) => {
    const { w, job } = world({ id: "m1", file });
    const res = await run(w);
    expect(res).toEqual({ considered: 1, written: 1 });
    expect(w.inserted).toEqual([row(job, FALLBACK_SHORT)]);
    expect(w.inserted[0].message).toBe(`المسلَّم ٣ من ٥ مطلوب. ${NEUTRAL_STOP_REASON_AR}`);
  });
  it.each(malformed)("%s, full delivery (5 of 5) => the count only (no reason)", async (_label, file) => {
    const { w, job } = world({ id: "m2", x: 5, n: 5, file });
    await run(w);
    expect(w.inserted).toEqual([row(job, FALLBACK_FULL)]);
    expect(w.inserted[0].message).not.toContain("السبب");
  });
  it("no file at all (storage says missing): the same exact fallbacks", async () => {
    const a = world({ id: "m3" }); await run(a.w); expect(a.w.inserted).toEqual([row(a.job, FALLBACK_SHORT)]);
    const b = world({ id: "m4", x: 5, n: 5 }); await run(b.w); expect(b.w.inserted).toEqual([row(b.job, FALLBACK_FULL)]);
  });
  it("zero delivered of 5: «المسلَّم ٠ من ٥ مطلوب.» + the neutral reason", async () => {
    const { w, job } = world({ id: "m5", x: 0, file: "{" });
    await run(w);
    expect(w.inserted).toEqual([row(job, `المسلَّم ٠ من ٥ مطلوب. ${NEUTRAL_STOP_REASON_AR}`)]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------
describe("2. an event read that fails => NO insert (the job is deferred, never duplicated)", () => {
  it("the event read THROWS (rejected promise): no insert, written 0", async () => {
    const { w, job } = world({ id: "e1", eventMode: "throw" });
    const res = await run(w);
    expect(w.eventReads).toEqual([job]);                         // the read was really attempted
    expect(w.inserted).toEqual([]); expect(res).toEqual({ considered: 1, written: 0 });
  });
  it("the event read answers {error}: no insert, written 0", async () => {
    const { w, job } = world({ id: "e2", eventMode: "error" });
    const res = await run(w);
    expect(w.eventReads).toEqual([job]);
    expect(w.inserted).toEqual([]); expect(res).toEqual({ considered: 1, written: 0 });
  });
  it("the event read answers an error AND an (empty) data array: the error wins, no insert", async () => {
    const { w } = world({ id: "e3", eventMode: "error_with_data" });
    await run(w);
    expect(w.inserted).toEqual([]);
  });
  it("a failed read does not stop the others: of three jobs one throws, one errors, one is fine => only the fine one is written, exactly", async () => {
    const a = world({ id: "e4a", eventMode: "throw" }); const b = world({ id: "e4b", eventMode: "error" }); const c = world({ id: "e4c" });
    const w: World = { quotes: [...a.w.quotes, ...b.w.quotes, ...c.w.quotes], jobs: { ...a.w.jobs, ...b.w.jobs, ...c.w.jobs }, events: {}, eventMode: { ...a.w.eventMode, ...b.w.eventMode }, files: {}, downloadMode: {}, inserted: [], eventReads: [] };
    const res = await run(w);
    expect(res).toEqual({ considered: 3, written: 1 });
    expect(w.inserted).toEqual([row(c.job, FALLBACK_SHORT)]);
  });
  it("an existing final line is still honoured (no insert) and a job_events read is made once per job", async () => {
    const { w, job } = world({ id: "e5", events: [{ message: SHORT_COUNT }] });
    await run(w);
    expect(w.inserted).toEqual([]); expect(w.eventReads).toEqual([job]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------
describe("3. an unparseable updated_at => skipped before anything else is read or written", () => {
  it.each([["a word", "not-a-date"], ["an empty string", ""], ["null", null], ["undefined", undefined], ["a malformed ISO date", "2026-13-45T99:99:99Z"]])("%s", async (_l, updatedAt) => {
    const { w } = world({ id: "t1", updatedAt });
    const res = await run(w);
    expect(w.inserted).toEqual([]); expect(w.eventReads).toEqual([]); expect(res).toEqual({ considered: 1, written: 0 });
  });
  it("the control: a valid updated_at 181 s old IS written (so the skips above are about the date)", async () => {
    const { w, job } = world({ id: "t2", ageSec: 181 });
    await run(w);
    expect(w.inserted).toEqual([row(job, FALLBACK_SHORT)]);
  });
  it("the quiet boundary: 180 s is written, 179 s is not", async () => {
    const a = world({ id: "t3", ageSec: 180 }); await run(a.w); expect(a.w.inserted).toEqual([row(a.job, FALLBACK_SHORT)]);
    const b = world({ id: "t4", ageSec: 179 }); await run(b.w); expect(b.w.inserted).toEqual([]); expect(b.w.eventReads).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------
describe("4. a download that rejects => the exact fallback", () => {
  it("the download REJECTS (throws), short delivery => count + neutral reason", async () => {
    const { w, job } = world({ id: "d1", downloadMode: "reject" });
    await run(w);
    expect(w.inserted).toEqual([row(job, FALLBACK_SHORT)]);
  });
  it("the download REJECTS, full delivery => the count only", async () => {
    const { w, job } = world({ id: "d2", x: 5, n: 5, downloadMode: "reject" });
    await run(w);
    expect(w.inserted).toEqual([row(job, FALLBACK_FULL)]);
  });
  it("the download answers {error} => the same fallback; no data and no error => the same fallback", async () => {
    const a = world({ id: "d3", downloadMode: "error", file: stored() }); await run(a.w); expect(a.w.inserted).toEqual([row(a.job, FALLBACK_SHORT)]);
    const b = world({ id: "d4", downloadMode: "nodata", file: stored() }); await run(b.w); expect(b.w.inserted).toEqual([row(b.job, FALLBACK_SHORT)]);
  });
  it("a valid file that cannot be downloaded is NOT used (the fallback wins, not the stored line)", async () => {
    const { w, job } = world({ id: "d5", downloadMode: "reject", file: stored() });
    await run(w);
    expect(w.inserted[0].message).toBe(FALLBACK_SHORT); expect(w.inserted[0].message).not.toBe(GOOD_STORED); expect(w.inserted[0].job_id).toBe(job);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------
describe("5. a valid stored final line is used EXACTLY; an invalid one falls back EXACTLY", () => {
  it("the fixtures are what they claim: GOOD_STORED is clean customer text, the three bad ones carry an issue", () => {
    expect(checkCustomerText(GOOD_STORED).issues).toEqual([]);
    for (const bad of ["apify returned an error", "provider failure 3", "انقطاع في Apify"]) expect(checkCustomerText(`${SHORT_COUNT} السبب: ${bad}`).issues.length).toBeGreaterThan(0);
  });
  it("valid, short delivery => the stored messageAr, character for character (not the fallback)", async () => {
    const { w, job } = world({ id: "v1", file: stored() });
    await run(w);
    expect(w.inserted).toEqual([row(job, GOOD_STORED)]);
    expect(w.inserted[0].message).not.toBe(FALLBACK_SHORT);
  });
  it("valid, full delivery (5 of 5): the stored line is used exactly, even though the fallback would be the bare count", async () => {
    const full = `${FULL_COUNT} وهذا كل ما طلبته.`;
    expect(checkCustomerText(full).issues).toEqual([]);
    const { w, job } = world({ id: "v2", x: 5, n: 5, file: stored({}, 5, 5, full) });
    await run(w);
    expect(w.inserted).toEqual([row(job, full)]);
  });
  const invalid: [string, string, number, number][] = [
    ["wrong delivered count (file says 4, job has 3)", stored({}, 4, 5), 3, 5],
    ["wrong target (file says 6, job has 5)", stored({}, 3, 6), 3, 5],
    ["wrong version (v 2)", stored({ v: 2 }), 3, 5],
    ["no version field", JSON.stringify({ deliveredUnits: 3, targetMax: 5, messageAr: GOOD_STORED }), 3, 5],
    ["wrong prefix (a different count in the message)", stored({}, 3, 5, "المسلَّم ٤ من ٥ مطلوب. السبب: وصلنا إلى آخر النتائج المتاحة لهذا الطلب."), 3, 5],
    ["wrong prefix (the message does not start with the count)", stored({}, 3, 5, "السبب: وصلنا إلى آخر النتائج المتاحة لهذا الطلب."), 3, 5],
    ["a customer-text issue (a provider name in English)", stored({}, 3, 5, `${SHORT_COUNT} السبب: apify returned an error`), 3, 5],
    ["a customer-text issue (a technical word)", stored({}, 3, 5, `${SHORT_COUNT} السبب: انقطاع في Apify`), 3, 5],
    ["a customer-text issue (an ASCII digit)", stored({}, 3, 5, `${SHORT_COUNT} السبب: provider failure 3`), 3, 5],
    ["a non-string message", stored({ messageAr: 42 }), 3, 5],
    ["a missing message", JSON.stringify({ v: 1, deliveredUnits: 3, targetMax: 5 }), 3, 5],
    ["string numbers instead of numbers", stored({ deliveredUnits: "3", targetMax: "5" }), 3, 5],
  ];
  it.each(invalid)("invalid: %s => the exact fallback (short)", async (_l, file, x, n) => {
    const { w, job } = world({ id: "i1", x, n, file });
    await run(w);
    expect(w.inserted).toEqual([row(job, FALLBACK_SHORT)]);
  });
  it("invalid stored line on a FULL delivery => the bare count", async () => {
    const { w, job } = world({ id: "i2", x: 5, n: 5, file: stored({ v: 2 }, 5, 5, `${FULL_COUNT} وهذا كل ما طلبته.`) });
    await run(w);
    expect(w.inserted).toEqual([row(job, FALLBACK_FULL)]);
  });
  it("two jobs in one pass: the one with a valid file keeps its line, the one with an invalid file gets the fallback", async () => {
    const a = world({ id: "i3a", file: stored() }); const b = world({ id: "i3b", file: stored({ v: 2 }) });
    const w: World = { quotes: [...a.w.quotes, ...b.w.quotes], jobs: { ...a.w.jobs, ...b.w.jobs }, events: {}, eventMode: {}, files: { ...a.w.files, ...b.w.files }, downloadMode: {}, inserted: [], eventReads: [] };
    const res = await run(w);
    expect(res).toEqual({ considered: 2, written: 2 });
    expect(w.inserted).toEqual([row(a.job, GOOD_STORED), row(b.job, FALLBACK_SHORT)]);
  });
});
