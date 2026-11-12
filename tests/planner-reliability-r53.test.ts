import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { buildCapabilityRegistry, discoverCapabilities, researchNeedOf } from "../src/lib/agentMission/capabilities";
import { stagesOfNeed } from "../src/lib/agentMission/capabilities/need";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { blockedEndpointReason } from "../src/lib/treg/blockList";
import { policyVerdict } from "../src/lib/treg/dataPolicy";

/**
 * PLANNER RELIABILITY, ROUND 53 (real-planner run a1 on main 092a010: 28 of R4's 31 missions planned; the two misses traced here).
 *   G2 «عايز أسماء مديري التسويق في شركات الأدوية في مصر»: the chat model wrote ONE first `people.discover`; discovery validated a first-level people stage only, the plan check refuses a first-level people stage on a contact source
 *     (it asks for companies → people), and the companies → people plan was refused by discovery: every plan was refused. Root cause: capability discovery (C). The objective's own words name companies → companies is its parent.
 *   P1 «هات مطاعم المعادي وتقييماتها»: the planner sampled both stages, then asked «كم تقييمًا تريد من كل مطعم؟». Root cause: the prompt (B) allowed a question when «the size» is unclear; the card already shows every count.
 */
const obj = (o: Record<string, unknown>) => ({ platform: null, parent: null, contacts: [], what: null, ...o }) as never;
const chain = (need: ReturnType<typeof researchNeedOf>) => stagesOfNeed(need).map((s) => [s.key, s.operation, s.parentKey]);

describe("G2: people AT companies are read from the companies", () => {
  it("one first people search whose words name companies gets the companies step as its parent", () => {
    const need = researchNeedOf({ request: "عايز أسماء مديري التسويق في شركات الأدوية في مصر", brief: { objectives: [obj({ id: "o1", operation: "people.discover", request: "أسماء مديري التسويق في شركات الأدوية في مصر" })] } as never });
    expect(chain(need)).toEqual([["companies", "companies.discover", null], ["company_people", "people.discover", "companies"]]);
    expect(need.kind).toBe("companies");
    expect(need.people).toBe(true);
  });
  it("an English request too", () => {
    const need = researchNeedOf({ request: "names of marketing managers at pharmaceutical companies in Egypt", brief: { objectives: [obj({ id: "o1", operation: "people.discover" })] } as never });
    expect(chain(need)).toEqual([["companies", "companies.discover", null], ["company_people", "people.discover", "companies"]]);
  });
  it("a companies objective already written is the parent (never a second companies step)", () => {
    const need = researchNeedOf({ request: "شركات الأدوية في مصر ومديري التسويق فيها", brief: { objectives: [obj({ id: "o1", operation: "companies.discover" }), obj({ id: "o2", operation: "people.discover", request: "مديري التسويق في شركات الأدوية" })] } as never });
    expect(chain(need)).toEqual([["companies", "companies.discover", null], ["company_people", "people.discover", "companies"]]);
  });
  it("a people search that names no companies stays a first search", () => {
    const need = researchNeedOf({ request: "هات مديرين تسويق في القاهرة", brief: { objectives: [obj({ id: "o1", operation: "people.discover", request: "مديرين تسويق في القاهرة" })] } as never });
    expect(chain(need)).toEqual([["people", "people.discover", null]]);
  });
  it("the words reader sees «مديري» as people too (fallback without a brief)", () => {
    expect(researchNeedOf({ request: "عايز أسماء مديري التسويق في شركات الأدوية في مصر" }).people).toBe(true);
  });
  it("discovery validates the companies stage and a people source under it", () => {
    const catalog = loadTregCatalog();
    const registry = buildCapabilityRegistry(catalog, { isAllowed: (id) => !blockedEndpointReason(id) && policyVerdict(id, { isAdmin: false, verifiedBusiness: false }).allowed, webKeys: { firecrawl: false, contextdev: false } });
    const need = researchNeedOf({ request: "عايز أسماء مديري التسويق في شركات الأدوية في مصر", brief: { objectives: [obj({ id: "o1", operation: "people.discover", request: "أسماء مديري التسويق في شركات الأدوية في مصر" })] } as never });
    const d = discoverCapabilities(need, registry);
    expect(d.stages.map((s) => [s.stage.key, s.stage.parentKey])).toEqual([["companies", null], ["company_people", "companies"]]);
    expect(d.stages[0].selected).not.toBeNull();
    expect(d.stages[1].selected).not.toBeNull();
  });
});

describe("P1: a count the customer did not give is a stated default, never a question", () => {
  it("the planner's prompt says so, and keeps the question for an unclear SCOPE only", () => {
    const prompt = readFileSync(path.join(__dirname, "..", "agent", "prompts", "system.md"), "utf8");
    expect(prompt).toMatch(/A NUMBER the customer did not give \(how many items, how many reviews or comments per place, post or company\) is never a question/);
    expect(prompt).toMatch(/the SCOPE is unclear/);
    expect(prompt).not.toMatch(/the size or scope is unclear/);
  });
});
