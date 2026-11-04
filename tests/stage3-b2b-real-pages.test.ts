import { existsSync, readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { B2B_CARDS, UNVERIFIED_B2B_CARDS, b2bCardsFor, checkB2BCardOnPage, readB2BRows, type B2BCard } from "../src/lib/agentMission/stage3/b2bCards";
import { buildB2BAsk } from "../src/lib/agentMission/stage3/b2bAsk";
import { compileB2BPlan } from "../src/lib/agentMission/stage3/b2bCompile";

/**
 * STAGE 3 S1 (docs/STAGE-3.md): THE B2B CARDS VERIFIED ON THE FIRST REAL COMPANY AND DECISION-MAKER PAGES (anonymised, tests/fixtures/live/missions/msn_4969a50fed8c45b37d8f and
 * msn_7539ea17512cf58aa0e7). A stored page does not name its tool, so a page is attributed to a tool by its SHAPE and the attribution is itself tested: the page's top-level keys equal that
 * endpoint's own catalog example and no other endpoint of the catalog has them (the maps pages share a generic wrapper, so their item fields are compared instead). A card is `verified`
 * only with the pages it maps on listed in `verifiedOn`, and that list is DERIVED here from the stored pages (never typed by hand). Values of people are placeholders in the stored pages, so
 * a finder's value path is tested by putting a fake value at the stored page's OWN key (the real structure, a made-up value), as the other real-page tests of this repo do.
 */
const MISSIONS = ["msn_4969a50fed8c45b37d8f", "msn_7539ea17512cf58aa0e7"] as const;
const catalog = loadTregCatalog();
const snapshot = JSON.parse(readFileSync(new URL("../data/treg/treg_catalog_sellable.json", import.meta.url), "utf8")) as { endpoints: Array<{ id: string; example_response_trimmed?: unknown; example_response?: unknown; list_path?: string; item_fields?: Record<string, unknown> }> };
const exampleKeys = new Map<string, string>();
for (const e of snapshot.endpoints) { const x = e.example_response_trimmed ?? e.example_response; if (x && typeof x === "object" && !Array.isArray(x)) exampleKeys.set(e.id, Object.keys(x).sort().join(",")); }

type Page = Record<string, unknown>;
const stored: Array<{ mission: string; call: string; page: Page }> = MISSIONS.flatMap((m) => {
  const dir = new URL(`./fixtures/live/missions/${m}/raw/`, import.meta.url);
  return existsSync(dir) ? readdirSync(dir).filter((n) => /^call_\d{4}\.json$/.test(n)).sort().map((n) => ({ mission: m, call: n.replace(".json", ""), page: JSON.parse(readFileSync(new URL(n, dir), "utf8")) as Page })) : [];
});
const keysOf = (p: Page): string => Object.keys(p).sort().join(",");
const card = (id: string): B2BCard => B2B_CARDS.find((c) => c.endpointId === id)!;

/** The stored pages of a tool, by shape: the exact catalog example keys (list and lookup tools) or, for the generic maps wrapper, the exact item fields of the catalog. */
function pagesOf(endpointId: string): typeof stored {
  if (endpointId === "crawl4ai.google.serp.maps") {
    const fields = Object.keys(snapshot.endpoints.find((e) => e.id === endpointId)!.item_fields ?? {}).sort().join(",");
    return stored.filter((s) => Array.isArray(s.page.rows) && s.page.rows.length > 0 && Object.keys((s.page.rows as Array<Record<string, unknown>>)[0]).sort().join(",") === fields);
  }
  return stored.filter((s) => keysOf(s.page) === exampleKeys.get(endpointId));
}
const flat = (c: B2BCard): string[] => c.verifiedOn.flatMap((v) => v.calls.map((x) => `${v.mission}/${x}`)).sort();
const VERIFIED = ["tomba.companies.search.reveal", "aviato.companies.employees", "blitzapi.people.employee-finder", "crawl4ai.google.serp.maps", "blitzapi.people.email.find", "blitzapi.people.phone.find"];

describe("the stored pages exist and are attributed to their tool by shape", () => {
  it("both missions are in the repo: 87 raw pages", () => { expect(stored.length).toBe(87); });
  it("five tools have a page key set that no other endpoint of the whole catalog shares; the maps pages match the catalog's item fields exactly", () => {
    for (const id of VERIFIED.filter((x) => x !== "crawl4ai.google.serp.maps")) {
      const k = exampleKeys.get(id)!;
      expect([...exampleKeys.entries()].filter(([, v]) => v === k).map(([i]) => i), id).toEqual([id]);
      expect(pagesOf(id).length, id).toBeGreaterThan(0);
    }
    expect(pagesOf("crawl4ai.google.serp.maps").length).toBe(4);
  });
  it("the counts of pages per tool", () => {
    expect(Object.fromEntries(VERIFIED.map((id) => [id, pagesOf(id).length]))).toEqual({
      "tomba.companies.search.reveal": 4, "aviato.companies.employees": 6, "blitzapi.people.employee-finder": 8, "crawl4ai.google.serp.maps": 4, "blitzapi.people.email.find": 18, "blitzapi.people.phone.find": 18,
    });
  });
});

describe("the cards: exactly the six with real pages are verified, and their pages are the ones the shape finds", () => {
  it("each verified card lists the stored pages it maps on, equal to the pages found by shape", () => {
    for (const id of VERIFIED) {
      expect(card(id).status, id).toBe("verified");
      expect(flat(card(id)), id).toEqual(pagesOf(id).map((s) => `${s.mission}/${s.call}`).sort());
    }
  });
  it("every other card stays unverified with an empty `verifiedOn`", () => {
    const rest = B2B_CARDS.filter((c) => !VERIFIED.includes(c.endpointId));
    expect(rest.length).toBe(13);
    for (const c of rest) { expect(c.status, c.endpointId).toBe("unverified"); expect(c.verifiedOn).toEqual([]); }
    expect([...UNVERIFIED_B2B_CARDS].sort()).toEqual(rest.map((c) => c.endpointId).sort());
  });
  it("prices and list paths still agree with the catalog (the new cards too)", () => {
    for (const c of B2B_CARDS) expect(c.costUsd, c.endpointId).toBe(catalog.byId.get(c.endpointId)!.cost?.usd);
  });
});

describe("each list card maps its real pages: one row per listed item, every row with an id", () => {
  for (const id of ["tomba.companies.search.reveal", "aviato.companies.employees", "blitzapi.people.employee-finder", "crawl4ai.google.serp.maps"]) {
    it(id, () => {
      // a real page may be an empty answer (no result): the verifier then finds an empty list, and that is not an issue; the tool must give rows on some page
      let rows = 0;
      for (const s of pagesOf(id)) {
        const r = checkB2BCardOnPage(card(id), s.page);
        expect(r.issues, `${s.mission}/${s.call}`).toEqual([]);
        rows += r.rows.length;
      }
      expect(rows, id).toBeGreaterThan(0);
    });
  }
  it("the companies tool: 50 companies a page, the website, the activity and the HQ filled, and NO HQ phone: tomba's `phone_number` is the boolean «false» on all 200 companies (a flag, never a number)", () => {
    let companies = 0;
    for (const s of pagesOf("tomba.companies.search.reveal")) {
      const listed = (s.page.data as { companies: Array<Record<string, unknown>> }).companies;
      companies += listed.length;
      for (const x of listed) expect(x.phone_number).toBe(false);
      const rows = readB2BRows(card("tomba.companies.search.reveal"), s.page);
      expect(rows).toHaveLength(listed.length);
      for (const r of rows) { expect("hq_phone" in r, "a boolean flag is not a phone").toBe(false); expect(typeof r.website).toBe("string"); expect(typeof r.activity).toBe("string"); }
    }
    expect(companies).toBe(200);
  });
  it("the page echoes the filters the live call carried: a country and an industry, and NO size (so size is not claimed by the card)", () => {
    for (const s of pagesOf("tomba.companies.search.reveal")) expect(Object.keys((s.page.meta as { filters: Record<string, unknown> }).filters).sort()).toEqual(["industry", "location_country"]);
    expect(card("tomba.companies.search.reveal").carries).toEqual(["sector", "country"]);
  });
  it("the maps tool gives the company's phone as text on its rows, the people tools give the person's name, title and the profile link", () => {
    const maps = pagesOf("crawl4ai.google.serp.maps").flatMap((s) => readB2BRows(card("crawl4ai.google.serp.maps"), s.page));
    expect(maps.some((r) => typeof r.hq_phone === "string" && r.hq_phone !== "")).toBe(true);
    for (const id of ["aviato.companies.employees", "blitzapi.people.employee-finder"]) for (const s of pagesOf(id)) for (const r of readB2BRows(card(id), s.page)) { expect(typeof r.person_name, id).toBe("string"); expect(typeof r.title, id).toBe("string"); }
    for (const s of pagesOf("blitzapi.people.employee-finder")) for (const r of readB2BRows(card("blitzapi.people.employee-finder"), s.page)) expect(typeof r.linkedin).toBe("string");
  });
});

describe("the finders: the stored answers, and the value path on the stored structure with a made-up value", () => {
  it("e-mail finder: 18 answers, 4 found (1 or 2 addresses) and 14 not; a not-found answer gives no row", () => {
    const pages = pagesOf("blitzapi.people.email.find");
    expect(pages.filter((s) => s.page.found === true)).toHaveLength(4);
    for (const s of pages.filter((x) => x.page.found === false)) { expect(readB2BRows(card("blitzapi.people.email.find"), s.page)).toEqual([]); expect(s.page.email).toBeNull(); }
  });
  it("e-mail finder, a found answer: the value at the page's own `email` key is the row's e-mail (fake value, real structure)", () => {
    const found = pagesOf("blitzapi.people.email.find").find((s) => s.page.found === true)!;
    const withValue = { ...found.page, email: "someone@example.test", all_emails: ["someone@example.test"] };
    const rows = readB2BRows(card("blitzapi.people.email.find"), withValue);
    expect(rows).toHaveLength(1);
    expect(rows[0].email).toBe("someone@example.test");
    expect(["verified", "unverified"]).toContain(rows[0].email_status);
  });
  it("phone finder: 18 answers, 2 found; a found answer's `phone` becomes the row's mobile (fake value, real structure)", () => {
    const pages = pagesOf("blitzapi.people.phone.find");
    expect(pages.filter((s) => s.page.found === true)).toHaveLength(2);
    for (const s of pages.filter((x) => x.page.found === false)) expect(readB2BRows(card("blitzapi.people.phone.find"), s.page)).toEqual([]);
    const found = pages.find((s) => s.page.found === true)!;
    const rows = readB2BRows(card("blitzapi.people.phone.find"), { ...found.page, phone: "+20 2 0000 0000" });
    expect(rows).toHaveLength(1);
    // the shared contact reader writes the number in its normal form: the digits are the made-up number's
    expect(String(rows[0].mobile).replace(/\D/g, "")).toBe("20200000000");
  });
  it("both finders take the person's profile link (what the people tool gives)", () => {
    for (const id of ["blitzapi.people.email.find", "blitzapi.people.phone.find"]) expect(card(id).needs, id).toEqual(["person_linkedin"]);
  });
});

describe("the verifier refuses a contact field that holds a non-text value (the defect the real page showed)", () => {
  it("a boolean mapped to the HQ phone is an issue; a text value is not", () => {
    const c: B2BCard = { ...card("tomba.companies.search.reveal"), page: { list: ["items"], cursor: null }, reader: { kind: "list", fields: { id: ["id"], hq_phone: ["phone_number"] } } };
    expect(checkB2BCardOnPage(c, { items: [{ id: "a", phone_number: false }] }).issues).toEqual(["a contact field holds a non-text value"]);
    expect(checkB2BCardOnPage(c, { items: [{ id: "a", phone_number: "+20 2 0000 0000" }] }).issues).toEqual([]);
    expect(checkB2BCardOnPage(c, { items: [{ id: "a" }] }).issues).toEqual([]);
  });
});

describe("a customer path now gets the verified cards, and only those", () => {
  it("by default: companies, the people of a company, the e-mail and the phone finders, and the maps phone; never the unverified roles", () => {
    expect(b2bCardsFor("companies.search").map((c) => c.endpointId)).toEqual(["tomba.companies.search.reveal"]);
    expect(b2bCardsFor("company.people").map((c) => c.endpointId)).toEqual(["blitzapi.people.employee-finder", "aviato.companies.employees"]);
    expect(b2bCardsFor("person.email").map((c) => c.endpointId)).toEqual(["blitzapi.people.email.find"]);
    expect(b2bCardsFor("person.phone").map((c) => c.endpointId)).toEqual(["blitzapi.people.phone.find"]);
    expect(b2bCardsFor("company.phone").map((c) => c.endpointId)).toEqual(["crawl4ai.google.serp.maps"]);
    expect(b2bCardsFor("people.search")).toEqual([]);
    expect(b2bCardsFor("company.emails")).toEqual([]);
  });
  it("the live request of msn_7539ea17512cf58aa0e7 compiles on verified cards alone: the companies tool, the people tool that carries the title, the two finders, and the maps phone as the only HQ-phone source", () => {
    const r = compileB2BPlan(buildB2BAsk("عايز ٥ شركات مصرية في قطاع الكهروميكانيكا، ومعاهم صناع القرار")!);
    if (!r.ok) throw new Error(r.reason);
    expect([r.companiesCard, r.peopleCard]).toEqual(["tomba.companies.search.reveal", "blitzapi.people.employee-finder"]);
    expect(r.chains).toEqual({ general_email: [], hq_phone: ["crawl4ai.google.serp.maps"], email: ["blitzapi.people.email.find"], mobile: ["blitzapi.people.phone.find"] });
  });
});
