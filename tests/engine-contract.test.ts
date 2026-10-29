import { describe, expect, it } from "vitest";
import { assertReplayInvariants, readWorkbook, replay, type ReplayResult } from "./helpers/agentReplay";
import { SCENARIOS, X_TOPIC, xItem, xPageOf, type Scenario } from "./helpers/contractScenarios";
import { readSnapshot } from "../agent/src/items/itemStore";
import { INTERNAL_FAILURE_AR } from "../agent/src/runMission";
import { buildMissionNotice } from "../src/lib/agentMission/notices";
import { isInternalEvent } from "../src/lib/agentMission/eventText";

/**
 * THE CONTRACT BETWEEN THE PLAN AND THE ENGINE, on four mission types (X posts, Facebook posts and comments, TikTok videos and comments, companies and employees):
 *   - a mapping with NO id is carried out (ids are derived by code the way the old save path derived them), never dropped; the live failure of 2026-10-29 (msn_233fd852bc60b796777d) is the first of them;
 *   - a source that gives items while our own mapping stores none is an INTERNAL failure: the hold is released whole, the admin is flagged, the customer is told it was ours, never «nothing was found».
 */
async function sheetRows(r: ReplayResult): Promise<Record<string, number>> {
  const wb = await readWorkbook(r);
  return Object.fromEntries(wb.worksheets.slice(1).map((s) => [s.name, s.rowCount - 1]));
}

describe.each(SCENARIOS)("$name", (sc: Scenario) => {
  it("the control: a mapping with ids is carried out as before", async () => {
    const r = await replay(sc.input("normal"));
    expect(r.executionDriver.results).toEqual([]);
    assertReplayInvariants(r, { expectDelivered: sc.delivered });
    expect(await sheetRows(r)).toEqual(sc.perSheet);
  });

  it("a mapping with NO id (the replay of the failed mission): the plan is accepted, ids are derived by code, every item is delivered, counted once and charged by the file", async () => {
    const r = await replay(sc.input("idless"));
    // no model session: code carried the approved plan out
    expect(r.executionDriver.results).toEqual([]);
    expect(r.plannedPlan.stages.every((s) => s.engine !== undefined)).toBe(true);
    // the recipe says how the items are keyed: a field every item has and that is unique on the measured page, else the fingerprint of the text
    expect(r.plannedPlan.stages[0].engine?.id_field).toBe(sc.idFieldOfFirstStage);
    assertReplayInvariants(r, { expectDelivered: sc.delivered });
    expect(await sheetRows(r)).toEqual(sc.perSheet);
    expect(r.mission.status).toBe("completed");
    expect(r.mission.error).toBeNull();
    const snap = await readSnapshot(r.store, r.missionId);
    for (const stage of r.plannedPlan.stages) {
      const c = snap.counts(stage.key);
      expect(c.accepted, stage.key).toBeGreaterThan(0);
      expect(c.found).toBe(c.new + c.duplicates);
    }
    // the delivered sheet's id column holds the derived ids (the same value for the same item)
    const wb = await readWorkbook(r);
    const first = wb.worksheets[1];
    const ids = new Set<string>();
    first.eachRow((row, n) => { if (n > 1) ids.add(String(row.getCell(row.cellCount).value)); });
    expect(ids.size).toBe(first.rowCount - 1);
  });

  it("the source gives items and our own mapping stores NONE (a hidden slice in the mapping): an INTERNAL failure, the whole hold released, the admin flagged, the customer told the truth", async () => {
    const r = await replay(sc.input("trap"));
    const m = r.mission;
    // the mission and the money
    expect(m.status).toBe("failed");
    expect(m.delivered_units).toBe(0);
    expect(m.charged_points).toBe(0);
    expect(r.money.balance()).toBe(r.initialBalance);
    expect(r.money.ledger.filter((l) => l.type === "reserve")).toHaveLength(1);
    expect(r.money.ledger.filter((l) => l.type === "release")).toHaveLength(1);
    expect(r.money.ledger.some((l) => l.type === "charge")).toBe(false);
    expect(r.money.ledger.find((l) => l.type === "release")!.delta).toBe(-r.money.ledger.find((l) => l.type === "reserve")!.delta);
    expect(r.money.calls.map((c) => c.name)).toContain("release_job_atomic");
    // the admin is flagged: the mission's error and an internal event carrying what the source gave
    expect(m.error).toMatch(/^admin: engine_zero_ingest stage=\w+ source_rows=\d+/);
    const flag = r.store.events.find((e) => e.counts?.adm_flag === 1);
    expect(flag).toBeTruthy();
    expect(flag!.counts!.adm_source_rows).toBeGreaterThan(0);
    expect(flag!.counts!.adm_file).toBe(0);
    expect(isInternalEvent({ counts: flag!.counts })).toBe(true);
    // the customer: OUR failure, never an empty source
    expect(m.summary_ar).toBe(INTERNAL_FAILURE_AR);
    expect(INTERNAL_FAILURE_AR).toContain("خلل من جانبنا");
    expect(INTERNAL_FAILURE_AR).toContain("لم يُخصم منك شيء");
    const resultEvent = r.store.events.filter((e) => e.kind === "result").pop()!;
    expect(resultEvent.message_ar).toBe(INTERNAL_FAILURE_AR);
    expect(r.finalView.phase).toBe("failed");
    expect(r.finalView.endLineAr).toBe(INTERNAL_FAILURE_AR);
    expect(r.finalView.resultLinesAr.join(" ")).toContain("حجز مؤقت مُحرَّر");
    const everything = [r.finalView.endLineAr, ...r.finalView.resultLinesAr, m.summary_ar].join(" ");
    expect(everything).not.toMatch(/لم نجد|لا يوجد|المصدر لا|خالٍ من النتائج؛ لم/);
    // the notice (in-site and e-mail) says it was ours
    expect(r.notices).toHaveLength(1);
    expect(r.notices[0].kind).toBe("failed");
    expect(r.notices[0].facts).toMatchObject({ delivered: 0, cause: "internal", hasJob: true });
    const notice = buildMissionNotice(r.notices[0].kind, r.notices[0].facts, "مهمتك");
    expect(notice.body).toContain("خلل من جانبنا");
    expect(notice.body).not.toContain("لم نجد مصدرًا");
    expect(notice.email!.subject).toContain("خلل من جانبنا");
    // the item store: the source gave rows, nothing was stored
    const snap = await readSnapshot(r.store, r.missionId);
    const first = r.plannedPlan.stages[0].key;
    expect(snap.stage(first).stop).toBe("internal_error");
    expect(snap.stage(first).sourceRows).toBeGreaterThan(0);
    expect(snap.counts(first).new).toBe(0);
    // no file was built
    expect(m.files).toBeNull();
  });
});

describe("the empty source is still the empty source", () => {
  it("a source that gives NO item at all is «nothing found» (unserved, a hold released, no internal flag): only items given and none stored is our failure", async () => {
    const base = SCENARIOS[0].input("normal");
    const empty = xPageOf([], null);
    const r = await replay({ ...base, answers: [base.answers[0], { ...(base.answers[1] as object), data: empty } as never, ...base.answers.slice(2)] });
    expect(["unserved", "completed", "failed"]).toContain(r.mission.status);
    expect(r.mission.error ?? "").not.toContain("engine_zero_ingest");
  });
});

describe("the X plan of the failed mission, line by line", () => {
  it("the first tweet is a reply: it is never in the file; the same text twice is one tweet; an English tweet is not Arabic; every one of those is counted, by reason", async () => {
    const tweetText = (n: number): string => {
      const k = n % 10;
      if (k === 3) return `@fan${n} ${X_TOPIC} يسجل هدفًا رقم ${n} في المباراة`;
      if (k === 6) return `Mohamed Salah scored goal number ${n} for Liverpool tonight`;
      if (k === 8 && n >= 10) return `${X_TOPIC} يسجل هدفًا رقم ${n - 8} في المباراة`;
      return `${X_TOPIC} يسجل هدفًا رقم ${n} في المباراة`;
    };
    const page = (p: number) => xPageOf(Array.from({ length: 20 }, (_, i) => xItem(p * 20 + i, tweetText(p * 20 + i))), `cur_${(p + 1) * 20}`);
    const base = SCENARIOS[0].input("normal");
    const { tregResult } = await import("./helpers/agentFakeWorld");
    const planningRequest = base.planning.map((step) => (step.tool === "propose_plan" ? { ...step, args: (res: any) => ({ ...(step.args as (r: unknown) => Record<string, unknown>)(res), summary_ar: "ستحصل على تغريدات عربية أصلية عن محمد صلاح دون الردود.", stages: [{ ...((step.args as (r: unknown) => any)(res).stages[0]), filters: [{ kind: "exclude_replies" }, { kind: "language", lang: "ar" }] }] }) } : step));
    const r = await replay({ ...base, planning: planningRequest, answers: [tregResult(page(0), 0.00075), ...Array.from({ length: 8 }, (_, p) => tregResult(page(p), 0.00075))] });
    assertReplayInvariants(r, { expectDelivered: 60 });
    const wb = await readWorkbook(r);
    const sheet = wb.getWorksheet("التغريدات")!;
    const texts: string[] = [];
    sheet.eachRow((row, n) => { if (n > 1) texts.push(String(row.getCell(1).value)); });
    expect(texts).toHaveLength(60);
    expect(texts.some((t) => t.trim().startsWith("@"))).toBe(false);
    expect(new Set(texts.map((t) => t.replace(/\s+/g, " ").trim())).size).toBe(60);
    expect(texts.every((t) => /[؀-ۿ]/.test(t) && !/Salah/.test(t))).toBe(true);
    const snap = await readSnapshot(r.store, r.missionId);
    const c = snap.counts("tweets");
    expect(c.excludedByReason.filter_reply).toBeGreaterThan(0);
    expect(c.excludedByReason.filter_language).toBeGreaterThan(0);
    expect(c.duplicates).toBeGreaterThan(0);
    expect(c.found).toBe(c.new + c.duplicates);
    // the card said so, in words code built from the filters
    expect(r.planView.assumptionsAr).toContain("دون الردود.");
    expect(r.planView.assumptionsAr.join(" ")).toContain("العربية");
    // what the filters rejected is in the admin's sheet with its reason, never in the customer's file
    const excluded = await r.store.getFile(r.missionId, "admin/excluded.csv");
    expect(excluded).toContain("استبعاد: رد");
    expect(excluded).toContain("استبعاد: لغة أخرى");
  });
});
