import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { B2B_CARDS, UNVERIFIED_B2B_CARDS, b2bCardsFor, checkB2BCardOnPage, readB2BRows, type B2BCard } from "../src/lib/agentMission/stage3/b2bCards";

/**
 * STAGE 3 (docs/STAGE-3.md), THE B2B TOOL CARDS: one data record per companies / people / contact tool of the catalog. A card is VERIFIED only on a stored real page in the repo; there is
 * none for a B2B tool yet (the 36 stored missions of tests/fixtures/live are social), so every card is «unverified» and no customer path may use one. The verifier itself is tested on
 * pages built here from the card's own paths, with clearly fake values (never a real company or person).
 */
const catalog = loadTregCatalog();

describe("every card is honest about its source", () => {
  it("each card's tool is in the catalog, with the catalog's price and list path", () => {
    for (const c of B2B_CARDS) {
      const e = catalog.byId.get(c.endpointId);
      expect(e, c.endpointId).toBeDefined();
      expect(c.costUsd, c.endpointId).toBe(e!.cost?.usd);
      if (c.page.list && e!.list_path && !/NOT FOUND/.test(e!.list_path)) expect(c.page.list.join("."), c.endpointId).toBe(e!.list_path === "root" ? "" : e!.list_path);
    }
  });
  it("no stored real B2B page exists in the repo, so every card is unverified with nothing in `verifiedOn`", () => {
    // not a count of stored missions (main adds social ones): no CALL of the stored missions' call index is a B2B tool of the cards
    const index = JSON.parse(readFileSync(new URL("./fixtures/live/call-index.json", import.meta.url), "utf8")) as { missions: Record<string, Array<[string, string, string, ...unknown[]]>> };
    const called = new Set(Object.values(index.missions).flat().map((c) => c[2]));
    for (const c of B2B_CARDS) expect(called.has(c.endpointId), c.endpointId).toBe(false);
    for (const c of B2B_CARDS) { expect(c.status, c.endpointId).toBe("unverified"); expect(c.verifiedOn).toEqual([]); }
    expect([...UNVERIFIED_B2B_CARDS].sort()).toEqual(B2B_CARDS.map((c) => c.endpointId).sort());
  });
  it("a card can only say «verified» with the stored pages it was verified on (the type check of the list)", () => {
    for (const c of B2B_CARDS) if (c.status === "verified") expect(c.verifiedOn.length).toBeGreaterThan(0);
  });
  it("every role the compiler needs has at least one card", () => {
    const roles = new Set(B2B_CARDS.map((c) => c.role));
    for (const r of ["companies.search", "company.people", "people.search", "person.email", "person.phone", "company.emails", "company.phone"]) expect(roles.has(r as never), r).toBe(true);
  });
});

describe("customer paths never get an unverified card", () => {
  it("by default no role returns a card; only an explicit test switch returns the unverified ones", () => {
    for (const role of ["companies.search", "company.people", "people.search", "person.email", "person.phone", "company.emails", "company.phone"] as const) {
      expect(b2bCardsFor(role)).toEqual([]);
      expect(b2bCardsFor(role, { allowUnverified: true }).length).toBeGreaterThan(0);
    }
  });
  it("a broken card is never returned, even with the test switch", () => {
    const broken: B2BCard = { ...B2B_CARDS[0], endpointId: "x.broken", status: "broken" };
    expect(b2bCardsFor(broken.role, { allowUnverified: true, cards: [broken] })).toEqual([]);
  });
});

describe("the verifier (on pages built from the card's own paths, fake values)", () => {
  const company = B2B_CARDS.find((c) => c.endpointId === "icypeas.companies.search")!;
  const at = (path: ReadonlyArray<string>, value: unknown): Record<string, unknown> => path.reduceRight<unknown>((v, k) => ({ [k]: v }), value) as Record<string, unknown>;
  const fakeItem = { _id: "co_fake_1", name: "Example Trading Co", website: "https://example.test", industry: "Construction", address: "Cairo, Egypt", phone: "+20 2 0000 0000", numberOfEmployees: 120, foundedYear: 2012, url: "https://www.linkedin.com/company/example-fake" };
  it("a page with the list where the card says: one row per item, each with an id, its fields read", () => {
    const page = at(company.page.list!, [fakeItem, { ...fakeItem, _id: "co_fake_2", name: "Example Two" }]);
    const check = checkB2BCardOnPage(company, page);
    expect(check.issues).toEqual([]);
    expect(check.rows.map((r) => [r.id, r.name, r.hq_phone, r.employees])).toEqual([["co_fake_1", "Example Trading Co", "+20 2 0000 0000", 120], ["co_fake_2", "Example Two", "+20 2 0000 0000", 120]]);
  });
  it("a page without the list, or an item without an id, is named as an issue (never a value of the page)", () => {
    expect(checkB2BCardOnPage(company, { other: [] }).issues).toEqual(["no list at the card's path"]);
    expect(checkB2BCardOnPage(company, at(company.page.list!, [{ name: "x" }])).issues).toEqual(["a row without an id"]);
  });
  it("a lookup card (an e-mail finder) reads its one value with the shared contact reader", () => {
    const finder = B2B_CARDS.find((c) => c.role === "person.email")!;
    expect(readB2BRows(finder, { data: { email: "someone@example.test", status: "valid" } })).toEqual([{ id: "answer", email: "someone@example.test", email_status: "verified" }]);
    expect(readB2BRows(finder, { data: { email: null } })).toEqual([]);
  });
});
