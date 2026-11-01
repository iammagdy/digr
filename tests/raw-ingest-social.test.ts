import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryStore } from "../agent/src/memoryStore";
import { ItemStore, readSnapshot } from "../agent/src/items/itemStore";
import { ingestRows } from "../agent/src/items/ingest";
import type { PricedPlan, PricedStage } from "../src/lib/agentMission/plan";
import { MARKS_KEY } from "../src/lib/agentMission/rawMarks";
import { isAllowedRemovalRaw } from "../src/lib/agentMission/rawDelivery";
import { replay } from "./helpers/agentReplay";
import { pages, planning } from "./helpers/engineXScenario";
import { aboutWords } from "./helpers/agentRelevance";
import { tregResult } from "./helpers/agentFakeWorld";
import type { FakeStep } from "../agent/src/fakeDriver";

/**
 * S1 item 1.1: RAW INGEST (owner decisions D5, D6). With the flag active and a request built by code, an item is kept as the source gave it: the only removals are the same record id twice, an item of an unknown parent, an item beyond the volume bought
 * and the share of a named source. Every content rule (language, period, reply, repost, topic, same text from different people) becomes a MARK on the row, never a removal.
 */
afterEach(() => { vi.unstubAllGlobals(); });
const NOW = Date.parse("2026-11-01T12:00:00Z");
const stage = (extra: Record<string, unknown> = {}): PricedStage => ({
  key: "posts", title_ar: "المنشورات", endpoint_id: "e", expected_rows: 20, planned_rows: 20, parent_key: null, deliver: true,
  columns: [{ key: "text", title_ar: "النص" }, { key: "author", title_ar: "الحساب" }, { key: "date", title_ar: "التاريخ" }], sample_rows: [], measured_by: [],
  relevance: aboutWords(["الذكاء الاصطناعي"]),
  filters: [{ kind: "exclude_replies", field: "is_reply" }, { kind: "exclude_reposts", field: "is_repost" }, { kind: "language", field: "lang", lang: "ar" }, { kind: "period", field: "date", days: 7 }],
  ...extra,
} as unknown as PricedStage);
const planOf = (s: PricedStage): PricedPlan => ({ summary_ar: "x", stages: [s], price: { deliveredRows: s.planned_rows } } as unknown as PricedPlan);
async function ingest(rows: Array<Record<string, unknown>>, raw: boolean, s: PricedStage = stage()) {
  const store = createMemoryStore();
  const items = await ItemStore.open(store, "msn_raw01");
  await ingestRows({ items, plan: planOf(s), addEvent: async () => undefined }, s, rows, { silent: true, idField: null, now: NOW, ...(raw ? { raw: true } : {}) });
  return items;
}
const row = (id: string, text: string, extra: Record<string, unknown> = {}) => ({ id, text, author: `@u${id}`, date: "2026-10-30T10:00:00Z", is_reply: false, is_repost: false, lang: "ar", ...extra });

describe("raw mode keeps what the source gave", () => {
  it("(1) the same text from two authors is two rows", async () => {
    const items = await ingest([row("1", "الذكاء الاصطناعي يغير العالم"), row("2", "الذكاء الاصطناعي يغير العالم")], true);
    expect(items.acceptedRows("posts")).toHaveLength(2);
    expect((await ingest([row("1", "الذكاء الاصطناعي يغير العالم"), row("2", "الذكاء الاصطناعي يغير العالم")], false)).acceptedRows("posts")).toHaveLength(1);
  });
  it("(2) the same record id twice is one row", async () => {
    const items = await ingest([row("1", "الذكاء الاصطناعي أ"), row("1", "الذكاء الاصطناعي ب")], true);
    expect(items.acceptedRows("posts")).toHaveLength(1);
    expect(items.counts("posts").duplicates).toBe(1);
  });
  it("(3) an English post, a reply, a repost and an out-of-period post are delivered, each with its marks", async () => {
    const items = await ingest([
      row("1", "AI is changing everything today", { lang: "en" }),
      row("2", "@someone الذكاء الاصطناعي رائع", { is_reply: true }),
      row("3", "RT @a الذكاء الاصطناعي", { is_repost: true }),
      row("4", "الذكاء الاصطناعي قديم", { date: "2026-09-01T10:00:00Z" }),
      row("5", "الذكاء الاصطناعي عادي"),
    ], true);
    const byId = new Map(items.acceptedRows("posts").map((r) => [String(r.id), r]));
    expect(byId.size).toBe(5);
    expect(byId.get("1")![MARKS_KEY]).toMatchObject({ lang: "other" });
    expect(byId.get("2")![MARKS_KEY]).toMatchObject({ reply: true });
    expect(byId.get("3")![MARKS_KEY]).toMatchObject({ repost: true });
    expect(byId.get("4")![MARKS_KEY]).toMatchObject({ inPeriod: false });
    expect(byId.get("5")![MARKS_KEY]).toEqual({ reply: false, repost: false, lang: "ar", inPeriod: true, named: null });
  });
  it("(4) a text that has nothing to do with the topic is delivered", async () => {
    const items = await ingest([row("1", "أخبار الطقس اليوم مشمسة")], true);
    expect(items.acceptedRows("posts")).toHaveLength(1);
    expect((await ingest([row("1", "أخبار الطقس اليوم مشمسة")], false)).acceptedRows("posts")).toHaveLength(0);
  });
  it("the volume bought is still the cap: rows beyond it are kept out with the reason target_reached", async () => {
    const s = stage({ planned_rows: 3, expected_rows: 3 });
    const items = await ingest(Array.from({ length: 6 }, (_, i) => row(String(i + 1), `الذكاء الاصطناعي ${i}`)), true, s);
    expect(items.acceptedRows("posts")).toHaveLength(3);
    expect(items.excludedItems("posts").map((i) => i.reason)).toEqual(["target_reached", "target_reached", "target_reached"]);
  });
  it("with no raw option (every flag off) the old rules apply unchanged: replies, reposts, other languages and old posts are left out", async () => {
    const items = await ingest([row("1", "AI is changing everything today", { lang: "en" }), row("2", "@someone الذكاء الاصطناعي رائع", { is_reply: true }), row("4", "الذكاء الاصطناعي قديم", { date: "2026-09-01T10:00:00Z" }), row("5", "الذكاء الاصطناعي عادي")], false);
    expect(items.acceptedRows("posts")).toHaveLength(1);
    expect(items.acceptedRows("posts")[0]![MARKS_KEY]).toBeUndefined();
  });
});

describe("the contract: in raw mode no item is stored under a removal reason outside the allowed four", () => {
  it("every content rule at once, then every stored reason is allowed", async () => {
    const s = stage({ planned_rows: 4, expected_rows: 4 });
    const items = await ingest([
      row("1", "AI is changing everything today", { lang: "en" }), row("2", "@x الذكاء الاصطناعي", { is_reply: true }), row("3", "RT @a الذكاء الاصطناعي", { is_repost: true }),
      row("4", "قديم الذكاء الاصطناعي", { date: "2026-01-01T00:00:00Z" }), row("5", "أخبار الطقس"), row("6", "أخبار الطقس"), row("7", ""), row("8", "الذكاء الاصطناعي ٨"),
    ], true, s);
    const reasons = items.excludedItems("posts").map((i) => String(i.reason));
    for (const r of reasons) expect(isAllowedRemovalRaw(r)).toBe(true);
    expect(items.acceptedRows("posts")).toHaveLength(4);
  });
});

/** The standard X scenario asking for 40 tweets (two pages of twenty; four of every five are about the topic). */
const forty = (extraParams: Record<string, unknown> = {}): FakeStep[] => planning().map((st) => {
  if (st.tool === "treg_call") return { tool: "treg_call", args: (r: unknown) => ({ ...(typeof st.args === "function" ? (st.args as (r: unknown) => Record<string, unknown>)(r) : st.args), params: { query: "محمد صلاح", limit: 20, ...extraParams } }) } as FakeStep;
  if (st.tool !== "propose_plan") return st;
  return { tool: "propose_plan", args: (r: unknown) => { const plan = (st.args as (r: unknown) => Record<string, any>)(r); plan.summary_ar = "ستحصل على ٤٠ تغريدة عن محمد صلاح مع نص كل تغريدة ورابطها."; plan.stages[0].expected_rows = 40; return plan; } } as FakeStep;
});
const answers = () => [0, 1, 2, 3].map((p) => tregResult({ output: { data: { items: Array.from({ length: 20 }, (_, i) => { const n = p * 20 + i; return { id: `18${String(n).padStart(6, "0")}`, text: n % 5 === 4 ? `أخبار عامة عن الطقس رقم ${n} اليوم` : `محمد صلاح يسجل هدفًا رقم ${n} في المباراة`, url: `https://x.example/u/status/18${String(n).padStart(6, "0")}`, author: `user${n % 40}`, createdAt: "2026-10-20T10:00:00Z" }; }), nextCursor: p < 3 ? `cur_${(p + 1) * 20}` : null } } }, 0.00075));
const run = (flags: unknown, extraParams: Record<string, unknown> = {}) => replay({ request: "هات ٤٠ تغريدة عن محمد صلاح", planning: forty(extraParams), execution: () => [], answers: [answers()[0], ...answers()], deps: (d) => { d.store.settings.redesign_flags = flags; return d; } });

describe("THE STAGE 1 ORDERING GATE end to end", () => {
  it("flag on and the request built by code: raw delivery (the 40 first rows, the unrelated ones included, each marked)", async () => {
    const r = await run({ social_posts: "on" });
    expect(r.plannedPlan.stages[0].engine!.built_by).toBe("code");
    const rows = (await readSnapshot(r.store, r.missionId)).acceptedRows("tweets");
    expect(rows).toHaveLength(40);
    expect(rows.some((x) => String(x.text).includes("الطقس"))).toBe(true);
    expect(rows.every((x) => x[MARKS_KEY] !== undefined)).toBe(true);
  });
  it("flag on but the model's request was not buildable (an input the endpoint does not have): built_by is not code and the OLD rules run, the unrelated rows are left out", async () => {
    const r = await run({ social_posts: "on" }, { not_a_real_input: 1 });
    expect(r.plannedPlan.stages[0].engine!.built_by).not.toBe("code");
    const rows = (await readSnapshot(r.store, r.missionId)).acceptedRows("tweets");
    expect(rows.some((x) => String(x.text).includes("الطقس"))).toBe(false);
    expect(rows.every((x) => x[MARKS_KEY] === undefined)).toBe(true);
  });
  it("flags off: the old rules, no marks", async () => {
    const r = await run({});
    const rows = (await readSnapshot(r.store, r.missionId)).acceptedRows("tweets");
    expect(rows.some((x) => String(x.text).includes("الطقس"))).toBe(false);
    expect(rows.every((x) => x[MARKS_KEY] === undefined)).toBe(true);
  });
});
void pages;
