import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { assertReplayInvariants, readWorkbook, replay, type ReplayResult } from "./helpers/agentReplay";
import { tregResult, callIds, lastOutputId, planningFlow, type Results } from "./helpers/agentFakeWorld";
import { ENDPOINT, PER_PAGE, TOPIC, page, pages, planning } from "./helpers/engineXScenario";
import { readSnapshot } from "../agent/src/items/itemStore";
import { runExecution, type RunnerDeps } from "../agent/src/runMission";
import { abortActiveRuns } from "../agent/src/sessions";
import { createFakeDriver } from "../agent/src/fakeDriver";
import { createMemoryStore, type MemoryStore } from "../agent/src/memoryStore";
import type { ModelDriver } from "../agent/src/driver";
import { aboutWords, firstOutputId } from "./helpers/agentRelevance";

/**
 * THE SETTLEMENT IS BUILT FROM THE FILE; THE ENGINE NEVER RESTARTS A SOURCE; EVERY SHORTFALL HAS A RECORDED REASON.
 */
const REQUEST = "هات ٣٠٠ تغريدة عن محمد صلاح";

describe("B. settle from the file: the number in the file is the delivered count and the charge basis; any other number is flagged, never shown", () => {
  it("the file the customer will download holds 77 items while the log holds 300 (the live run's shape): charged for 77, flagged for the admin, and every text says 77", async () => {
    const r = await replay({
      request: REQUEST, planning: planning(), execution: () => [], answers: [pages(1)[0], ...pages(30)],
      // the storage serves, for the delivered file, a workbook of 77 items (a stale or wrong object): the read-back is what the customer would get
      makeStore: storeWithWrongFile,
    });
    const m = r.mission;
    // the log had all 300; the read-back file had 77: the customer is charged for what the FILE holds
    expect((await readSnapshot(r.store, r.missionId)).counts("tweets").accepted).toBe(300);
    expect(m.delivered_units).toBe(77);
    const unit = Number(m.unit_price_points);
    expect(m.charged_points).toBe(Math.min(Math.ceil(Math.round(77 * unit * 1e6) / 1e6 - 1e-9), Number(m.reserved_points)));
    expect(m.error).toMatch(/^admin: .*file_differs_from_store/);
    // the admin's flag (internal event) names the three numbers
    const flag = r.store.events.find((e) => e.counts && "adm_flag" in e.counts);
    expect(flag?.counts).toMatchObject({ adm_flag: 1, adm_store: 300, adm_file: 77 });
    // the customer reads 77 everywhere (panel, notice, files named by the count), never 300 or 192
    expect(r.finalView.steps[0]).toMatchObject({ savedN: 77, countAr: "٧٧ من ٣٠٠ تغريدة" });
    expect(r.finalView.resultLinesAr[0]).toBe("تم تسليم ٧٧ من ٣٠٠ تغريدة.");
    expect(r.notices[0].facts).toMatchObject({ delivered: 77 });
    expect(r.notices[0].kind).toBe("partial");
    const text = [...r.finalView.resultLinesAr, r.finalView.resultSummaryAr ?? "", r.finalView.steps[0].countAr ?? ""].join(" ");
    expect(text).not.toMatch(/تم تسليم ٣٠٠|١٩٢/);
  });

  it("the file and the log agree: nothing flagged, no flag event", async () => {
    const r = await replay({ request: REQUEST, planning: planning(), execution: () => [], answers: [pages(1)[0], ...pages(30)] });
    expect(r.mission.error).toBeNull();
    expect(r.store.events.some((e) => e.counts && "adm_flag" in e.counts)).toBe(false);
  });
});

/** A memory store whose read-back of the delivered workbook is a DIFFERENT workbook (77 items): what a stale or wrong object would give. */
function storeWithWrongFile(): MemoryStore {
  const store = createMemoryStore();
  const real = store.getFileBytes.bind(store);
  store.getFileBytes = async (missionId, rel) => {
    const bytes = await real(missionId, rel);
    if (rel !== "result/result.xlsx" || !bytes) return bytes;
    // a workbook with the same sheets and 77 items instead of 300
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet("ملخص المهمة").addRow(["المرحلة"]);
    const sheet = wb.addWorksheet("التغريدات");
    sheet.addRow(["نص التغريدة"]);
    for (let i = 0; i < 77; i += 1) sheet.addRow([`تغريدة ${i}`]);
    return Buffer.from(await wb.xlsx.writeBuffer());
  };
  return store;
}

describe("the engine never restarts a source: a mission put back in the queue resumes from the cursor its log recorded", () => {
  it("stopped after 8 pages (the memory guard), taken again: 19 pages in all, no page read twice, 300 delivered, the file and the charge are one number", async () => {
    let captured: RunnerDeps | null = null;
    let calls = 0;
    const r = await replay({
      request: REQUEST, planning: planning(), execution: () => [], answers: [pages(1)[0], ...pages(30)],
      deps: (base) => {
        const inner = base.call!;
        // after the 9th provider call of the mission (1 planning + 8 pages) the worker's memory guard stops the run
        const call: RunnerDeps["call"] = async (o) => { const out = await inner(o); calls += 1; if (calls === 9) abortActiveRuns("memory"); return out; };
        captured = { ...base, call };
        return captured;
      },
    });
    expect(r.mission.status).toBe("approved");
    expect(r.mission.delivered_units).toBeNull();
    const mid = await readSnapshot(r.store, r.missionId);
    expect(mid.counts("tweets").pages).toBe(8);
    expect(mid.stage("tweets").streams.get("root")).toMatchObject({ pages: 8, ended: false, cursor: `cur_${8 * PER_PAGE}` });
    // the second run: claimed again, resumes
    const claimed = await r.store.claimMission("w_replay", 120);
    expect(claimed?.id).toBe(r.missionId);
    await runExecution(captured!, r.store.missions.get(r.missionId)!);
    const done = r.store.missions.get(r.missionId)!;
    expect(done.status).toBe("completed");
    expect(done.delivered_units).toBe(300);
    // 1 planning call + 19 pages: the first 8 pages were NOT bought again
    expect(calls).toBe(1 + 19);
    const snap = await readSnapshot(r.store, r.missionId);
    expect(snap.counts("tweets")).toMatchObject({ pages: 19, accepted: 300, duplicates: 0 });
    // the cursors the calls were made with form one unbroken chain: the second run did not start from the first page
    const execCalls = r.call.mock.calls.slice(1).map((c) => (c[0] as { params: Record<string, unknown> }).params.cursor ?? null);
    expect(execCalls).toEqual([null, ...Array.from({ length: 18 }, (_, i) => `cur_${(i + 1) * PER_PAGE}`)]);
    const wb = await readWorkbook({ ...r, mission: done } as ReplayResult);
    expect(wb.getWorksheet("التغريدات")!.rowCount).toBe(301);
  });
});

describe("C. no shortfall while matching items are still needed and the source has more; the shortfall sentence is the recorded reason", () => {
  const ended = (n: number) => [pages(1)[0], ...Array.from({ length: n }, (_, p) => tregResult(page(p * PER_PAGE, p + 1 < n ? `cur_${(p + 1) * PER_PAGE}` : null), 0.00075))];
  const run = (answers: ReturnType<typeof ended>) => replay({ request: REQUEST, planning: planning(), execution: () => [], answers });

  it("the source ends after 10 pages (160 matching tweets): the stop reason is the source's end, the sentence says so, and every one of the 200 found items was checked", async () => {
    const r = await run(ended(10));
    expect(r.mission.status).toBe("completed");
    expect(r.mission.delivered_units).toBe(160);
    const snap = await readSnapshot(r.store, r.missionId);
    expect(snap.stage("tweets").stop).toBe("source_exhausted");
    expect(snap.counts("tweets")).toMatchObject({ found: 200, accepted: 160, excluded: 40, unchecked: 0, pending: 0 });
    expect(r.mission.summary_ar).toBe("لم يكتمل العدد المطلوب لأن المصدر لم يعد يعطي نتائج أخرى لهذا الطلب، ولم يُخصم إلا مقابل ما سُلّم.");
    expect(r.finalView.phase).toBe("partial");
    expect(r.notices[0].kind).toBe("partial");
    expect(r.notices[0].facts.shortfallClauseAr).toBe("لأن المصدر لم يعد يعطي نتائج أخرى لهذا الطلب");
  });

  it("the mission's call budget refuses the 6th page: the stop reason is the budget, and the sentence says the reading budget ended (not «this is all that matched»)", async () => {
    let n = 0;
    const r = await replay({ request: REQUEST, planning: planning(), execution: () => [], answers: [pages(1)[0], ...pages(30)], deps: (base) => ({ ...base, call: async (o) => { n += 1; return base.call!(o); }, recorder: { ...base.recorder, async reserve(a) { return n >= 6 ? { allowed: false, costId: null, reason: "cap" as const } : base.recorder.reserve(a); } } }) });
    const snap = await readSnapshot(r.store, r.missionId);
    expect(snap.stage("tweets").stop).toBe("daily_cap");
    expect(r.mission.summary_ar).toContain("الحد اليومي للقراءة من المصادر اكتمل");
    expect(r.mission.summary_ar).not.toContain("هذا كل ما وُجد");
    // what was read before the stop is delivered and charged, nothing more
    expect(r.mission.delivered_units).toBe(snap.counts("tweets").accepted);
    expect(snap.counts("tweets").unchecked).toBe(0);
  });

  it("the time is up before the target: the stop reason is the time limit", async () => {
    let clock = 0;
    const r = await replay({ request: REQUEST, planning: planning(), execution: () => [], answers: [pages(1)[0], ...pages(30)], deps: (base) => ({ ...base, call: async (o) => { clock += 1; return base.call!(o); } }) });
    // (the default time limit is hours: this run is the control that it is not hit)
    expect((await readSnapshot(r.store, r.missionId)).stage("tweets").stop).toBe("target_reached");
    expect(clock).toBeGreaterThan(0);
  });
});

describe("C. the MODEL cannot end a mission early: finish is refused while matching items are still needed and a source has more pages", () => {
  const Q = 40;
  const planFor = (rows: number) => planningFlow({
    progress: "أبحث عن أرخص مصدر مناسب للتغريدات", searchWords: ["tweets", "search"], platform: "x",
    sample: [{ endpoint: ENDPOINT, params: { query: TOPIC, limit: PER_PAGE }, why: "the cheaper sources return no author or link fields in their catalog description" }],
    sampleCode: "return inputs.call_0001.output.data.items.slice(0, 3).map(t => ({ id: t.id, text: t.text, url: t.url, author: t.author, date: t.createdAt }))",
    plan: (res: Results) => ({
      summary_ar: "ستحصل على تغريدات عن محمد صلاح.",
      stages: [{ key: "tweets", title_ar: "التغريدات", endpoint_id: ENDPOINT, expected_rows: rows, parent_key: null, deliver: true,
        columns: [{ key: "text", title_ar: "نص التغريدة" }, { key: "url", title_ar: "رابط التغريدة" }, { key: "author", title_ar: "الحساب" }, { key: "date", title_ar: "التاريخ والوقت" }],
        sample_rows: (res.filter((x) => x.tool === "run_code")[0].result.result as unknown[]).slice(0, 3), measured_by: [callIds(res)[0]], relevance: aboutWords([TOPIC]), yield_from: firstOutputId(res) }],
    }),
  });
  // collect_pages hands the joined RAW rows (an array) to run_code
  const MAP = "const out = []; for (const rows of Object.values(inputs)) for (const t of rows) out.push({ id: t.id, text: t.text, url: t.url, author: t.author, date: t.createdAt }); return out;";

  it("three refusals, then the model's wish is recorded as «model_stopped» and the sentence does not claim «this is all that matched»", async () => {
    const r = await replay({
      deps: (base) => ({ ...base, engine: false }),
      request: "هات ٤٠ تغريدة عن محمد صلاح", planning: planFor(Q),
      execution: () => [
        { tool: "collect_pages", args: { endpoint_id: ENDPOINT, params: { query: TOPIC, limit: PER_PAGE }, target_rows: 25, max_pages: 1 } },
        { tool: "run_code", args: (res: Results) => ({ code: MAP, files: [String([...res].reverse().find((x) => x.tool === "collect_pages")!.result.output_id)] }) },
        { tool: "save_rows", args: (res: Results) => ({ stage_key: "tweets", from_output: lastOutputId(res) }) },
        { tool: "finish", args: { outcome: "delivered", summary_ar: "انتهيت." } },
        { tool: "finish", args: { outcome: "delivered", summary_ar: "انتهيت." } },
        { tool: "finish", args: { outcome: "delivered", summary_ar: "انتهيت." } },
        { tool: "finish", args: { outcome: "delivered", summary_ar: "انتهيت." } },
      ],
      answers: [pages(1)[0], ...pages(3)],
    });
    const finishes = r.executionDriver.results.filter((x) => x.tool === "finish");
    expect(finishes.slice(0, 3).every((f) => f.result.ok === false && String(f.result.error).startsWith("do not finish yet"))).toBe(true);
    expect(finishes[3].result.ok).toBe(true);
    const snap = await readSnapshot(r.store, r.missionId);
    expect(snap.stage("tweets").stop).toBe("model_stopped");
    expect(r.mission.summary_ar).toContain("القراءة توقفت قبل اكتمال العدد المطلوب");
    expect(r.mission.summary_ar).not.toContain("هذا كل ما وُجد");
  });

  it("a round that ends with no finish while matching items are still needed is followed by another round that continues from the log", async () => {
    const round1 = createFakeDriver([
      { tool: "collect_pages", args: { endpoint_id: ENDPOINT, params: { query: TOPIC, limit: PER_PAGE }, target_rows: 25, max_pages: 1 } },
      { tool: "run_code", args: (res: Results) => ({ code: MAP, files: [String([...res].reverse().find((x) => x.tool === "collect_pages")!.result.output_id)] }) },
      { tool: "save_rows", args: (res: Results) => ({ stage_key: "tweets", from_output: lastOutputId(res) }) },
    ]);
    const round2 = createFakeDriver([
      { tool: "collect_pages", args: { endpoint_id: ENDPOINT, params: { query: TOPIC, limit: PER_PAGE }, target_rows: 25, max_pages: 1 } },
      { tool: "run_code", args: (res: Results) => ({ code: MAP, files: [String([...res].reverse().find((x) => x.tool === "collect_pages")!.result.output_id)] }) },
      { tool: "save_rows", args: (res: Results) => ({ stage_key: "tweets", from_output: lastOutputId(res) }) },
      { tool: "finish", args: { outcome: "delivered", summary_ar: "سُلّمت التغريدات المطابقة لطلبك." } },
    ]);
    let rounds = 0;
    // the planning run keeps the harness's own fake model; the execution phase gets the two scripted rounds
    const r = await replay({
      deps: (base) => ({ ...base, engine: false, driver: { run: (input) => (input.phase === "planning" ? base.driver.run(input) : (rounds++ === 0 ? round1 : round2).run(input)) } as ModelDriver }),
      request: "هات ٤٠ تغريدة عن محمد صلاح", planning: planFor(Q), execution: () => [], answers: [pages(1)[0], ...pages(3)],
    });
    // round 1 saved 16 of 40 and ended with no finish; round 2 saved 16 more and its finish was REFUSED (the source has more pages); round 3 read the third page and reached the 40 bought: finish was then accepted
    expect(rounds).toBe(3);
    expect(r.mission.status).toBe("completed");
    expect(r.mission.delivered_units).toBe(40);
    const snap = await readSnapshot(r.store, r.missionId);
    expect(snap.counts("tweets")).toMatchObject({ accepted: 40, duplicates: 0, pages: 0 });
    expect(snap.stage("tweets").stop).toBeNull();
  });
});

describe("C. the review: items the model could not review within the budget stay PENDING, the recorded reason is the review's limit, and the sentence says so", () => {
  const CONTEXT_SPEC = { subject_ar: "محمد صلاح لاعب كرة القدم", terms: [TOPIC], context_terms: ["هدف"], text_columns: ["text"], min_own_words: 0, full_name_is_enough: false };
  // a third of the tweets carry the name and a context word (the rule accepts them), a third carry the name alone (uncertain: the model decides), a third are about something else
  const mixedPage = (offset: number, next: string | null) => tregResult({ output: { data: { items: Array.from({ length: PER_PAGE }, (_, i) => {
    const n = offset + i;
    const text = n % 3 === 0 ? `${TOPIC} يسجل هدفًا رقم ${n}` : n % 3 === 1 ? `أعتقد أن ${TOPIC} لاعب مختلف رقم ${n}` : `أخبار عامة رقم ${n}`;
    return { id: `18${String(n).padStart(6, "0")}`, text, url: `https://x.example/u/status/18${String(n).padStart(6, "0")}`, author: `user${n % 40}`, createdAt: "2026-10-20T10:00:00Z" };
  }), nextCursor: next } } }, 0.00075);
  const planWithContext = () => planningFlow({
    progress: "أبحث عن أرخص مصدر مناسب للتغريدات", searchWords: ["tweets", "search"], platform: "x",
    sample: [{ endpoint: ENDPOINT, params: { query: TOPIC, limit: PER_PAGE }, why: "the cheaper sources return no author or link fields in their catalog description" }],
    sampleCode: "return inputs.call_0001.output.data.items.map(t => ({ id: t.id, text: t.text, url: t.url, author: t.author, date: t.createdAt }))",
    plan: (res: Results) => ({
      summary_ar: "ستحصل على ٣٠٠ تغريدة عن محمد صلاح.",
      stages: [{ key: "tweets", title_ar: "التغريدات", endpoint_id: ENDPOINT, expected_rows: 300, parent_key: null, deliver: true,
        columns: [{ key: "text", title_ar: "نص التغريدة" }, { key: "url", title_ar: "رابط التغريدة" }, { key: "author", title_ar: "الحساب" }, { key: "date", title_ar: "التاريخ والوقت" }],
        sample_rows: [0, 3, 6].map((n) => ({ id: `18${String(n).padStart(6, "0")}`, text: `${TOPIC} يسجل هدفًا رقم ${n}`, url: `https://x.example/u/status/18${String(n).padStart(6, "0")}`, author: `user${n}`, date: "2026-10-20T10:00:00Z" })), measured_by: [callIds(res)[0]], relevance: CONTEXT_SPEC, yield_from: firstOutputId(res) }],
    }),
  });

  it("the review has budget for one batch only: the items it could not reach are PENDING (never thrown away, never delivered), the stop reason is «review_limit», and the file holds the rule's and the first batch's items", async () => {
    let reviewCalls = 0;
    // the first call costs more than the whole review budget: after it the budget is spent
    const reviewCall = async ({ user }: { user: string }) => { reviewCalls += 1; const n = (user.match(/^\d+\./gm) ?? []).length; return { text: JSON.stringify(Array(n).fill(1)), usage: { input_tokens: 4_000_000, output_tokens: 10 } }; };
    const pagesOf = (n: number) => Array.from({ length: n }, (_, p) => mixedPage(p * PER_PAGE, p + 1 < n ? `cur_${(p + 1) * PER_PAGE}` : null));
    const r = await replay({ request: REQUEST, planning: planWithContext(), execution: () => [], answers: [mixedPage(0, "cur_20"), ...pagesOf(5)], deps: (base) => ({ ...base, reviewCall: reviewCall as any }) });
    expect(reviewCalls).toBe(1);
    const snap = await readSnapshot(r.store, r.missionId);
    const c = snap.counts("tweets");
    expect(c.found).toBe(100);
    expect(c.found).toBe(c.new + c.duplicates);
    expect(c.new).toBe(c.accepted + c.excluded + c.pending + c.unchecked);
    expect(c.pending).toBeGreaterThan(0);
    expect(c.unchecked).toBe(0);
    expect(c.acceptedByModel).toBeGreaterThan(0);
    expect(snap.stage("tweets").stop).toBe("review_limit");
    expect(r.mission.delivered_units).toBe(c.accepted);
    expect(r.mission.summary_ar).toContain("المراجعة الآلية بلغت حدّها المسموح");
    expect(r.mission.summary_ar).not.toContain("هذا كل ما وُجد");
    // what the customer receives is the file's count: pending items are in no file and no charge
    expect((await readWorkbook(r)).getWorksheet("التغريدات")!.rowCount - 1).toBe(c.accepted);
  });
});
