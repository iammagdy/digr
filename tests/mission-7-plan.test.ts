import { describe, expect, it } from "vitest";
import { loadTregCatalog, isSellable } from "../src/lib/treg/catalog";
import { blockedEndpointReason } from "../src/lib/treg/blockList";
import { bindQuantityDetailed, perParentQuantities, countedQuantities } from "../src/lib/agentMission/quantity";
import { childStepSourcesFor, isPeopleNoun, linkBetween, linkableCompanySources, peopleSourcesForCompanies } from "../src/lib/agentMission/childSources";
import { validateAndPricePlan, type PlanLookup } from "../src/lib/agentMission/plan";
import { chargeForDelivered, priceMissionByCode, settlementCharge } from "../src/lib/agentMission/price";

/**
 * FIX MISSION 7 (live retest of 2026-10-29 after #293).
 *  A. the per-parent number is read for every phrasing; the target is parents x N (live: «ومن كل فيديو ١٠ تعليقات» gave 5 comments in all);
 *  B. the items the customer counted are delivered as their own sheet, whatever the model marked;
 *  D. the people of a company CAN be served: the catalog has linkable sources, and a plan may not call the step «unserved» before trying them;
 *  E. the settlement arithmetic of a two-stage mission with different costs per stage.
 */
describe("A: the number per parent item, every phrasing (parents x N)", () => {
  // [request, the parents' count, the per-parent number, the child noun]
  const table: Array<[string, number, number, string]> = [
    ["هات ٥ فيديوهات تيك توك عن منتخب مصر، ومن كل فيديو ١٠ تعليقات", 5, 10, "تعليقات"],
    ["هات ٥ بوستات فيسبوك عن غلاء الأسعار، ومع كل بوست ١٠ تعليقات", 5, 10, "تعليقات"],
    ["هات ٥ بوستات ١٠ تعليقات لكل بوست", 5, 10, "تعليقات"],
    ["هات ٥ بوستات، لكل واحد ١٠ تعليقات", 5, 10, "تعليقات"],
    ["هات ٥ بوستات وعلى كل بوست ١٠ تعليقات", 5, 10, "تعليقات"],
    ["هات ٥ بوستات وفي كل بوست ١٠ تعليقات", 5, 10, "تعليقات"],
    ["هات ٥ بوستات وكل بوست فيه ١٠ تعليقات", 5, 10, "تعليقات"],
    ["هات ٥ بوستات وعشر تعليقات تحت كل بوست", 5, 10, "تعليقات"],
    ["هات ٥ بوستات و١٠ تعليقات علي كل بوست", 5, 10, "تعليقات"],
    ["هات ٥ فيديوهات و١٠ تعليقات من كل فيديو", 5, 10, "تعليقات"],
    ["هات 5 posts و من كل بوست 10 تعليقات", 0, 10, "تعليقات"],
    ["هات ٥ تغريدات ومن كل تغريدة عشر ردود", 5, 10, "ردود"],
    ["هات ٣ صفحات ولكل صفحة ٥ منشورات", 3, 5, "منشورات"],
    ["هات ٣ قنوات ومن كل قناة ٤ فيديوهات", 3, 4, "فيديوهات"],
    ["هات ٣ أماكن ومن كل مكان ١٠ تقييمات", 3, 10, "تقييمات"],
    ["هات ٥ فيديوهات وتعليقات كل فيديو ١٠", 5, 10, "تعليقات"],
    ["هات ٥ فيديوهات ومن كل فيديو أول ١٠ تعليقات", 5, 10, "تعليقات"],
    ["هات ٥ فيديوهات وهات من كل فيديو ١٠ تعليقات", 5, 10, "تعليقات"],
    ["عايز ٣ شركات، وجوه كل شركة موظفين اتنين", 3, 2, "موظفين"],
    ["عايز ٣ شركات ومن كل شركة اتنين من المديرين", 3, 2, "المديرين"],
    ["هات ٣ شركات ومع كل شركة ٥ موظفين", 3, 5, "موظفين"],
  ];
  for (const [request, parents, per, noun] of table) {
    it(request, () => {
      const asks = perParentQuantities(request);
      expect(asks.map((q) => [q.value, q.noun])).toEqual([[per, noun]]);
      // the parents' count is the ONE counted quantity (a number that is not per parent)
      const counted = countedQuantities(request);
      if (parents > 0) expect(counted.map((q) => q.value)).toEqual([parents]);
      // the plan target of the child = parents x N
      expect((parents || 5) * asks[0].value).toBe((parents || 5) * per);
    });
  }

  it("a number that is NOT per parent stays a plain quantity: the 5 of «٥ فيديوهات ... ومن كل ...» and «كل التغريدات ٥٠٠»", () => {
    expect(perParentQuantities("هات ٥ فيديوهات تيك توك عن منتخب مصر").map((q) => q.value)).toEqual([]);
    expect(perParentQuantities("هات ٥٠٠ تغريدة عن محمد صلاح")).toEqual([]);
    expect(perParentQuantities("هات ٣٠٠ تعليق من كل الفيديوهات")).toEqual([]);
    expect(perParentQuantities("هات ١٠ تغريدات لكل لاعب").map((q) => q.value)).toEqual([10]);
  });
});

describe("B: the items the customer named are bound to their own stage and delivered", () => {
  it("«هات ٥ فيديوهات ... ومن كل فيديو ١٠ تعليقات» counts the VIDEOS, even when the model kept them as an intermediate stage (live: the 5 became the comments' target)", () => {
    const stages = [{ index: 0, title_ar: "فيديوهات تيك توك عن منتخب مصر", deliver: false }, { index: 1, title_ar: "تعليقات كل فيديو من الفيديوهات عن منتخب مصر", deliver: true }];
    expect(bindQuantityDetailed("هات ٥ فيديوهات تيك توك عن منتخب مصر، ومن كل فيديو ١٠ تعليقات", stages)).toEqual({ index: 0, value: 5, named: true });
    // no stage names the noun: the first delivered stage takes it, and it is not «named»
    expect(bindQuantityDetailed("هات ٥ حاجات", [{ index: 0, title_ar: "الشركات", deliver: false }, { index: 1, title_ar: "المديرين", deliver: true }])).toBeNull();
  });

  const calls = new Map([
    ["call_0001", { id: "call_0001", endpointId: "src.parents", ok: true, costUsd: 0.0005, rows: 20, params: { handle: "someone" } }],
    ["call_0002", { id: "call_0002", endpointId: "src.children", ok: true, costUsd: 0.0005, rows: 10, params: { post: "p1" } }],
  ]);
  const lookupFor = (requestText: string): PlanLookup => ({ call: (id) => calls.get(id) ?? null, evidenceText: () => "p1 c1 https://x.example/p1", endpointAllowed: () => true, requestText });
  const parent = (title: string, deliver: boolean, rows = 5) => ({ key: "parents", title_ar: title, endpoint_id: "src.parents", expected_rows: rows, parent_key: null, deliver, columns: [{ key: "text", title_ar: "الوصف" }, { key: "url", title_ar: "الرابط" }], sample_rows: [{ id: "p1", text: "عن المنتخب", url: "https://x.example/p1" }], measured_by: ["call_0001"] });
  const child = (title: string, rows: number, per: number) => ({ key: "kids", title_ar: title, endpoint_id: "src.children", expected_rows: rows, parent_key: "parents", per_parent_rows: per, deliver: true, columns: [{ key: "text", title_ar: "النص" }, { key: "author", title_ar: "الكاتب" }], sample_rows: [{ id: "c1", text: "تعليق", author: "قارئ" }], measured_by: ["call_0002"] });

  // four mission types: videos + comments, posts + comments, pages + posts, tweets + replies
  const types: Array<[string, string, string, string, number, number]> = [
    ["TikTok videos and their comments", "هات ٥ فيديوهات تيك توك عن منتخب مصر، ومن كل فيديو ١٠ تعليقات", "فيديوهات تيك توك عن منتخب مصر", "تعليقات كل فيديو من الفيديوهات", 5, 10],
    ["Facebook posts and their comments", "هات ٥ بوستات فيسبوك عن غلاء الأسعار في مصر، ومع كل بوست ١٠ تعليقات", "البوستات عن غلاء الأسعار", "تعليقات كل بوست", 5, 10],
    ["pages and their posts", "هات ٣ صفحات عن الإلكترونيات ولكل صفحة ٥ منشورات", "صفحات الإلكترونيات", "منشورات كل صفحة", 3, 5],
    ["tweets and their replies", "هات ٤ تغريدات عن الدوري ومن كل تغريدة عشر ردود", "تغريدات عن الدوري", "ردود كل تغريدة", 4, 10],
  ];
  for (const [name, request, parentTitle, childTitle, parents, per] of types) {
    it(`${name}: the parents are delivered as their own sheet and the child's target is ${parents} x ${per}`, () => {
      // the model's plan as live: parents NOT delivered, the child with the customer's parent count as its rows and its own per-parent number
      const checked = validateAndPricePlan({ summary_ar: "ستحصل على نتائج عن طلبك.", stages: [parent(parentTitle, false, parents), child(childTitle, parents, per)] }, lookupFor(request));
      expect(checked.ok, JSON.stringify(checked)).toBe(true);
      if (!checked.ok) return;
      expect(checked.plan.quantity).toMatchObject({ requested: parents, target: parents, stage_key: "parents" });
      expect(checked.plan.stages.map((s) => [s.deliver, s.planned_rows])).toEqual([[true, parents], [true, parents * per]]);
      expect(checked.plan.stages[1].per_parent_rows).toBe(per);
      expect(checked.plan.price.deliveredRows).toBe(parents + parents * per);
    });
  }

  it("a stage the customer did not count stays an intermediate one", () => {
    const checked = validateAndPricePlan({ summary_ar: "ستحصل على تعليقات.", stages: [parent("فيديوهات المنتخب", false, 5), child("تعليقات كل فيديو", 5, 10)] }, lookupFor("هات ٥٠ تعليق على فيديوهات عن المنتخب"));
    expect(checked.ok, JSON.stringify(checked)).toBe(true);
    if (checked.ok) expect(checked.plan.stages[0].deliver).toBe(false);
  });
});

describe("D: the people of a company can be served from the catalog (linkable sources)", () => {
  const catalog = loadTregCatalog();
  const allowed = (id: string) => isSellable(id, catalog) && !blockedEndpointReason(id);

  it("the catalog has people sources that take a company's website, page link or name, cheapest first", () => {
    const people = peopleSourcesForCompanies(catalog, allowed);
    expect(people.length).toBeGreaterThanOrEqual(3);
    expect(people.map((p) => p.id)).toEqual(expect.arrayContaining(["aviato.companies.employees", "blitzapi.people.employee-finder", "limadata.people.employees.search"]));
    // an e-mail LISTER gives mailboxes (info@, webmaster@), not people: it is not a people source (live 2026-10-31, F1)
    expect(people.map((p) => p.id)).not.toContain("tomba.companies.emails.list");
    expect(people.every((p) => p.accepts.length > 0)).toBe(true);
    // cheapest first by the ranking's own key: the price per item over the expected success rate
    for (let i = 1; i < people.length; i += 1) expect(people[i].effectiveUsd).toBeGreaterThanOrEqual(people[i - 1].effectiveUsd);
  });

  it("the cheapest company sources (the live one, tomba's company search, among them) give a website that those people sources take: a plan with managers is possible", () => {
    const linkable = linkableCompanySources(catalog, allowed);
    const ids = linkable.map((l) => l.id);
    expect(ids).toContain("tomba.companies.search.reveal");
    expect(ids).toContain("aviato.companies.search");
    const tomba = linkable.find((l) => l.id === "tomba.companies.search.reveal")!;
    expect(tomba.feeds.map((f) => f.via)).toContain("domain");
    expect(linkBetween(catalog.byId.get("tomba.companies.search.reveal")!, catalog.byId.get("aviato.companies.employees")!)).toBe("domain");
    // the very first agent mission: aviato's company search and aviato's company employees
    expect(linkBetween(catalog.byId.get("aviato.companies.search")!, catalog.byId.get("aviato.companies.employees")!)).not.toBeNull();
  });

  it("the nouns of people are people; a comment is not", () => {
    for (const n of ["المديرين", "موظفين", "مدراء", "مسؤولين", "صناع القرار"]) expect(isPeopleNoun(n), n).toBe(true);
    for (const n of ["تعليقات", "ردود", "فيديوهات", "اتنين"]) expect(isPeopleNoun(n), n).toBe(false);
    expect(childStepSourcesFor("تعليقات", catalog, allowed)).toEqual([]);
    expect(childStepSourcesFor("المديرين", catalog, allowed).length).toBeGreaterThan(0);
  });

  const request = "عايز ٣ شركات مقاولات في مصر، ومن كل شركة اتنين من المديرين";
  const calls = new Map([["call_0001", { id: "call_0001", endpointId: "tomba.companies.search.reveal", ok: true, costUsd: 0.0005, rows: 20, params: { query: "construction" } }]]);
  const companies = { key: "companies", title_ar: "شركات المقاولات في مصر", endpoint_id: "tomba.companies.search.reveal", expected_rows: 3, parent_key: null, deliver: true, columns: [{ key: "name", title_ar: "اسم الشركة" }, { key: "website", title_ar: "الموقع" }, { key: "country", title_ar: "الدولة" }], sample_rows: [{ id: "orascom.com", name: "Orascom Construction", website: "https://orascom.com", country: "EG" }], measured_by: ["call_0001"] };
  const base = (called: Array<[string, number]>): PlanLookup => ({
    call: (id) => calls.get(id) ?? null, evidenceText: () => "orascom.com https://orascom.com", endpointAllowed: () => true, requestText: request,
    childStepSources: (noun) => childStepSourcesFor(noun, catalog, allowed),
    endpointsCalled: () => new Map(called.map(([id, rows]) => [id, { rows }])),
  });

  it("the live plan (the managers declared «unserved» with no source tried) is REFUSED, and the refusal names the sources that take the company's website", () => {
    const checked = validateAndPricePlan({ summary_ar: "شركات مقاولات مصرية.", stages: [companies], unserved_steps: [{ reason_ar: "المصادر تعامل أسماء الأشخاص كبيانات اتصال تحتاج بريدًا موثقًا" }] }, base([["tomba.companies.search.reveal", 20]]));
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    const text = checked.issues.join(" ");
    expect(text).toContain("CAN be served");
    expect(text).toContain("aviato.companies.employees");
    expect(text).toContain("website");
  });

  it("a plan with no managers step and no reason is told the same sources", () => {
    const checked = validateAndPricePlan({ summary_ar: "شركات مقاولات مصرية.", stages: [companies] }, base([]));
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.issues.join(" ")).toContain("The catalog HAS sources for this step");
  });

  it("a source that was tried and GAVE rows keeps the refusal; two that were tried and gave none allow the honest «unserved»", () => {
    const given = { summary_ar: "شركات مقاولات مصرية.", stages: [companies], unserved_steps: [{ reason_ar: "لم تُرجع المصادر المتاحة أسماء مديرين لهذه الشركات" }] };
    expect(validateAndPricePlan(given, base([["aviato.companies.employees", 6], ["limadata.people.employees.search", 0]])).ok).toBe(false);
    expect(validateAndPricePlan(given, base([["aviato.companies.employees", 0]])).ok).toBe(false);
    const accepted = validateAndPricePlan(given, base([["aviato.companies.employees", 0], ["limadata.people.employees.search", 0]]));
    expect(accepted.ok, JSON.stringify(accepted)).toBe(true);
  });
});

describe("D: a plan with the managers' stage is accepted, priced, and the card shows what it costs", () => {
  const request = "عايز ٣ شركات مقاولات في مصر، ومن كل شركة اتنين من المديرين";
  const calls = new Map([
    ["call_0001", { id: "call_0001", endpointId: "tomba.companies.search.reveal", ok: true, costUsd: 0.0005, rows: 20, params: { query: "construction" } }],
    ["call_0002", { id: "call_0002", endpointId: "aviato.companies.employees", ok: true, costUsd: 0.005, rows: 2, params: { website: "orascom.com", perPage: 2, page: 0 } }],
  ]);
  const lookup: PlanLookup = { call: (id) => calls.get(id) ?? null, evidenceText: () => "orascom.com https://orascom.com person-1 person-2", endpointAllowed: () => true, requestText: request };
  const companies = { key: "companies", title_ar: "شركات المقاولات في مصر", endpoint_id: "tomba.companies.search.reveal", expected_rows: 3, parent_key: null, deliver: true, columns: [{ key: "name", title_ar: "اسم الشركة" }, { key: "website", title_ar: "الموقع" }, { key: "country", title_ar: "الدولة" }], sample_rows: [{ id: "orascom.com", name: "Orascom Construction", website: "https://orascom.com", country: "EG" }], measured_by: ["call_0001"] };
  const managers = { key: "managers", title_ar: "مديرو كل شركة", endpoint_id: "aviato.companies.employees", expected_rows: 6, parent_key: "companies", per_parent_rows: 2, deliver: true, columns: [{ key: "name", title_ar: "اسم المدير" }, { key: "title", title_ar: "المسمى الوظيفي" }], sample_rows: [{ id: "person-1", name: "Example Person", title: "Director" }], measured_by: ["call_0002"] };

  it("3 companies and 2 managers of each: 3 + 6 items, one price for the whole, higher than the companies alone", () => {
    const withManagers = validateAndPricePlan({ summary_ar: "ستحصل على شركات مقاولات مصرية ومديرين من كل شركة.", stages: [companies, managers] }, lookup);
    expect(withManagers.ok, JSON.stringify(withManagers)).toBe(true);
    const alone = validateAndPricePlan({ summary_ar: "ستحصل على شركات مقاولات مصرية.", stages: [companies], unserved_steps: [{ reason_ar: "لم تتوفر مصادر لأسماء المديرين" }] }, lookup);
    expect(alone.ok, JSON.stringify(alone)).toBe(true);
    if (!withManagers.ok || !alone.ok) return;
    expect(withManagers.plan.stages.map((s) => [s.key, s.planned_rows])).toEqual([["companies", 3], ["managers", 6]]);
    expect(withManagers.plan.price.deliveredRows).toBe(9);
    expect(withManagers.plan.price.reservePoints).toBeGreaterThanOrEqual(alone.plan.price.reservePoints);
  });
});

describe("E: the settlement arithmetic of a two-stage mission with different costs per stage (the live Facebook mission: 5 posts + 50 comments, 42 delivered, charge 256)", () => {
  // the live plan's measured costs: posts 0.005904 USD each, comments 0.000188 USD each
  const stages = [{ rows: 5, costPerRowUsd: 0.005904, deliver: true }, { rows: 50, costPerRowUsd: 0.000188, deliver: true }];
  const price = priceMissionByCode(stages as never, { settings: { markup: 10, minChargePoints: 200 } });

  it("the price is ONE unit for every delivered item of the job: (provider + model cost) / delivered rows, not a unit per stage", () => {
    expect(price.providerCostUsd).toBeCloseTo(5 * 0.005904 + 50 * 0.000188, 10);
    expect(price.deliveredRows).toBe(55);
    expect(price.unitPricePoints).toBe(6.092);
    expect(price.maxChargePoints).toBe(336);
    expect(price.reservePoints).toBe(386);
  });

  it("the card's 336 is ceil(55 x 6.092 = 335.06); the charge for 42 delivered is ceil(42 x 6.092 = 255.864) = 256, below the hold of 386 and never above it", () => {
    expect(chargeForDelivered(55, price.unitPricePoints)).toBe(336);
    expect(chargeForDelivered(42, price.unitPricePoints)).toBe(256);
    const settled = settlementCharge({ deliveredUnits: 42, unitPricePoints: price.unitPricePoints, reservedPoints: price.reservePoints });
    expect(settled).toEqual({ chargedPoints: 256, releasedPoints: 130 });
  });

  it("the charge depends on how many items arrive, not on which stage they came from (5 posts + 37 comments, or 42 comments: the same 256)", () => {
    expect(chargeForDelivered(5 + 37, price.unitPricePoints)).toBe(chargeForDelivered(42, price.unitPricePoints));
    // the rule «delivered / target x card price» with the card's ROUNDED price would say 257 (42 / 55 x 336 = 256.58): the code rounds once, on the exact product, and charges the customer a point less
    expect(Math.ceil((42 / 55) * 336)).toBe(257);
    expect(chargeForDelivered(42, price.unitPricePoints)).toBeLessThanOrEqual(Math.ceil((42 / 55) * 336));
    // nothing delivered, nothing charged; everything delivered, exactly the card's price; never above the hold
    expect(settlementCharge({ deliveredUnits: 0, unitPricePoints: price.unitPricePoints, reservedPoints: price.reservePoints }).chargedPoints).toBe(0);
    expect(settlementCharge({ deliveredUnits: 55, unitPricePoints: price.unitPricePoints, reservedPoints: price.reservePoints }).chargedPoints).toBe(336);
    expect(settlementCharge({ deliveredUnits: 500, unitPricePoints: price.unitPricePoints, reservedPoints: price.reservePoints }).chargedPoints).toBeLessThanOrEqual(price.reservePoints);
  });
});
