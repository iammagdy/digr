import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildAsk, type Ask } from "../src/lib/agentMission/foundation/ask";
import { compilePlan, parentInputs } from "../src/lib/agentMission/foundation/compilePlan";
import { cardOf } from "../src/lib/agentMission/foundation/toolCards";
import { checkCustomerLabel, checkCustomerText } from "../src/lib/agentMission/text";
import { AGENT_JOB_POINTS_CAP } from "../src/lib/agentMission/constants";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import {
  ASK_EDIT_REJECTIONS,
  BUDGET_MAX_POINTS,
  ASK_EDIT_REJECTION_AR,
  ASK_EDITABLE_FIELDS,
  applyAskEdit,
  askCardView,
  editScopeOf,
  parseAskEdit,
  recompileWithEdit,
  type AskEdit,
} from "../src/lib/agentMission/stage2/askCard";
import { STAGE2_FLAGS, stage2Enabled, stage2FlagMode } from "../src/lib/agentMission/stage2/flags";

/**
 * STAGE 2 (docs/STAGE-2.md), the «فهمنا طلبك» card: the Ask as a typed, serializable view; the fields the customer may edit; an edit checked by code (an Arabic reason CODE when it is refused,
 * never free text); and the plan recompiled by code from the edited Ask (no model, no read). Pages: the stored, anonymised real pages of M12 (msn_5851abc92a1e6645a9cd, TikTok, call_0007 and call_0008).
 */
const catalog = loadTregCatalog();
const fixture = JSON.parse(readFileSync(new URL("./fixtures/live/replay-missions.json", import.meta.url), "utf8")) as { missions: Array<{ id: string; request: string }> };
const request = (id: string) => fixture.missions.find((m) => m.id === id)!.request;
const page = (mission: string, call: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/live/missions/${mission}/raw/${call}.json`, import.meta.url), "utf8"));
const capabilityOf = (id: string) => catalog.byId.get(id)?.capability ?? null;
const AT = Date.parse("2026-11-02T12:00:00Z");
const M12 = "msn_5851abc92a1e6645a9cd";
const M14 = "msn_b060d3347ed7660f972e";

const m12Ask = (): Ask => buildAsk(request(M12), null, AT);
const m12Base = () => {
  const ask = m12Ask();
  const card = cardOf("tikhub.tiktok.search.videos")!;
  const comments = page(M12, "call_0008");
  return { ask, base: { pool: { card, params: parentInputs(card, ask), pages: [{ callId: "call_0007", page: page(M12, "call_0007") }] }, exposure: (id: string) => ({ callId: `x_${id}`, page: comments, failed: false }), capabilityOf } };
};

describe("flags: every Stage 2 flag is OFF when it is not set", () => {
  it("unset, empty or any other word is off; only «on» and «test» turn a flag on (test: test accounts only)", () => {
    for (const name of STAGE2_FLAGS) {
      expect(stage2FlagMode(name, {})).toBe("off");
      expect(stage2FlagMode(name, { [name]: "" })).toBe("off");
      expect(stage2FlagMode(name, { [name]: "true" })).toBe("off");
      expect(stage2Enabled(name, true, {})).toBe(false);
      expect(stage2Enabled(name, false, { [name]: "test" })).toBe(false);
      expect(stage2Enabled(name, true, { [name]: "test" })).toBe(true);
      expect(stage2Enabled(name, false, { [name]: "on" })).toBe(true);
    }
    expect([...STAGE2_FLAGS].sort()).toEqual(["DIGER_STAGE2_ASK_CARD", "DIGER_STAGE2_LIVE_SHEET", "DIGER_STAGE2_QUESTION_CARDS"]);
  });
});

describe("the card view: the Ask, typed, serializable, in Arabic", () => {
  it("M12: every field the Ask holds, with its Arabic label and value, Arabic-Indic numerals, and which ones the customer may edit", () => {
    const view = askCardView(m12Ask());
    expect(view.v).toBe(1);
    expect(view.titleAr).toBe("فهمنا طلبك");
    const byKey = Object.fromEntries(view.fields.map((f) => [f.key, f]));
    expect(byKey.platform.valueAr).toBe("تيك توك");
    expect(byKey.platform.editable).toBe(false);
    expect(byKey.count.valueAr).toBe("٢");
    expect(byKey.count.editable).toBe(true);
    expect(byKey.topic.valueAr).toBe("الذكاء الاصطناعي");
    expect(byKey.topic.customerWords).toBe(true);
    expect(byKey.country.valueAr).toBe("مصر");
    expect(byKey.language.valueAr).toBe("العربية");
    expect(byKey.order.valueAr).toBe("الأكثر تعليقًا");
    expect(byKey.comments.valueAr).toBe("كل التعليقات");
    expect(byKey.replies.valueAr).toBe("كل الردود");
    expect(byKey.period.valueAr).toBe("بدون فترة محددة");
    expect(view.fields.map((f) => f.key)).toEqual(["platform", "count", "topic", "source", "period", "country", "language", "order", "comments", "commentsPerParent", "replies", "repliesPerComment", "budget"]);
  });
  it("no label and no value of code's own words breaks the customer-text rules (the customer's own words are shown as typed and marked as theirs)", () => {
    for (const id of [M12, M14, "msn_6bb78c15d116268b0b9b", "msn_e3e7632e2fb2d42f9c19", "msn_adcfafabcdebc27ff803"]) {
      for (const f of askCardView(buildAsk(request(id), null, AT)).fields) {
        expect(checkCustomerLabel(f.labelAr).issues, `${id} ${f.key} label`).toEqual([]);
        if (!f.customerWords) expect(checkCustomerText(f.valueAr).issues, `${id} ${f.key} value «${f.valueAr}»`).toEqual([]);
        if (f.input.kind === "choice") for (const o of f.input.options) expect(checkCustomerLabel(o.labelAr).issues).toEqual([]);
      }
    }
  });
  it("M14 (X, a month): the period reads as Cairo days in Arabic-Indic digits; the view survives JSON unchanged", () => {
    const view = askCardView(buildAsk(request(M14), null, AT));
    expect(view.fields.find((f) => f.key === "period")!.valueAr).toBe("من ٢٠٢٦-١٠-٠١ إلى ٢٠٢٦-١٠-٣١");
    expect(JSON.parse(JSON.stringify(view))).toEqual(view);
  });
  it("the list of editable fields is fixed in code", () => {
    expect(ASK_EDITABLE_FIELDS).toEqual(["count", "topic", "source", "period", "country", "language", "order", "comments", "commentsPerParent", "replies", "repliesPerComment", "budget"]);
  });
});

describe("an edit is checked by code; a refusal is a reason CODE with a fixed Arabic sentence", () => {
  const now = { nowMs: AT };
  const bad: Array<[unknown, string]> = [
    [{ field: "count", value: 0 }, "out_of_range"],
    [{ field: "count", value: 5001 }, "out_of_range"],
    [{ field: "count", value: 2.5 }, "not_whole_number"],
    [{ field: "count", value: "٣" }, "not_whole_number"],
    [{ field: "platform", value: "x" }, "field_locked"],
    [{ field: "price", value: 1 }, "unknown_field"],
    [{ field: "order", value: "random" }, "unknown_choice"],
    [{ field: "period", value: { from: "2026-10-31", to: "2026-10-01" } }, "period_reversed"],
    [{ field: "period", value: { from: "2026-11-01", to: "2026-12-31" } }, "period_in_future"],
    [{ field: "period", value: { from: "2026-02-30", to: "2026-03-01" } }, "period_bad_day"],
    [{ field: "country", value: "ZZ" }, "country_unknown"],
    [{ field: "topic", value: "   " }, "topic_empty"],
    [{ field: "topic", value: "س".repeat(201) }, "topic_too_long"],
    [{ field: "repliesPerComment", value: 51 }, "out_of_range"],
    [{ field: "budget", value: 0 }, "out_of_range"],
    [{ field: "budget", value: 25_001 }, "out_of_range"],
    [{ field: "language", value: "fr" }, "unknown_choice"],
    ["count=3", "unknown_field"],
  ];
  it.each(bad)("%j is refused with %s", (raw, code) => {
    const parsed = parseAskEdit(raw);
    const r = parsed.ok ? applyAskEdit(m12Ask(), parsed.edit, now) : parsed;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe(code);
  });
  it("every reason code has one fixed Arabic sentence that passes the customer-text rules", () => {
    for (const code of ASK_EDIT_REJECTIONS) expect(checkCustomerText(ASK_EDIT_REJECTION_AR[code]).issues, code).toEqual([]);
    expect(Object.keys(ASK_EDIT_REJECTION_AR).sort()).toEqual([...ASK_EDIT_REJECTIONS].sort());
  });
  it("the highest budget is the job points cap (owner decision 5): 25,000 is accepted, and the card's input says so", () => {
    expect(BUDGET_MAX_POINTS).toBe(AGENT_JOB_POINTS_CAP);
    expect(BUDGET_MAX_POINTS).toBe(25_000);
    expect(applyAskEdit(m12Ask(), { field: "budget", value: 25_000 }, now).ok).toBe(true);
    expect(askCardView(m12Ask()).fields.find((f) => f.key === "budget")!.input).toEqual({ kind: "number", min: 1, max: 25_000 });
  });
  it("a comments number on a request with no comments is refused (the stage does not exist)", () => {
    const x = buildAsk(request(M14), null, AT);
    const r = applyAskEdit(x, { field: "commentsPerParent", value: 10 }, now);
    expect(r).toEqual({ ok: false, reason: "comments_not_asked" });
  });
  it("an accepted edit returns a NEW Ask; the old one is not changed", () => {
    const ask = m12Ask();
    const before = JSON.stringify(ask);
    const r = applyAskEdit(ask, { field: "count", value: 1 }, now);
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.ask.count).toBe(1); expect(r.ask).not.toBe(ask); }
    expect(JSON.stringify(ask)).toBe(before);
  });
  it("no comments means no replies of comments (TikTok): the replies stage leaves with them", () => {
    const r = applyAskEdit(m12Ask(), { field: "comments", value: "none" }, now);
    expect(r.ok && [r.ask.comments, r.ask.replies]).toEqual(["none", "none"]);
  });
  it("a number of comments for each parent makes the comments «some»", () => {
    const r = applyAskEdit(m12Ask(), { field: "commentsPerParent", value: 5 }, now);
    expect(r.ok && [r.ask.comments, r.ask.commentsPerParent]).toEqual(["some", 5]);
  });
});

describe("which edits recompile from the pages already read, and which need a new read", () => {
  it("numbers and the budget recompile; the topic, the period, the source, the country and the language need a new read; the order needs one only when the parent tool takes an order", () => {
    const ask = m12Ask();
    const tiktok = cardOf("tikhub.tiktok.search.videos")!;
    const recompile: AskEdit[] = [{ field: "count", value: 1 }, { field: "commentsPerParent", value: 5 }, { field: "comments", value: "all" }, { field: "replies", value: "none" }, { field: "repliesPerComment", value: 3 }, { field: "budget", value: 500 }];
    for (const e of recompile) expect(editScopeOf(e, ask, tiktok), e.field).toBe("recompile");
    const reread: AskEdit[] = [{ field: "topic", value: "الروبوتات" }, { field: "period", value: { from: "2026-10-01", to: "2026-10-31" } }, { field: "country", value: "SA" }, { field: "language", value: "en" }, { field: "source", value: "قناة" }];
    for (const e of reread) expect(editScopeOf(e, ask, tiktok), e.field).toBe("new_read");
    expect(tiktok.inputs.order).toBeDefined();
    expect(editScopeOf({ field: "order", value: "newest" }, ask, tiktok)).toBe("new_read");
    const noOrder = { ...tiktok, inputs: { ...tiktok.inputs, order: undefined } };
    expect(editScopeOf({ field: "order", value: "newest" }, ask, noOrder)).toBe("recompile");
  });
});

describe("an edit recompiles the plan by code, deterministically (M12 stored pages)", () => {
  it("the count 2 -> 1: one video, fewer comments and replies, a smaller hold; the same edit twice gives the same plan", () => {
    const { ask, base } = m12Base();
    const before = compilePlan({ ...base, ask });
    if (!before.ok) throw new Error(before.reason);
    const a = recompileWithEdit(base, ask, { field: "count", value: 1 }, { nowMs: AT });
    const b = recompileWithEdit(base, ask, { field: "count", value: 1 }, { nowMs: AT });
    expect(a.kind).toBe("plan");
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    if (a.kind !== "plan") return;
    expect(a.result.plan.stages.map((s) => [s.key, s.planned_rows])).toEqual([["videos", 1], ["comments", 1167], ["comments_replies", 934]]);
    expect(before.plan.stages.map((s) => [s.key, s.planned_rows])).toEqual([["videos", 2], ["comments", 2251], ["comments_replies", 1801]]);
    expect(a.result.plan.price.reservePoints).toBeLessThan(before.plan.price.reservePoints);
    expect(a.result.chosen).toEqual(["7663879872137252114"]);
  });
  it("five comments for each video: the comments stage plans 10, and the plan equals compiling that Ask directly", () => {
    const { ask, base } = m12Base();
    const r = recompileWithEdit(base, ask, { field: "commentsPerParent", value: 5 }, { nowMs: AT });
    if (r.kind !== "plan") throw new Error(r.kind);
    expect(r.result.plan.stages.find((s) => s.key === "comments")!.planned_rows).toBe(10);
    const direct = compilePlan({ ...base, ask: r.ask });
    expect(direct.ok && JSON.stringify(direct.plan)).toBe(JSON.stringify(r.result.plan));
  });
  it("THE BUDGET IS A HARD CEILING on the hold: 250 points fits two videos with four comments each; 50 points is refused with a code", () => {
    const { ask, base } = m12Base();
    const r = recompileWithEdit(base, ask, { field: "budget", value: 250 }, { nowMs: AT });
    if (r.kind !== "plan") throw new Error(r.kind);
    expect(r.result.plan.price.reservePoints).toBeLessThanOrEqual(250);
    expect(r.ask.edits.budget).toBe(250);
    const tooSmall = recompileWithEdit(base, ask, { field: "budget", value: 50 }, { nowMs: AT });
    expect(tooSmall).toEqual({ kind: "rejected", reason: "budget_too_small" });
    expect(checkCustomerText(ASK_EDIT_REJECTION_AR.budget_too_small).issues).toEqual([]);
  });
  it("a budget edit can never give a hold above it, for every budget from 200 to 3000 points", () => {
    const { ask, base } = m12Base();
    for (let budget = 200; budget <= 3000; budget += 350) {
      const r = recompileWithEdit(base, ask, { field: "budget", value: budget }, { nowMs: AT });
      if (r.kind === "plan") expect(r.result.plan.price.reservePoints).toBeLessThanOrEqual(budget);
      else expect(r).toEqual({ kind: "rejected", reason: "budget_too_small" });
    }
  });
  it("an edit that needs a new read is NOT compiled from the old pages: it returns the edited Ask for a new planning", () => {
    const { ask, base } = m12Base();
    const r = recompileWithEdit(base, ask, { field: "topic", value: "الروبوتات" }, { nowMs: AT });
    expect(r.kind).toBe("new_read");
    if (r.kind === "new_read") expect(r.ask.topic.text).toBe("الروبوتات");
  });
  it("a refused edit compiles nothing", () => {
    const { ask, base } = m12Base();
    expect(recompileWithEdit(base, ask, { field: "count", value: 0 }, { nowMs: AT })).toEqual({ kind: "rejected", reason: "out_of_range" });
  });
});
