import { describe, expect, it } from "vitest";
import { validateAndPricePlan, type PlanLookup } from "../src/lib/agentMission/plan";
import { knownColumnTitleAr } from "../src/lib/agentMission/taskContracts";

/**
 * AUDIT 2026-11 PR 2, item 3 (G14): THE MODEL WRITES SOURCES, FILTERS AND A SHORT SUMMARY; THE CODE WRITES WHAT IT ALREADY KNOWS. Planning time follows the plan's OUTPUT tokens (54,132 out = 256 s; 17,420 = 98 s; 11,512 = 68 s; G1 live 8,924 out = 52 s, G4 14,933 out = 125 s). The plan
 * the model wrote repeated three things the code holds: the Arabic title of every column whose key the contract or the field classes know («name», «website», «likes», «posted_at»), the sample rows (they are the first matching rows of the output the plan cites as `yield_from`/`measured_by`, which the
 * code reads anyway), and (already, since the engine recipe) the mapping code. A column may now be given by its key alone when the code knows its title; a stage may omit `sample_rows`.
 */
const rows = Array.from({ length: 12 }, (_, i) => ({ id: `v${i}`, text: `فيديو عن منتخب مصر رقم ${i}`, author: `صاحب ${i}`, posted_at: "2026-10-30T10:00:00.000Z", likes: 10 + i, link: `https://example.com/v/${i}` }));
const page = JSON.stringify({ data: rows.map((r) => ({ id: r.id, desc: r.text, author: r.author, create_time: 1788000000, digg_count: r.likes, url: r.link })) });
const calls = new Map([["call_0001", { id: "call_0001", endpointId: "anyapi.tiktok.search.videos", ok: true, costUsd: 0.0006, rows: 12, params: { keyword: "منتخب مصر" } }]]);
const evidence = new Map<string, string>([["call_0001", page], ["out_0002", JSON.stringify(rows)]]);
const lookup: PlanLookup = { call: (id) => calls.get(id) ?? null, evidenceText: (id) => evidence.get(id) ?? null, endpointAllowed: () => true, requestText: "هات ٥ فيديوهات تيك توك عن منتخب مصر" };
const stage = (over: Record<string, unknown> = {}) => ({ key: "videos", title_ar: "فيديوهات تيك توك عن منتخب مصر", endpoint_id: "anyapi.tiktok.search.videos", expected_rows: 5, parent_key: null, deliver: true, measured_by: ["call_0001", "out_0002"], yield_from: "out_0002", relevance: { subject_ar: "فيديوهات عن منتخب مصر", terms: ["منتخب مصر"], text_columns: ["text"], min_own_words: 0 }, ...over });
const FULL_COLUMNS = [{ key: "text", title_ar: "نص الفيديو" }, { key: "author", title_ar: "الكاتب" }, { key: "posted_at", title_ar: "التاريخ والوقت" }, { key: "likes", title_ar: "الإعجابات" }, { key: "link", title_ar: "الرابط" }];

describe("the code knows the title of a common column", () => {
  it("a key the contract or the field classes know has its Arabic title; an unknown key has none (the model must name it)", () => {
    expect(knownColumnTitleAr("likes")).toBe("الإعجابات");
    expect(knownColumnTitleAr("posted_at")).toBe("التاريخ والوقت");
    expect(knownColumnTitleAr("website")).toBe("الموقع الإلكتروني");
    expect(knownColumnTitleAr("quantum_flux")).toBeNull();
  });
});

describe("a plan without the sample rows and with key-only columns is accepted, and the code fills them", () => {
  it("BEFORE: the full plan is accepted; AFTER: the same plan without sample_rows and column titles gives the same columns and the first rows of the cited output", () => {
    const full = validateAndPricePlan({ summary_ar: "٥ فيديوهات عن منتخب مصر.", stages: [stage({ columns: FULL_COLUMNS, sample_rows: rows.slice(0, 2) })] }, lookup);
    expect(full.ok, JSON.stringify(full)).toBe(true);
    const lean = validateAndPricePlan({ summary_ar: "٥ فيديوهات عن منتخب مصر.", stages: [stage({ columns: FULL_COLUMNS.map((c) => ({ key: c.key })) })] }, lookup);
    expect(lean.ok, JSON.stringify(lean)).toBe(true);
    if (!full.ok || !lean.ok) return;
    expect(lean.plan.stages[0].columns.map((c) => c.key)).toEqual(full.plan.stages[0].columns.map((c) => c.key));
    for (const c of lean.plan.stages[0].columns) expect(c.title_ar).toBe(knownColumnTitleAr(c.key));
    expect(lean.plan.stages[0].sample_rows.length).toBeGreaterThanOrEqual(1);
    expect(lean.plan.stages[0].sample_rows.length).toBeLessThanOrEqual(3);
    for (const r of lean.plan.stages[0].sample_rows) expect(rows.some((x) => x.id === r.id)).toBe(true);
    // the price does not depend on who wrote the sample
    expect(lean.plan.price.maxChargePoints).toBe(full.plan.price.maxChargePoints);
  });
  it("what the code does not know is still asked of the model: an unknown key without a title is refused with the key named", () => {
    const r = validateAndPricePlan({ summary_ar: "٥ فيديوهات عن منتخب مصر.", stages: [stage({ columns: [...FULL_COLUMNS.map((c) => ({ key: c.key })), { key: "quantum_flux" }] })] }, lookup);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).toContain("quantum_flux");
  });
  it("the plan's text the model must write shrinks: the lean call is under 60% of the characters of the full one", () => {
    const full = JSON.stringify({ stages: [stage({ columns: FULL_COLUMNS, sample_rows: rows.slice(0, 3) })] });
    const lean = JSON.stringify({ stages: [stage({ columns: FULL_COLUMNS.map((c) => ({ key: c.key })) })] });
    expect(lean.length / full.length).toBeLessThan(0.7);
  });
});
