import { describe, expect, it } from "vitest";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { NEUTRAL_HEADLINE_AR, customerMissionView, guardViewText, type EventForCustomer, type MissionRowForCustomer } from "../src/lib/agentMission/customerView";
import { checkCustomerText } from "../src/lib/agentMission/text";
import { toArabicDigits } from "../src/lib/arabicDigits";
import { customerPlanView } from "../src/lib/agentMission/plan";
import { planWithLlm, type LlmPlannerDeps, type PlannerModel } from "../agent/src/llmPlanner/planner";
import { pricedTwoStagePlan } from "./helpers/agentPlan";

/**
 * DT-20261118-09 FIX1 (QA FAIL on #578 head e66e2987). The customer reads the CARD: these tests drive a stored plan, a stored summary and a stored question through customerMissionView and look at every string of
 * the view. A Latin word the customer did not write (the live «ceo») and a source label of the code's own table the customer did not name («خرائط جوجل») reach NO field of the plan, question or final view.
 */
const REQUEST = "شركات مقاولات";
const POISON_LATIN = "ceo";
const POISON_LABEL = "خرائط جوجل";
const row = (over: Partial<MissionRowForCustomer>): MissionRowForCustomer => ({ id: "msn_x", status: "plan_ready", question_ar: null, plan_public: null, reserved_points: 100, unit_price_points: 1, delivered_units: null, charged_points: null, summary_ar: null, files: null, created_at: "2026-11-19T00:00:00Z", ...over });
const viewOf = (mission: MissionRowForCustomer, events: EventForCustomer[] = [], requestText = REQUEST) => customerMissionView({ mission, events, requestText });
const ev = (id: number, kind: string, message_ar: string): EventForCustomer => ({ id, kind, message_ar, counts: {}, created_at: "2026-11-19T00:00:0" + (id % 10) + "Z" });

/** every string of the view, with its path; the data cells of the samples and the file names are the customer's data, not messages */
function stringsOf(value: unknown, path = "view", out: Array<[string, string]> = []): Array<[string, string]> {
  if (typeof value === "string") out.push([path, value]);
  else if (Array.isArray(value)) value.forEach((v, i) => { if (!(path === "view.samples.rows")) stringsOf(v, `${path}[${i}]`, out); });
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) { if (k === "id" || path.startsWith("view.files") && k === "name") continue; stringsOf(v, `${path}.${k}`, out); }
  return out;
}
const leaks = (view: unknown): string[] => stringsOf(view).filter(([, s]) => new RegExp(`${POISON_LATIN}|${POISON_LABEL}`).test(s)).map(([p, s]) => `${p}: ${s}`);

const poisonedPlan = () => {
  const p: any = JSON.parse(JSON.stringify(customerPlanView(pricedTwoStagePlan())));
  p.summary_ar = `ستحصل على منشورات ${POISON_LATIN} من ${POISON_LABEL}.`;
  p.notes_ar = [...(p.notes_ar ?? []), `ملاحظة عن ${POISON_LATIN}.`, `ملاحظة من ${POISON_LABEL}.`];
  p.assumptions_ar = [...(p.assumptions_ar ?? []), `افترضنا ${POISON_LATIN}.`, `افترضنا ${POISON_LABEL}.`];
  p.request_parts_ar = ["منشورات", POISON_LATIN, POISON_LABEL];
  p.unserved_steps = [{ what_ar: `خطوة ${POISON_LATIN}`, reason_ar: `بسبب ${POISON_LABEL}` }];
  p.stages = p.stages.map((s: any, i: number) => ({ ...s, title_ar: `${s.title_ar} ${i === 0 ? POISON_LATIN : POISON_LABEL}`, ...(s.note_ar ? { note_ar: `${s.note_ar} ${POISON_LATIN}` } : {}), columns: (s.columns ?? []).map((c: any) => ({ ...c, title_ar: `${c.title_ar} ${POISON_LATIN}` })) }));
  // the plan editor of the card carries the same titles
  if (p.edit) p.edit = { ...p.edit, stages: p.edit.stages.map((s: any) => ({ ...s, title_ar: `${s.title_ar} ${POISON_LATIN}`, ...(s.per_parent_label_ar ? { per_parent_label_ar: `${s.per_parent_label_ar} ${POISON_LABEL}` } : {}), columns: s.columns.map((c: any) => ({ ...c, title_ar: `${c.title_ar} ${POISON_LATIN}` })) })) };
  return p;
};

describe("FIX1 item 2: no model-written string of the plan view reaches the customer with a Latin word or a source label they did not write", () => {
  it("the plan card: every string of the view is clean (summary, notes, assumptions, request parts, unserved steps, stage titles and notes, column titles, question options)", () => {
    const view = viewOf(row({ plan_public: poisonedPlan() }));
    expect(leaks(view)).toEqual([]);
    expect(view.requestPartsAr).toEqual(["منشورات", "المصدر"]);
  });
  it("the question: the stored question and its answers carry neither", () => {
    const plan = { ...poisonedPlan(), question_options: [`خيار ${POISON_LATIN}`, "خيار عادي", POISON_LABEL] };
    const view = viewOf(row({ status: "needs_input", question_ar: `هل تقصد ${POISON_LATIN} أم ${POISON_LABEL}؟`, plan_public: plan }));
    expect(view.phase).toBe("question");
    expect(leaks(view)).toEqual([]);
    expect(view.questionAr ?? "").not.toMatch(POISON_LATIN);
    expect(view.questionOptionsAr).toEqual(["خيار عادي"]);
  });
  it("the final view: the stored summary, the progress lines and the result lines carry neither; the summary «اكتمل جمع بيانات ceo» is not shown", () => {
    const events = [ev(1, "progress", `نبحث عن ${POISON_LATIN}`), ev(2, "progress", `نجمع من ${POISON_LABEL}`), ev(3, "result", `اكتمل ${POISON_LATIN}`)];
    const done = viewOf(row({ status: "completed", plan_public: poisonedPlan(), summary_ar: `اكتمل جمع بيانات ${POISON_LATIN}`, delivered_units: 20, charged_points: 80 }), events);
    expect(["done", "partial"]).toContain(done.phase);
    expect(leaks(done)).toEqual([]);
    expect(done.resultSummaryAr ?? "").not.toMatch(POISON_LATIN);
    const unserved = viewOf(row({ status: "unserved", plan_public: poisonedPlan(), summary_ar: `لم نجد ${POISON_LATIN} في ${POISON_LABEL}` }), events);
    expect(leaks(unserved)).toEqual([]);
    const failed = viewOf(row({ status: "failed", plan_public: poisonedPlan(), summary_ar: `تعذّر ${POISON_LATIN}` }), events);
    expect(leaks(failed)).toEqual([]);
  });
  it("what the customer wrote stays: the same final view for a customer who wrote «ceo» and «خرائط جوجل»", () => {
    const view = viewOf(row({ status: "completed", plan_public: poisonedPlan(), summary_ar: `اكتمل جمع بيانات ${POISON_LATIN}`, delivered_units: 20, charged_points: 80 }), [], `عايز شركات مقاولات ${POISON_LATIN} من ${POISON_LABEL}`);
    expect(view.resultSummaryAr).toBe(`اكتمل جمع بيانات ${POISON_LATIN}`);
    expect(view.requestPartsAr).toContain(POISON_LABEL);
  });
  it("a source label inside a stored sentence becomes «المصدر», the rest of the sentence stays", () => {
    const view = viewOf(row({ status: "completed", plan_public: poisonedPlan(), summary_ar: `اكتمل جمع الشركات من ${POISON_LABEL} كما طلبت`, delivered_units: 20, charged_points: 80 }));
    expect(view.resultSummaryAr).toBe("اكتمل جمع الشركات من المصدر كما طلبت");
  });
});

// DT-20261118-09 FIX2 (QA FAIL on #578 head 4c08d6a6): a column title the guard drops fell back to the column's INTERNAL KEY («job_title») and the card drew it as a header
describe("FIX2: a column title that may not be shown is replaced by a neutral Arabic label, never by the column's key", () => {
  const withKeyedColumn = () => {
    const p = poisonedPlan();
    const last = p.stages[p.stages.length - 1];
    last.columns = [...last.columns, { key: "job_title", title_ar: `مسمى ${POISON_LATIN}` }];
    last.sample_rows = last.sample_rows.map((r: any) => ({ ...r, job_title: "مدير" }));
    return p;
  };
  const headers = (v: ReturnType<typeof viewOf>): string[] => [...(v.samples?.columns ?? []).map((c) => c.titleAr), ...(v.edit?.stages ?? []).flatMap((s) => s.columns.map((c) => c.title_ar))];
  it("the samples header and the plan editor's column: Arabic, no key, no «ceo»; the neutral label is numbered by the column's place so two dropped titles differ", () => {
    const v = viewOf(row({ plan_public: withKeyedColumn() }));
    expect(v.samples).not.toBeNull();
    expect(v.edit).not.toBeNull();
    const all = headers(v);
    expect(all.length).toBeGreaterThan(2);
    for (const h of all) { expect(h).toMatch(/[؀-ۿ]/); expect(h).not.toMatch(/[A-Za-z_]/); }
    const jobAt = (v.samples!.columns as Array<{ key: string; titleAr: string }>).findIndex((c) => c.key === "job_title");
    expect(jobAt).toBeGreaterThanOrEqual(0);
    expect(v.samples!.columns[jobAt].titleAr).toBe(`عمود ${toArabicDigits(jobAt + 1)}`);
    expect(new Set(v.samples!.columns.map((c) => c.titleAr)).size).toBe(v.samples!.columns.length);
    expect(v.samples!.rows[0]).toHaveLength(v.samples!.columns.length);
  });
  it("no string of the whole view is snake_case or holds a Latin word (the internal keys are data fields, not messages)", () => {
    for (const status of ["plan_ready", "completed", "needs_input"]) {
      const v = viewOf(row({ status, question_ar: status === "needs_input" ? `هل ${POISON_LATIN}؟` : null, summary_ar: status === "completed" ? `اكتمل ${POISON_LATIN}` : null, delivered_units: status === "completed" ? 20 : null, charged_points: status === "completed" ? 80 : null, plan_public: withKeyedColumn() }));
      const bad = stringsOf(v).filter(([path, text]) => !/(\.key|_key)$/.test(path) && !/\.kind$/.test(path) && !/\.(phase|status|state|lang|noun)$/.test(path) && /[A-Za-z]{2,}|[A-Za-z0-9]+_[A-Za-z0-9_]+/.test(text));
      expect(bad.filter(([path]) => !/^view\.(files|samples\.rows)/.test(path)), status).toEqual([]);
    }
  });
  it("a title the customer may see is kept as written: the same column with the request that wrote «ceo»", () => {
    const v = viewOf(row({ plan_public: withKeyedColumn() }), [], `شركات مقاولات ${POISON_LATIN}`);
    expect(v.samples!.columns.some((c) => c.titleAr === `مسمى ${POISON_LATIN}`)).toBe(true);
  });
});

describe("FIX2 (Gate 2 r2 P2): the price facts and the filter lines of the editor go through the same check", () => {
  it("a price fact and a filter wording that carry «ceo» or a source label the customer did not write are cleaned; the customer's own word stays", () => {
    const base = viewOf(row({ plan_public: poisonedPlan() }));
    const dirty = { ...base, priceFacts: [{ labelAr: `سعر ${POISON_LATIN}`, valueAr: `٣٠٠ نقطة من ${POISON_LABEL}` }, { labelAr: "حجز مؤقت", valueAr: "٣٧٤ نقطة" }], edit: base.edit ? { ...base.edit, stages: base.edit.stages.map((s) => ({ ...s, filters: [{ kind: "period" as const, label_ar: `فترة ${POISON_LATIN}`, enabled: true, line_ar: `من ${POISON_LABEL} فقط` }] })) } : null };
    const g = guardViewText(dirty, REQUEST);
    expect(g.priceFacts).toEqual([{ labelAr: "", valueAr: "٣٠٠ نقطة من المصدر" }, { labelAr: "حجز مؤقت", valueAr: "٣٧٤ نقطة" }]);
    const filters = g.edit!.stages.flatMap((s) => s.filters);
    expect(filters.length).toBeGreaterThan(0);
    for (const f of filters) expect(`${f.label_ar} ${f.line_ar}`).not.toMatch(/ceo|جوجل/);
    expect(filters[0].line_ar).toBe("من المصدر فقط");
    const own = guardViewText(dirty, `${REQUEST} ${POISON_LATIN}`);
    expect(own.priceFacts[0].labelAr).toBe(`سعر ${POISON_LATIN}`);
  });
});

describe("FIX1 (Gate 2 P2): a summary that may not be shown is replaced by a neutral headline, never left empty", () => {
  it("the plan card whose summary holds a foreign Latin word still has a headline; a clean summary is unchanged; no summary stays none", () => {
    const withSummary = (summary_ar: string | undefined) => viewOf(row({ plan_public: { ...poisonedPlan(), summary_ar } })).summaryAr;
    expect(withSummary(`ستحصل على منشورات ${POISON_LATIN}.`)).toBe(NEUTRAL_HEADLINE_AR);
    expect(withSummary("ستحصل على منشورات.")).toBe("ستحصل على منشورات.");
    expect(viewOf(row({ plan_public: null })).summaryAr).toBeNull();
    expect(checkCustomerText(NEUTRAL_HEADLINE_AR, {}).issues).toEqual([]);
  });
});

describe("FIX1 item 1: the request line shows the sanitized topic, never the model's own", () => {
  const UNDERSTOOD = (topic: string) => ({
    decision: "plan", understanding_ar: "منشورات وزارة الصحة عن الشائعات، بعدد ٥٠ منشورًا.", assumptions_ar: [],
    steps: [{ key: "tweets", title_ar: "التغريدات", platform: "x", capability: "x.search.posts", parent: null, deliver: true, count: { total: 50, per_parent: null, all: false }, source: { kind: "account", value: "SaudiMOH" }, topic, search_terms: ["الشائعات", "شائعة"], period: null }],
  });
  const CHOICE = { options: [{ endpoint_id: "anyapi.x.search.posts", params: { query: "(الشائعات OR شائعة) from:SaudiMOH", limit: 50, queryType: "Latest" }, cursor_input: "cursor", parent_input: null, more_params: [] }] };
  const MAP = { fields: { id: ["id"], text: ["text"], author: ["authorName"], username: ["authorUsername"], posted_at: ["createdUtc"], link: ["url"], likes: ["likeCount"] }, link_template: null, extra: [] };
  const tweet = (i: number) => ({ id: `19000000000000${String(i).padStart(4, "0")}`, text: `وزارة الصحة تنفي شائعة رقم ${i}`, authorName: "وزارة الصحة", authorUsername: "SaudiMOH", createdUtc: "2024-03-01T10:00:00Z", url: `https://x.com/SaudiMOH/status/${i}`, likeCount: i });
  const page = { output: { data: { items: Array.from({ length: 20 }, (_, k) => tweet(k)), nextCursor: "c2" } } };
  const planFor = async (topic: string, words: string[]) => {
    const queues: Record<string, unknown[]> = { request_plan: [UNDERSTOOD(topic)], tool_choice: [CHOICE], field_map: [MAP] };
    const model: PlannerModel = async ({ tool }) => { const next = (queues[tool.name] ?? []).shift(); return next === undefined ? null : { input: JSON.parse(JSON.stringify(next)), costUsd: 0.001 }; };
    const deps: LlmPlannerDeps = { model, catalog: loadTregCatalog(), access: null, today: "2026-11-19", probe: async () => ({ ok: true, call_id: "call_0001", http_status: 200, rows_in_page: 20, has_more: true, next_cursor: "c2", shape: null, first_rows: [], warnings: [], saved: "call_0001" }), readPage: async () => page };
    const r = await planWithLlm({ words, request: "" }, deps);
    expect(r.kind).toBe("plan");
    if (r.kind !== "plan") throw new Error("no plan");
    return r.plan;
  };
  const partsOf = (plan: Awaited<ReturnType<typeof planFor>>) => (plan.compiled as unknown as { llm: { request_parts_ar: string[] } }).llm.request_parts_ar;
  it("the customer named no source and the model's topic is a source label: the label is not in the stored parts nor on the card", async () => {
    const plan = await planFor(POISON_LABEL, ["عايز ٥٠ منشور عن الشائعات من حساب وزارة الصحة"]);
    expect(partsOf(plan).join(" ")).not.toContain("جوجل");
    const view = viewOf(row({ plan_public: customerPlanView(plan) }), [], "عايز ٥٠ منشور عن الشائعات من حساب وزارة الصحة");
    expect(JSON.stringify(view.requestPartsAr)).not.toContain("جوجل");
    expect(JSON.stringify(view.summaryAr)).not.toContain("جوجل");
  });
  it("a topic that holds a source label among other words keeps the other words and says «المصدر»; the customer's own label stays", async () => {
    const mixed = await planFor(`شركات من ${POISON_LABEL}`, ["عايز ٥٠ منشور عن الشائعات من حساب وزارة الصحة"]);
    expect(partsOf(mixed)).toContain("شركات من المصدر");
    const written = await planFor(`شركات من ${POISON_LABEL}`, [`عايز ٥٠ منشور من ${POISON_LABEL}`]);
    expect(partsOf(written)).toContain(`شركات من ${POISON_LABEL}`);
  });
});
