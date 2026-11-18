import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { loadTregCatalog, isSellable } from "../src/lib/treg/catalog";
import { blockedEndpointReason } from "../src/lib/treg/blockList";
import { policyVerdict } from "../src/lib/treg/dataPolicy";
import { asksPeopleOfCompanies, personIdentifiersOf, rankedPeopleSources } from "../src/lib/agentMission/childSources";
import { buildTools } from "../agent/src/tools";
import { makeHarness, NOT_ADMIN } from "./helpers/agentHarness";

/**
 * DT-20261118-03 PR-7 (BUG HUNTER BH-2; Megz D-0086: no word decides). Companies and their people go to the older agent, whose catalog_search found the people of a company only when the model typed the right English word: «managers» gave
 * 0 hits, «employees company» only a source about 1,200 times dearer. Now the request's STRUCTURE (the planner's understanding: a people step under a companies step), or a search on the people platform, adds the people sources of a company,
 * ranked by what their rows give the e-mail and phone finders (a professional page, then a name), then by price and rate.
 */
const catalog = loadTregCatalog();
const allowed = (id: string) => isSellable(id, catalog) && !blockedEndpointReason(id) && policyVerdict(id, NOT_ADMIN).allowed;
const OWNER = "عايز ٥ شركات في مجال الكهروميكانيكا في مصر، ومن جوّه كل شركة المديرين، ولكل مدير الإيميل بتاعه ورقم تليفونه.";
const search = async (words: string[], opts: { structure?: boolean; platform?: string } = {}) => {
  const h = makeHarness({ mission: { request_text: OWNER } });
  if (opts.structure) h.ctx.peopleOfCompanies = true;
  const r = (await buildTools(h.ctx).find((t) => t.name === "catalog_search")!.handler({ words, ...(opts.platform ? { platform: opts.platform } : {}), limit: 8 })) as { hits: Array<Record<string, unknown>> };
  return r.hits;
};
const CHEAP_PEOPLE = () => rankedPeopleSources(catalog, allowed)[0]!.id;

describe("the request's structure, never its words", () => {
  it("a people step under a companies step is the structure; anything else is not", () => {
    expect(asksPeopleOfCompanies([{ key: "c", parent: null, platform: "companies" }, { key: "p", parent: "c", platform: "people" }])).toBe(true);
    expect(asksPeopleOfCompanies([{ key: "p", parent: null, platform: "people" }])).toBe(false);
    expect(asksPeopleOfCompanies([{ key: "c", parent: null, platform: "companies" }])).toBe(false);
    expect(asksPeopleOfCompanies([{ key: "v", parent: null, platform: "youtube" }, { key: "k", parent: "v", platform: "youtube" }])).toBe(false);
  });
  it.each([[["managers"]], [["مديرين"]], [["employees", "company"]], [["decision", "makers"]]])("words %j: the people sources of a company are offered, the cheapest that gives a profile among the first", async (words) => {
    const hits = await search(words, { structure: true });
    expect(hits.map((h) => h.id)).toContain(CHEAP_PEOPLE());
  });
  it("the same search on the people platform offers them without the structure (the model chose the platform)", async () => {
    expect((await search(["managers"], { platform: "people" })).map((h) => h.id)).toContain(CHEAP_PEOPLE());
  });
  it("a search for the companies themselves is left as it was: the companies come first", async () => {
    const hits = await search(["companies", "search"], { structure: true });
    expect(catalog.byId.get(String(hits[0]!.id))?.capability).toBe("companies.search");
  });
});

describe("what each people source gives the finders", () => {
  it("a hit says which person identifiers its rows give; a source that gives a profile ranks above one that gives none", async () => {
    const hits = await search(["employees", "company"], { structure: true });
    const first = hits.find((h) => h.id === CHEAP_PEOPLE())!;
    expect(first.person_gives).toEqual(expect.arrayContaining(["linkedin"]));
    const ranked = rankedPeopleSources(catalog, allowed);
    const tierOf = (gives: string[]) => (gives.includes("linkedin") ? 0 : gives.length > 0 ? 1 : 2);
    const tiers = ranked.map((p) => tierOf(p.gives));
    expect([...tiers].sort((a, b) => a - b)).toEqual(tiers);
    expect(personIdentifiersOf(catalog.byId.get(CHEAP_PEOPLE())!)).toContain("linkedin");
  });
});

describe("the planner is told what the finders need", () => {
  it("system.md says the company's own e-mail is added by code and the people source must give a profile or a name", () => {
    const prompt = readFileSync(new URL("../agent/prompts/system.md", import.meta.url), "utf8");
    expect(prompt).toContain("the people source you choose must give each person's professional page (LinkedIn) or full name");
    expect(prompt).toContain("code also adds the company's own e-mail step");
  });
});
