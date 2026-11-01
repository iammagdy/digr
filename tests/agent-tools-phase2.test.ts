import { describe, expect, it, vi } from "vitest";
import { buildTools, cheapestFirstMessage, newRunState, TOOL_NAMES, type ToolContext } from "../agent/src/tools";
import { createWebGateway } from "../agent/src/webGateway";
import { buildQueryOptions } from "../agent/src/sdkOptions";
import { makeHarness, tregResult, USER_ID } from "./helpers/agentHarness";
import { fakeContextDev, igFeed } from "./helpers/fakeContextDev";
import { xPage } from "./helpers/agentFakeWorld";
import { validateAndPricePlan, type PlanLookup } from "../src/lib/agentMission/plan";
import { isContactSource } from "../src/lib/agentMission/contacts";

vi.stubGlobal("fetch", () => { throw new Error("a real network call was attempted"); });

function withWeb(h: ReturnType<typeof makeHarness>, fake: Parameters<typeof fakeContextDev>[0] = {}) {
  const world = fakeContextDev(fake);
  const web = createWebGateway({ store: h.store, missionId: h.mission.id, jobId: h.mission.job_id, phase: h.ctx.phase, budget: h.budget, recorder: { reserve: async () => ({ allowed: true, costId: 1 }), commit: async () => undefined }, providerKey: async () => "k", fetchFn: world.fetchFn as any, counter: { seq: 0 } });
  h.ctx.web = web;
  return { world, tools: () => Object.fromEntries(buildTools(h.ctx).map((t) => [t.name, t])) as ReturnType<typeof toolMap> };
}
const toolMap = (ctx: ToolContext) => Object.fromEntries(buildTools(ctx).map((t) => [t.name, t]));

describe("which tools the agent has", () => {
  it("the web tools exist only when the provider key store is wired; collect_pages is an execution tool; the SDK allows exactly the offered tools", () => {
    const h = makeHarness({ phase: "planning" });
    expect(buildTools(h.ctx).map((t) => t.name)).not.toContain("parse_page");
    expect(buildTools(h.ctx).map((t) => t.name)).not.toContain("collect_pages");
    withWeb(h);
    expect(buildTools(h.ctx).map((t) => t.name)).toEqual(expect.arrayContaining(["parse_page", "web_search", "web_scrape", "people_search", "treg_call"]));
    const exec = makeHarness({ phase: "execution" });
    withWeb(exec);
    const names = buildTools(exec.ctx).map((t) => t.name);
    expect(names).toContain("collect_pages");
    for (const n of names) expect((TOOL_NAMES as readonly string[]).includes(n)).toBe(true);
    const o = buildQueryOptions({ model: "m", systemPrompt: "s", maxTurns: 1, maxBudgetUsd: 1, cwd: "/tmp", tools: buildTools(exec.ctx) }, {});
    expect(o.allowedTools).toContain("mcp__diger__parse_page");
    expect(o.tools).toEqual([]);
    expect(o.canUseToolDecision("mcp__diger__parse_page")).toBe(true);
    expect(o.canUseToolDecision("Bash")).toBe(false);
  });
});

describe("cheapest suitable source first, across all providers", () => {
  it("catalog_search ranks the catalog and the parsers in ONE list by cost per row; the ranking is kept for the check", async () => {
    const h = makeHarness();
    const w = withWeb(h);
    const r: any = await w.tools().catalog_search.handler({ words: ["hashtag", "posts"], platform: "instagram", limit: 10 });
    const ids: string[] = r.hits.map((x: any) => x.id);
    expect(ids).toContain("contextdev.parse.instagram-feed");
    expect(ids.some((i) => !i.startsWith("contextdev."))).toBe(true);
    const costs: number[] = r.hits.map((x: any) => x.costPerRecordUsd ?? Infinity);
    expect([...costs].sort((a, b) => a - b)).toEqual(costs);
    expect(r.hits.map((x: any) => x.rank)).toEqual(r.hits.map((_: unknown, i: number) => i + 1));
    expect(h.ctx.state.ranking).toEqual(ids);
  });

  it("a source ranked below an untried cheaper one needs `why` (kept in the admin trace); once the cheaper one was tried it does not", async () => {
    const h = makeHarness({ responses: [tregResult(xPage("موضوع", 0, 5, null), 0.00075), tregResult(xPage("موضوع", 0, 5, null), 0.00075)] });
    h.ctx.state.ranking = ["crawl4ai.x.search.posts", "anyapi.x.search.posts"];
    const tools = toolMap(h.ctx);
    const refused: any = await tools.treg_call.handler({ endpoint_id: "anyapi.x.search.posts", params: { query: "موضوع" } });
    expect(refused).toMatchObject({ ok: false, refused: "choose_cheapest" });
    expect(h.call).not.toHaveBeenCalled();
    const allowed: any = await tools.treg_call.handler({ endpoint_id: "anyapi.x.search.posts", params: { query: "موضوع" }, why: "the cheaper source has no author or link fields" });
    expect(allowed.ok).toBe(true);
    expect(h.store.calls[0].params_digest).toMatchObject({ _why: "the cheaper source has no author or link fields" });
    // the cheaper one tried (even if it failed): the dearer one is allowed without a reason
    h.ctx.state.tried.add("crawl4ai.x.search.posts");
    expect(cheapestFirstMessage(h.ctx.state, "anyapi.x.search.posts", "")).toBeNull();
    expect(cheapestFirstMessage(h.ctx.state, "crawl4ai.x.search.posts", "")).toBeNull();
    expect(cheapestFirstMessage(newRunState(), "anyapi.x.search.posts", "")).toBeNull();
  });

  it("describe_endpoint describes a parser (inputs, limits, cost per row)", async () => {
    const h = makeHarness();
    const w = withWeb(h);
    const d: any = await w.tools().describe_endpoint.handler({ id: "contextdev.parse.google-maps-reviews" });
    expect(d.ok).toBe(true);
    expect(d.endpoint.rows_per_call).toBe(1000);
    expect(d.endpoint.how).toContain("parse_page");
    expect((await w.tools().describe_endpoint.handler({ id: "contextdev.parse.nope" })).ok).toBe(false);
  });

  it("parse_page is also under the cheapest-first rule", async () => {
    const h = makeHarness();
    const w = withWeb(h, { parse: () => ({ data: igFeed("x", 2), credits: 1 }) });
    h.ctx.state.ranking = ["firecrawl.search", "contextdev.parse.instagram-feed"];
    const t = w.tools();
    expect(await t.parse_page.handler({ parser: "instagram-feed", url: "https://www.instagram.com/explore/tags/x/" })).toMatchObject({ refused: "choose_cheapest" });
    expect(w.world.fetchFn).not.toHaveBeenCalled();
    expect((await t.parse_page.handler({ parser: "instagram-feed", url: "https://www.instagram.com/explore/tags/x/", why: "web search results carry no post fields" })).ok).toBe(true);
  });
});

describe("collect_pages: hundreds of rows paged in code, inside the budget", () => {
  const ENDPOINT = "anyapi.x.search.posts";
  const pages = (n: number, per = 20) => Array.from({ length: n }, (_, i) => tregResult(xPage("موضوع", i * per, per, i + 1 < n ? `cur_${(i + 1) * per}` : null), 0.00075));

  it("pages until the target, joins and de-duplicates, saves ONE output, ticks the panel, and stops at the target", async () => {
    const h = makeHarness({ phase: "execution", budgetUsd: 0.05, responses: pages(15) });
    const r: any = await toolMap(h.ctx).collect_pages.handler({ endpoint_id: ENDPOINT, params: { query: "موضوع", limit: 20 }, target_rows: 300 });
    expect(r).toMatchObject({ ok: true, pages: 15, unique_rows: 300, stopped_because: "target_reached" });
    const out = JSON.parse((await h.store.getFile(h.mission.id, `out/${r.output_id}.json`))!);
    expect(out).toHaveLength(300);
    expect(new Set(out.map((x: any) => x.id)).size).toBe(300);
    expect(h.call).toHaveBeenCalledTimes(15);
    const counts = h.store.events.filter((e) => e.counts?.pages).map((e) => e.counts);
    expect(counts[0]).toEqual({ pages: 1, rows: 20, planned: 300 });
    expect(counts[counts.length - 1]).toEqual({ pages: 15, rows: 300, planned: 300 });
    // the second call carried the cursor of the first answer
    expect(h.call.mock.calls[1][0].params.cursor).toBe("cur_20");
  });

  it("stops where the source ends, de-duplicating repeated rows", async () => {
    const dup = [tregResult(xPage("موضوع", 0, 20, "c1"), 0.00075), tregResult(xPage("موضوع", 10, 20, null), 0.00075)];
    const h = makeHarness({ phase: "execution", budgetUsd: 0.05, responses: dup });
    const r: any = await toolMap(h.ctx).collect_pages.handler({ endpoint_id: ENDPOINT, params: { query: "موضوع" }, target_rows: 500 });
    expect(r).toMatchObject({ ok: true, pages: 2, unique_rows: 30, stopped_because: "source_ended" });
  });

  it("stops at the mission budget (a refused call is the end of that road) and keeps what it collected", async () => {
    const h = makeHarness({ phase: "execution", budgetUsd: 0.0025, responses: pages(15) });
    const r: any = await toolMap(h.ctx).collect_pages.handler({ endpoint_id: ENDPOINT, params: { query: "موضوع" }, target_rows: 300 });
    expect(r.ok).toBe(true);
    expect(r.stopped_because).toBe("refused:over_budget");
    expect(r.pages).toBe(3);
    expect(r.unique_rows).toBe(60);
    expect(h.call).toHaveBeenCalledTimes(3);
  });

  it("needs a cursor input and a target; refuses an endpoint that is not in the catalog", async () => {
    const h = makeHarness({ phase: "execution" });
    const tool = toolMap(h.ctx).collect_pages;
    expect((await tool.handler({ endpoint_id: "x.made.up", params: {}, target_rows: 10 })).ok).toBe(false);
    expect((await tool.handler({ endpoint_id: ENDPOINT, params: { query: "q" } })).ok).toBe(false);
    expect((await tool.handler({ endpoint_id: "x.x.search-posts-all", params: { query: "q" }, target_rows: 10 })).error).toContain("cursor");
  });
});

describe("contacts: asked for, verified by code, never charged when unverified", () => {
  const calls = new Map([
    ["call_0001", { id: "call_0001", endpointId: "anyapi.x.search.posts", ok: true, costUsd: 0.00075, rows: 20 }],
    ["call_0002", { id: "call_0002", endpointId: "contextdev.parse.emails", ok: true, costUsd: 0.00254, rows: 2 }],
  ]);
  const lookup = (requestText: string): PlanLookup => ({ call: (id) => calls.get(id) ?? null, evidenceText: () => "https://x.example/1 a@acme.example 18000001", endpointAllowed: () => true, requestText, isContactSource });
  const base = { summary_ar: "ستحصل على شركات وبريدها المهني.", stages: [
    { key: "companies", title_ar: "الشركات", endpoint_id: "anyapi.x.search.posts", expected_rows: 10, parent_key: null, deliver: true, columns: [{ key: "text", title_ar: "الاسم" }], sample_rows: [{ id: "18000001", text: "x" }], measured_by: ["call_0001"] },
  ] };
  const withContacts = { ...base, stages: [...base.stages, { key: "emails", title_ar: "البريد المهني", endpoint_id: "contextdev.parse.emails", expected_rows: 10, parent_key: "companies", per_parent_rows: 1, deliver: true, columns: [{ key: "text", title_ar: "البريد", kind: "work_email" }], sample_rows: [{ id: "a@acme.example", text: "a@acme.example" }], measured_by: ["call_0002"] }] };

  it("a request for e-mails or phones needs a contact stage, or one honest sentence", () => {
    const asked = "عايز شركات وإيميلاتهم";
    const missing = validateAndPricePlan(base, lookup(asked));
    expect(missing.ok).toBe(false);
    expect(JSON.stringify(!missing.ok && missing.issues)).toContain("CONTACT STAGE");
    expect(validateAndPricePlan(withContacts, lookup(asked)).ok).toBe(true);
    const noted = validateAndPricePlan({ ...base, contacts_note_ar: "لم نجد مصدرًا موثوقًا للبريد المهني لهذه الشركات." }, lookup(asked));
    expect(noted.ok).toBe(true);
    expect(noted.ok && noted.plan.notes_ar).toEqual(["لم نجد مصدرًا موثوقًا للبريد المهني لهذه الشركات."]);
    expect(validateAndPricePlan({ ...base, contacts_note_ar: "No source" }, lookup(asked)).ok).toBe(false);
    // a request with no contacts in it is not held to the rule
    expect(validateAndPricePlan(base, lookup("هات تغريدات عن القهوة")).ok).toBe(true);
  });

  it("a contact stage must mark its contact columns with a kind", () => {
    const unmarked = { ...withContacts, stages: [withContacts.stages[0], { ...withContacts.stages[1], columns: [{ key: "text", title_ar: "البريد" }] }] };
    const r = validateAndPricePlan(unmarked, lookup("عايز إيميلات"));
    expect(r.ok).toBe(false);
    expect((!r.ok && r.issues.join(" ")) || "").toContain('kind "work_email"');
  });

  // CHANGED (owner direction 2026-11-01): a value that looks like an address is kept with «غير موثّق» beside it instead of being emptied; a text that is no address is still left empty
  it("save_rows keeps an unverified address as written, leaves a non-address empty, and does NOT save a contact row with no verified value (so it is neither delivered nor charged)", async () => {
    const checked = validateAndPricePlan(withContacts, lookup("عايز إيميلات"));
    if (!checked.ok) throw new Error(checked.issues.join("; "));
    const h = makeHarness({ phase: "execution", mission: { plan: checked.plan, job_id: "job_c" } });
    h.ctx.plan = checked.plan;
    await h.store.putFile(h.mission.id, "rows/companies.json", JSON.stringify([{ id: "co1", text: "الشركة" }, { id: "co2", text: "الشركة الثانية" }, { id: "co3", text: "الثالثة" }, { id: "co4", text: "الرابعة" }]), "application/json");
    const save = toolMap(h.ctx).save_rows;
    const r: any = await save.handler({ stage_key: "emails", rows: [
      { id: "e1", parent_id: "co1", text: "Info@Acme.example" },
      { id: "e2", parent_id: "co2", text: "someone@gmail.com" },
      { id: "e3", parent_id: "co3", text: "not an email" },
      { id: "e4", parent_id: "co4", text: "sales@acme2.example" },
    ] });
    expect(r).toMatchObject({ ok: true, saved_now: 2, rejected_no_verified_contact: 2, contact_values_left_empty: 1 });
    const rows = JSON.parse((await h.store.getFile(h.mission.id, "rows/emails.json"))!);
    expect(rows.map((x: any) => x.text)).toEqual(["info@acme.example", "sales@acme2.example"]);
  });

  it("a non-contact stage with a contact column keeps its rows and keeps the unverified value, marked «غير موثّق» (CHANGED 2026-11-01: it used to be blanked)", async () => {
    const planWith = { summary_ar: "ستحصل على موظفين.", stages: [{ key: "people", title_ar: "الموظفون", endpoint_id: "anyapi.x.search.posts", expected_rows: 10, parent_key: null, deliver: true, columns: [{ key: "text", title_ar: "الاسم" }, { key: "mail", title_ar: "البريد", kind: "work_email" }], sample_rows: [{ id: "18000001", text: "x" }], measured_by: ["call_0001"] }] };
    const checked = validateAndPricePlan(planWith, lookup("عايز موظفين"));
    if (!checked.ok) throw new Error(checked.issues.join("; "));
    const h = makeHarness({ phase: "execution", mission: { plan: checked.plan, job_id: "job_c" } });
    h.ctx.plan = checked.plan;
    const r: any = await toolMap(h.ctx).save_rows.handler({ stage_key: "people", rows: [{ id: "p1", text: "منى", mail: "mona@gmail.com" }, { id: "p2", text: "خالد", mail: "k@acme.example" }] });
    expect(r).toMatchObject({ saved_now: 2, contact_values_left_empty: 0 });
    expect(JSON.parse((await h.store.getFile(h.mission.id, "rows/people.json"))!).map((x: any) => x.mail)).toEqual(["mona@gmail.com", "k@acme.example"]);
  });
});
void USER_ID;
