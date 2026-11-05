import { describe, expect, it } from "vitest";
import { buildB2BAsk } from "../src/lib/agentMission/stage3/b2bAsk";
import { B2B_CARDS, b2bCardsFor, type B2BCard } from "../src/lib/agentMission/stage3/b2bCards";
import { compileB2BPlan } from "../src/lib/agentMission/stage3/b2bCompile";

/**
 * STAGE 3, PART A.4 (docs/STAGE-3.md section 10, item 12): A VERIFIED CARD ALWAYS RANKS ABOVE AN UNVERIFIED ONE FOR THE SAME NEED. Before this fix, with the unverified switch on, the compiler ranked by the conditions a card CLAIMS,
 * so an unverified card whose size claim is still a GUESS (`blitzapi.companies.search`) outranked the verified tomba card; and a cheaper unverified lookup came before a verified one in a chain.
 * The switch stays a test-account switch: the customer path passes no switch and gets verified cards only (unchanged).
 */
const card = (over: Partial<B2BCard>): B2BCard => ({ ...B2B_CARDS.find((c) => c.endpointId === "crawl4ai.google.serp.maps")!, ...over });

describe("verified first, whatever an unverified card claims or costs", () => {
  it("the size request: with the switch on, the verified companies card is still chosen (the unverified one only claims a size)", () => {
    const ask = buildB2BAsk("هات ٢٠ شركة برمجيات في الإمارات عدد موظفيها أكثر من ٥٠ وتأسست بعد ٢٠١٥")!;
    const plan = compileB2BPlan(ask, { allowUnverified: true });
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.companiesCard).toBe("tomba.companies.search.reveal");
    // the size is then a mark column (the verified card does not carry it), as on the customer path
    expect(plan.marks.map((m) => m.condition.kind)).toEqual(["size_min", "founded_after"]);
  });

  it("a cheaper unverified lookup comes AFTER a dearer verified one", () => {
    const verified = card({ endpointId: "v.maps", status: "verified", costUsd: 0.01 });
    const unverified = card({ endpointId: "u.maps", status: "unverified", costUsd: 0.0001, verifiedOn: [] });
    expect(b2bCardsFor("company.phone", { allowUnverified: true, cards: [unverified, verified] }).map((c) => c.endpointId)).toEqual(["v.maps", "u.maps"]);
    // inside each group the order is what it was: cheapest first
    const verified2 = card({ endpointId: "v2.maps", status: "verified", costUsd: 0.001 });
    expect(b2bCardsFor("company.phone", { allowUnverified: true, cards: [unverified, verified, verified2] }).map((c) => c.endpointId)).toEqual(["v2.maps", "v.maps", "u.maps"]);
  });

  it("a chain lists every verified tool before any unverified one", () => {
    const plan = compileB2BPlan(buildB2BAsk("عايز ٥ شركات مصرية في قطاع الكهروميكانيكا، ومعاهم صناع القرار")!, { allowUnverified: true });
    if (!plan.ok) throw new Error(plan.reason);
    const status = new Map(B2B_CARDS.map((c) => [c.endpointId, c.status]));
    for (const chain of Object.values(plan.chains)) {
      const firstUnverified = chain.findIndex((id) => status.get(id) !== "verified");
      if (firstUnverified >= 0) expect(chain.slice(firstUnverified).every((id) => status.get(id) !== "verified"), chain.join(",")).toBe(true);
    }
  });

  it("the customer path (no switch) is unchanged: verified cards only", () => {
    expect(b2bCardsFor("person.email").every((c) => c.status === "verified")).toBe(true);
    const plan = compileB2BPlan(buildB2BAsk("عايز ٥ شركات مصرية في قطاع الكهروميكانيكا، ومعاهم صناع القرار")!);
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.chains).toEqual({ general_email: [], hq_phone: ["crawl4ai.google.serp.maps"], email: ["blitzapi.people.email.find"], mobile: ["blitzapi.people.phone.find"] });
  });
});
