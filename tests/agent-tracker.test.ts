import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { remainingFrom, remainingLineAr, stageMetricLines, trackMission, type TrackerEventInput, type TrackerStageInput } from "../src/lib/agentMission/tracker";
import { customerMissionView, type EventForCustomer, type MissionRowForCustomer } from "../src/lib/agentMission/customerView";
import { AgentMissionCardBody } from "../src/components/mission/AgentMissionCard";
import { LIVE_RUN_END, LIVE_RUN_EVENTS, LIVE_RUN_START, LIVE_RUN_STAGES } from "./helpers/liveRunEvents";

/**
 * THE LIVE TRACKER, for every mission type: counts that only grow and never freeze while work continues, a time left that is hidden rather than jumping, and the live lines in the noun of each stage. The first test replays the real
 * events of the live run of 2026-10-28 (60 pages read in four passes, rows saved in lumps).
 */
const at = (s: number) => new Date(Date.parse("2026-10-28T10:00:00Z") + s * 1000).toISOString();
const ev = (id: number, s: number, counts: Record<string, number>): TrackerEventInput => ({ id, counts, created_at: at(s) });

describe("E. the real run: pages and items found are cumulative and never regress or freeze; the file count is the saved count", () => {
  it("replayed event by event: every number at every moment is at least what it was before", () => {
    const stage = { ...LIVE_RUN_STAGES[0], yieldShare: 0.7 };
    let prev = { pages: 0, found: 0, saved: 0, ratio: 0 };
    for (let i = 1; i <= LIVE_RUN_EVENTS.length; i += 1) {
      const events = LIVE_RUN_EVENTS.slice(0, i);
      const r = trackMission({ stages: [stage], events, now: Date.parse(events[events.length - 1].created_at) });
      const s = r.stages[0];
      expect(s.pagesRead).toBeGreaterThanOrEqual(prev.pages);
      expect(s.found).toBeGreaterThanOrEqual(prev.found);
      expect(s.saved).toBeGreaterThanOrEqual(prev.saved);
      expect(r.ratio).toBeGreaterThanOrEqual(prev.ratio);
      prev = { pages: s.pagesRead, found: s.found, saved: s.saved, ratio: r.ratio };
    }
    // the four passes over the same source add up: 20 + 15 + 15 + 10 pages = 60, and 1,200 items found (the old panel said «قُرئت ٢٠ صفحة» for the whole run)
    expect(prev).toMatchObject({ pages: 60, found: 1200, saved: 300 });
  });

  it("while the source is being read, EVERY page moves the pages read and the items found (nothing is frozen)", () => {
    const collecting = LIVE_RUN_EVENTS.filter((e) => typeof e.counts?.pages === "number");
    let lastFound = 0;
    let lastPages = 0;
    for (let i = 0; i < collecting.length; i += 1) {
      const r = trackMission({ stages: [{ ...LIVE_RUN_STAGES[0], yieldShare: 0.7 }], events: LIVE_RUN_EVENTS.filter((e) => e.id <= collecting[i].id), now: Date.parse(collecting[i].created_at) });
      expect(r.stages[0].found, `event ${collecting[i].id}`).toBeGreaterThan(lastFound);
      expect(r.stages[0].pagesRead).toBeGreaterThan(lastPages);
      lastFound = r.stages[0].found;
      lastPages = r.stages[0].pagesRead;
    }
  });

  it("the whole-mission bar moves from the first page (it was «٠» until about page 11)", () => {
    const early = trackMission({ stages: [{ ...LIVE_RUN_STAGES[0], yieldShare: 0.7 }], events: LIVE_RUN_EVENTS.slice(0, 3), now: Date.parse(LIVE_RUN_EVENTS[2].created_at) });
    expect(early.stages[0].saved).toBe(0);
    expect(early.ratio).toBeGreaterThan(0.05);
    expect(early.stages[0].state).toBe("running");
  });

  it("the time left, sampled every 5 seconds over the real run, is never «أقل من دقيقة» early, never goes down and then sharply up, and shows nothing when the speed is not steady", () => {
    const shown: Array<number | null> = [];
    for (let now = LIVE_RUN_START; now <= LIVE_RUN_END; now += 5000) {
      const events = LIVE_RUN_EVENTS.filter((e) => Date.parse(e.created_at) <= now);
      const r = trackMission({ stages: [{ ...LIVE_RUN_STAGES[0], yieldShare: 0.7 }], events, now });
      shown.push(r.remainingSeconds);
      const line = remainingLineAr(r.remainingSeconds, r.ratio);
      if (line) expect(line).not.toBe(r.ratio < 0.95 ? "المتبقي أقل من دقيقة" : "");
    }
    // between two shown values the clock moved 5 seconds: the value may fall by that and may rise by at most a minute, and a fall of more than two minutes is never followed by a rise of more than two
    for (let i = 1; i < shown.length; i += 1) if (shown[i] !== null && shown[i - 1] !== null) expect(shown[i]! - shown[i - 1]!).toBeLessThanOrEqual(60);
    for (let i = 2; i < shown.length; i += 1) {
      const [a, b, c] = [shown[i - 2], shown[i - 1], shown[i]];
      if (a !== null && b !== null && c !== null) expect(b < a - 120 && c > b + 120).toBe(false);
    }
  });
});

describe("E. a steady mission shows a stable time left that counts down", () => {
  // 30 pages, 3 seconds each, one stage of 600 items
  const steady = (): TrackerEventInput[] => Array.from({ length: 30 }, (_, i) => ev(i + 1, 3 * (i + 1), { pages: i + 1, rows: (i + 1) * 20, planned: 600 }));
  it("hidden at first, then shown, then smaller and smaller; the line is whole minutes", () => {
    const stage: TrackerStageInput = { n: 1, titleAr: "التغريدات", expectedRows: 600, deliver: true };
    const series: Array<number | null> = [];
    const events = steady();
    for (let i = 1; i <= events.length; i += 1) series.push(trackMission({ stages: [stage], events: events.slice(0, i), now: Date.parse(events[i - 1].created_at) }).remainingSeconds);
    expect(series[0]).toBeNull();
    const shown = series.filter((x): x is number => x !== null);
    expect(shown.length).toBeGreaterThan(0);
    for (let i = 1; i < shown.length; i += 1) expect(shown[i]).toBeLessThanOrEqual(shown[i - 1] + 5);
    expect(remainingLineAr(90, 0.5)).toBe("المتبقي نحو دقيقتين");
    expect(remainingLineAr(200, 0.5)).toBe("المتبقي نحو ٣ دقائق");
    expect(remainingLineAr(3600, 0.5)).toBe("المتبقي نحو ساعة");
    expect(remainingLineAr(20, 0.5)).toBeNull();
    expect(remainingLineAr(20, 0.97)).toBe("المتبقي أقل من دقيقة");
    expect(remainingLineAr(null, 0.5)).toBeNull();
  });

  it("estimates that disagree are hidden; nothing for a long quiet; counting down between events", () => {
    const base = Date.parse(at(0));
    // estimates of 60, 65 and 9 seconds: the speed is not steady
    const samples = [{ at: base + 50_000, p: 0.3 }, { at: base + 60_000, p: 0.5 }, { at: base + 70_000, p: 0.52 }, { at: base + 80_000, p: 0.9 }];
    expect(remainingFrom(samples, base, base + 80_000)).toBeNull();
    const steadySamples = [1, 2, 3, 4].map((k) => ({ at: base + 40_000 + k * 5_000, p: 0.2 + k * 0.05 }));
    const now = base + 60_000;
    const first = remainingFrom(steadySamples, base, now);
    expect(first).not.toBeNull();
    expect(remainingFrom(steadySamples, base, now + 10_000)!).toBeCloseTo(first! - 10, 5);
    expect(remainingFrom(steadySamples, base, now + 120_000)).toBeNull();
  });
});

describe("E. four mission types: stages, nouns and live lines (no «صف» or «سجل», Arabic-Indic digits)", () => {
  const MISSIONS: Array<{ name: string; stages: TrackerStageInput[]; events: TrackerEventInput[]; expectLines: string[][] }> = [
    { name: "X posts", stages: [{ n: 1, titleAr: "التغريدات التي تذكر محمد صلاح", expectedRows: 300, deliver: true }],
      events: [ev(1, 5, { pages: 3, rows: 60, planned: 300 }), ev(2, 20, { pages: 9, rows: 180, planned: 300 }), ev(3, 25, { stage: 1, saved: 110, planned: 300, checked: 180, accepted: 110, excluded: 70, pending: 0 })],
      expectLines: [["وُجد ١٨٠ تغريدة في ٩ صفحات من المصدر", "فُحص ١٨٠: قُبل ١١٠، واستُبعد ٧٠"]] },
    { name: "Facebook posts and their comments", stages: [{ n: 1, titleAr: "المنشورات", expectedRows: 20, deliver: true }, { n: 2, titleAr: "تعليقات كل منشور", expectedRows: 100, parent_key: "posts", deliver: true } as TrackerStageInput],
      events: [ev(1, 5, { pages: 1, rows: 20, planned: 20 }), ev(2, 8, { stage: 1, saved: 20, planned: 20, checked: 20, accepted: 20, excluded: 0, pending: 0 }), ev(3, 12, { pages: 1, rows: 10, planned: 100 }), ev(4, 15, { pages: 2, rows: 25, planned: 100 })],
      expectLines: [["وُجد ٢٠ منشورًا في صفحة واحدة من المصدر", "فُحص ٢٠: قُبل ٢٠"], ["وُجد ٢٥ تعليقًا في صفحتين من المصدر"]] },
    { name: "TikTok comments", stages: [{ n: 1, titleAr: "تعليقات كل فيديو", expectedRows: 120, deliver: true }],
      events: [ev(1, 5, { pages: 2, rows: 40, planned: 120 })], expectLines: [["وُجد ٤٠ تعليقًا في صفحتين من المصدر"]] },
    { name: "companies and employees", stages: [{ n: 1, titleAr: "الشركات", expectedRows: 3, deliver: true }, { n: 2, titleAr: "موظفو كل شركة", expectedRows: 6, deliver: true }],
      events: [ev(1, 5, { pages: 1, rows: 3, planned: 3 }), ev(2, 7, { stage: 1, saved: 3, planned: 3, checked: 3, accepted: 3, excluded: 0, pending: 0 })],
      expectLines: [["وُجد ٣ شركات في صفحة واحدة من المصدر", "فُحص ٣: قُبل ٣"], []] },
    { name: "Google Maps reviews", stages: [{ n: 1, titleAr: "تقييمات المكان", expectedRows: 200, deliver: true }],
      events: [ev(1, 5, { pages: 1, rows: 10, planned: 200 }), ev(2, 8, { pages: 2, rows: 20, planned: 200 }), ev(3, 11, { stage: 1, saved: 20, planned: 200 })],
      expectLines: [["وُجد ٢٠ تقييمًا في صفحتين من المصدر"]] },
  ];

  it.each(MISSIONS)("$name: the live lines of each stage, in its own noun", ({ stages, events, expectLines }) => {
    const r = trackMission({ stages, events, now: Date.parse(events[events.length - 1].created_at) + 1000 });
    r.stages.forEach((s, i) => expect(stageMetricLines(s)).toEqual(expectLines[i]));
    for (const line of r.stages.flatMap((s) => stageMetricLines(s))) expect(line).not.toMatch(/صف |صفًا|صفوف|سجل|[0-9]/);
  });

  it.each(MISSIONS)("$name: counts only grow when events repeat, arrive out of order, or a smaller number comes late", ({ stages, events }) => {
    const first = trackMission({ stages, events, now: Date.parse(at(60)) });
    const shuffled = [...events].reverse();
    const again = trackMission({ stages, events: [...shuffled, ...events, { ...events[0], id: 99 }], now: Date.parse(at(60)) });
    for (let i = 0; i < stages.length; i += 1) {
      expect(again.stages[i].found).toBeGreaterThanOrEqual(first.stages[i].found);
      expect(again.stages[i].saved).toBe(first.stages[i].saved);
    }
  });

  it("comments are attributed to the stage that is open: the posts are finished, so the comment pages belong to the comments", () => {
    const m = MISSIONS[1];
    const r = trackMission({ stages: m.stages, events: m.events, now: Date.parse(at(20)) });
    expect(r.stages[0]).toMatchObject({ found: 20, saved: 20, state: "done" });
    expect(r.stages[1]).toMatchObject({ found: 25, pagesRead: 2, saved: 0, state: "running" });
    expect(r.ratio).toBeGreaterThan(0.1);
  });

  it("a mission that finished is 100% and shows no time left", () => {
    const m = MISSIONS[0];
    const r = trackMission({ stages: m.stages, events: m.events, finished: true, now: Date.parse(at(90)) });
    expect(r.ratio).toBe(1);
    expect(r.remainingSeconds).toBeNull();
    expect(r.stages[0].state).toBe("done");
  });
});

describe("E. the panel and the compact card are drawn from the tracker", () => {
  const plan = { summary_ar: "ستحصل على تغريدات عن محمد صلاح.", assumptions_ar: ["المقصود: محمد صلاح لاعب كرة القدم المصري."], stages: [{ key: "t", title_ar: "التغريدات التي تذكر محمد صلاح", expected_rows: 300, parent_key: null, deliver: true, yield_share: 0.7, columns: [{ key: "created", title_ar: "التاريخ والوقت" }, { key: "text", title_ar: "نص التغريدة" }], sample_rows: [{ created: "2026-10-28T20:06:00Z", text: "محمد صلاح في الملعب" }] }], price: { unit_price_points: 0.8, reserve_points: 279, max_charge_points: 243, delivered_rows: 300, min_charge_points: 200, minimum_line_ar: "الحد الأدنى للمهمة ٢٠٠ نقطة، ولا خصم إن لم يُسلَّم شيء." }, expected_minutes: 4 };
  const mission = (over: Partial<MissionRowForCustomer> = {}): MissionRowForCustomer => ({ id: "msn_t", status: "executing", question_ar: null, plan_public: plan, reserved_points: 279, unit_price_points: 0.8, delivered_units: null, charged_points: null, summary_ar: null, files: null, created_at: at(0), ...over });
  const evc = (id: number, s: number, counts: Record<string, number>): EventForCustomer => ({ id, kind: "progress", message_ar: "يواصل الوكيل العمل", counts, created_at: at(s) });

  it("while reading and checking: the step carries the file count in its noun, the live lines and a bar that moves before anything is saved", () => {
    const events = [evc(1, 5, { pages: 3, rows: 60, planned: 300 }), evc(2, 20, { pages: 12, rows: 240, planned: 300 }), evc(3, 30, { stage: 1, saved: 0, planned: 300, checked: 160, accepted: 120, excluded: 40, pending: 0 })];
    const v = customerMissionView({ mission: mission(), events, now: Date.parse(at(32)), queue: { ahead: 0, running: 1, workerAlive: true } });
    const step = v.steps[0];
    expect(step.countAr).toBe("٠ من ٣٠٠ تغريدة");
    expect(step.metricsAr).toEqual(["وُجد ٢٤٠ تغريدة في ١٢ صفحة من المصدر", "فُحص ١٦٠: قُبل ١٢٠، واستُبعد ٤٠"]);
    expect(step.ratio).toBeGreaterThan(0.3);
    expect(step.excludedAr).toBe("استُبعد ٤٠ لأنه لا يخص طلبك");
    const html = renderToStaticMarkup(createElement(AgentMissionCardBody, { view: v, isGuest: false }));
    expect(html).toContain("وُجد ٢٤٠ تغريدة في ١٢ صفحة من المصدر");
    expect(html).toContain('data-testid="step-metrics"');
  });

  it("the plan card is compact: the price, the hold and the time are three short cells with one sentence under them (the minimum included)", () => {
    const v = customerMissionView({ mission: mission({ status: "plan_ready" }), events: [], now: Date.parse(at(1)) });
    expect(v.priceFacts).toEqual([{ labelAr: "السعر حتى", valueAr: "٢٤٣ نقطة" }, { labelAr: "حجز مؤقت", valueAr: "٢٧٩ نقطة" }, { labelAr: "الوقت المتوقع", valueAr: "نحو ٤ دقائق" }]);
    expect(v.priceNoteAr).toBe("لا يُخصم إلا ما يُسلَّم فعلًا. الحد الأدنى للمهمة ٢٠٠ نقطة، ولا خصم إن لم يُسلَّم شيء.");
    const html = renderToStaticMarkup(createElement(AgentMissionCardBody, { view: v, isGuest: false }));
    expect(html).toContain("grid-cols-3");
    expect(html).toContain("الحد الأدنى للمهمة ٢٠٠ نقطة");
    expect(html).toContain('data-testid="agent-file-contents"');
    expect(html).toContain("يضم الملف: التاريخ والوقت، نص التغريدة.");
    // phone width: the table scrolls inside its box, the buttons wrap, the cards have a 14px side padding
    expect(html).toContain("overflow-x-auto");
    expect(html).toContain("flex-wrap");
    expect(html).not.toMatch(/جُمع|صفًا|سجل/);
  });

  it("a finished mission shows, on the card itself, what was delivered of what was requested and the money exactly as the wallet shows it", () => {
    const v = customerMissionView({ mission: mission({ status: "completed", delivered_units: 250, charged_points: 202, files: [{ name: "result.xlsx", kind: "xlsx" }] }), events: [], now: Date.parse(at(900)) });
    const html = renderToStaticMarkup(createElement(AgentMissionCardBody, { view: v, isGuest: false }));
    expect(html).toContain('data-testid="agent-result-lines"');
    expect(html).toContain("تم تسليم ٢٥٠ من ٣٠٠ تغريدة.");
    expect(html).toContain("حُجز مؤقتًا ٢٧٩ نقطة، وخُصم ٢٠٢ نقطة مقابل ما سُلّم، وحجز مؤقت مُحرَّر ٢٧٩ نقطة.");
  });

  it("the page uses the tracker for the steps and the time left (no second estimate of its own)", () => {
    const view = readFileSync("src/lib/agentMission/customerView.ts", "utf8");
    expect(view).toContain("trackMission({");
    expect(view).toContain("remainingLineAr(track.remainingSeconds, track.ratio)");
    expect(view).not.toContain("estimateRemainingSeconds");
  });
});
