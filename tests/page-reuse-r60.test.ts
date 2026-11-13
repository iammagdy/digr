import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createJobCallBudget } from "../src/lib/server/callBudget";
import { createMemoryStore, newMission } from "../agent/src/memoryStore";
import { createWebGateway, PAGE_REUSE_ENDPOINT, PAGES_DIR, type WebGatewayDeps } from "../agent/src/webGateway";
import { savedParentSites } from "../agent/src/pageReuse";
import { canonicalPageUrl, cloudflareEmailOf, emailsFromPage, linksFromPage, normalizePhone, pageTextChars, phonesFromPage, siteOf } from "../src/lib/agentMission/pageExtract";
import { fakeRecorder, USER_ID } from "./helpers/agentHarness";
import { emailsOf, fakeContextDev, linksOf, phonesOf } from "./helpers/fakeContextDev";

/**
 * ROUND 60: ONE PAID FETCH PER PAGE, AND NO PAID PAGE FOR A COMPANY THAT IS NOT SAVED. The pages of the live mission msn_088c (tests/fixtures/msn-088c-pages.json) and its recorded calls
 * (tests/fixtures/msn-088c-calls.json); no provider and no model is called.
 */
vi.stubGlobal("fetch", () => { throw new Error("a real network call was attempted"); });
const USD = 0.00254;
const fx = JSON.parse(readFileSync(new URL("./fixtures/msn-088c-pages.json", import.meta.url), "utf8")) as {
  delivered_contacts: Array<{ company: string; email?: string; phone?: string; link: string }>;
  pages: Array<{ url: string; final_url?: string; fetch: "ok" | "failed"; markdown?: string; recorded_parser_rows: Record<string, number | "failed"> }>;
};
const calls = JSON.parse(readFileSync(new URL("./fixtures/msn-088c-calls.json", import.meta.url), "utf8")) as { delivered_company_sites: string[]; calls: Array<{ phase: string; endpoint_id: string; status: string; url: string | null; cost_usd: number }> };
const pageOf = (url: string) => fx.pages.find((p) => canonicalPageUrl(p.url) === canonicalPageUrl(url));

afterEach(() => { delete process.env.DIGER_WEB_PAGE_REUSE; });

// ------------------------------------------------------------------------------------------------ the extraction, against what the parsers returned on 13 Nov
describe("round 60: code reads the same fields the paid parsers returned (msn_088c pages)", () => {
  const readable = fx.pages.filter((p) => p.fetch === "ok");

  it("e-mails: the same count as the parser on every page it read (13 parser calls, 15 pages)", () => {
    for (const p of readable) {
      const want = p.recorded_parser_rows.emails;
      if (typeof want !== "number") continue;
      expect([p.url, emailsFromPage({ markdown: p.markdown! }).length]).toEqual([p.url, want]);
    }
  });

  it("phones: the same count on every page but one (first-cosmetics.com: the parser gave 2 rows, the page carries one distinct number, +20244890195)", () => {
    const differ: string[] = [];
    for (const p of readable) {
      const want = p.recorded_parser_rows["phone-numbers"];
      if (typeof want !== "number") continue;
      const got = phonesFromPage({ markdown: p.markdown! }, "EG").length;
      if (got !== want) differ.push(`${p.url} parser ${want} code ${got}`);
    }
    expect(differ).toEqual(["https://first-cosmetics.com parser 2 code 1"]);
    expect(phonesFromPage({ markdown: pageOf("https://first-cosmetics.com")!.markdown! }, "EG")).toEqual([{ phone: "+20244890195" }]);
  });

  it("links: the contact page the model opened on 13 Nov is among the links code reads from every home page; the counts equal the parser's on 6 of 9 home pages", () => {
    const opened: Record<string, string> = {
      "https://bobana-eg.com": "https://bobana-eg.com/pages/contact", "https://yolo-cosmetics.com": "https://yolo-cosmetics.com/language/en/contact-us/", "https://kaline.com": "https://kaline.com/pages/contact",
      "https://deoc.store": "https://deoc.store/pages/contact", "https://donnanatural.com": "https://donnanatural.com/contact", "https://first-cosmetics.com": "https://www.first-cosmetics.com/contact-details/", "https://nanostetic.com": "https://nanostetic.com/contact-us/",
    };
    for (const [home, contact] of Object.entries(opened)) {
      const p = pageOf(home)!;
      const links = linksFromPage({ markdown: p.markdown!, finalUrl: p.final_url! }).map((l) => canonicalPageUrl(l.url));
      expect([home, links.includes(canonicalPageUrl(contact))]).toEqual([home, true]);
    }
    const same = readable.filter((p) => typeof p.recorded_parser_rows.links === "number" && linksFromPage({ markdown: p.markdown!, finalUrl: p.final_url! }).length === p.recorded_parser_rows.links).map((p) => p.url);
    expect(same).toEqual(["https://nanostetic.com", "https://bobana-eg.com", "https://kaline.com", "https://deoc.store", "https://donnanatural.com"]);
  });

  it("every contact value DELIVERED on 13 Nov is read by code from its cited page; nothing else is claimed for the companies whose pages carry none", () => {
    for (const c of fx.delivered_contacts) {
      const p = pageOf(c.link)!;
      if (c.email) expect(emailsFromPage({ markdown: p.markdown! }).map((x) => x.email)).toContain(c.email);
      if (c.phone) expect(phonesFromPage({ markdown: p.markdown! }, "EG").map((x) => x.phone)).toContain(c.phone);
    }
    for (const u of ["https://kaline.com/pages/contact", "https://deoc.store/pages/contact", "https://kaline.com", "https://deoc.store", "https://bobana-eg.com"]) {
      expect([u, emailsFromPage({ markdown: pageOf(u)!.markdown! }), phonesFromPage({ markdown: pageOf(u)!.markdown! }, "EG")]).toEqual([u, [], []]);
    }
  });

  it("no false phone: «562-597-239» on kaline.com (no country code, no leading 0) is not a phone; a price, a date or a product id is not one either", () => {
    expect(normalizePhone("562-597-239", "EG")).toBeNull();
    expect(phonesFromPage({ markdown: "Price 1,250.00 EGP — order 2026-11-13 — SKU 123456789012 [x](https://shop.example/products/01012345678)" }, "EG")).toEqual([]);
  });

  it("phones are read in the forms the pages write them", () => {
    expect(normalizePhone("+2 02 22620242", null)).toBe("+20222620242");
    expect(normalizePhone("+2 011 21310001", null)).toBe("+201121310001");
    expect(normalizePhone("(202)26212652", null)).toBe("+20226212652");
    expect(normalizePhone("(+203) 548 0112", null)).toBe("+2035480112");
    expect(normalizePhone("01130755305", "EG")).toBe("+201130755305");
    expect(normalizePhone("01130755305", null)).toBeNull();
    expect(normalizePhone("٠١١٣٠٧٥٥٣٠٥", "EG")).toBe("+201130755305");
    expect(normalizePhone("+44 20 7946 0958", null)).toBe("+442079460958");
    expect(normalizePhone("+20 12 345", null)).toBeNull();
  });

  it("e-mails: mailto and text once each; placeholders, images and masked addresses are not addresses; a Cloudflare-protected address is the page's own", () => {
    const cf = (email: string, key = 0x2a) => `/cdn-cgi/l/email-protection#${key.toString(16).padStart(2, "0")}${[...email].map((c) => (c.charCodeAt(0) ^ key).toString(16).padStart(2, "0")).join("")}`;
    expect(cloudflareEmailOf(cf("sales@acme.eg"))).toBe("sales@acme.eg");
    const md = `[Write us](mailto:Info@Acme.EG?subject=hi) info@acme.eg i***@acme.eg name@example.com logo@2x.png [x](${cf("sales@acme.eg")})`;
    expect(emailsFromPage({ markdown: md }).map((x) => x.email)).toEqual(["info@acme.eg", "sales@acme.eg"]);
  });

  it("one page, whatever way the address is written; the site of a page", () => {
    expect(canonicalPageUrl("https://www.first-cosmetics.com/contact-details/")).toBe(canonicalPageUrl("http://first-cosmetics.com/contact-details"));
    expect(canonicalPageUrl("https://kaline.com/pages/contact?utm_source=x#top")).toBe("kaline.com/pages/contact");
    expect(canonicalPageUrl("https://a.com/p?b=2&a=1")).toBe(canonicalPageUrl("https://a.com/p?a=1&b=2"));
    expect(canonicalPageUrl("mailto:x@y.com")).toBeNull();
    expect(siteOf("https://www.Bobana-EG.com/pages/contact")).toBe("bobana-eg.com");
    expect(pageTextChars("")).toBe(0);
  });
});

// ------------------------------------------------------------------------------------------------ the gateway
async function rowsOf(w: { store: ReturnType<typeof createMemoryStore> }, r: { call_id: string }) { return JSON.parse((await w.store.getFile("msn_page0001", `raw/${r.call_id}.json`))!).rows; }
function world(options: { phase?: "planning" | "execution"; reuse?: boolean; parents?: Set<string> | null; failFor?: (url: string) => "throw" | "WEBSITE_NOT_FOUND" | "TIMEOUT" | null; store?: ReturnType<typeof createMemoryStore>; budget?: number } = {}) {
  const store = options.store ?? createMemoryStore();
  const id = "msn_page0001";
  if (!store.missions.has(id)) store.missions.set(id, newMission({ id, user_id: USER_ID, status: options.phase === "planning" ? "planning" : "executing" }));
  const rec = fakeRecorder({});
  const fake = fakeContextDev({
    scrape: (url) => ({ markdown: pageOf(url)?.markdown ?? "", credits: 1 }),
    parse: (parser, url) => {
      const p = pageOf(url)!;
      const page = { markdown: p.markdown!, finalUrl: p.final_url! };
      if (parser === "emails") return { data: emailsOf(emailsFromPage(page).map((x) => x.email)), credits: 1 };
      if (parser === "phone-numbers") return { data: phonesOf(phonesFromPage(page, "EG").map((x) => x.phone)), credits: 1 };
      return { data: linksOf(linksFromPage(page).map((l) => [l.url, l.text])), credits: 1 };
    },
  });
  const fetchFn = vi.fn(async (input: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    const how = body?.url ? options.failFor?.(body.url) ?? null : null;
    if (how === "throw") { fake.requests.push({ url: input, body, headers: {} }); throw new Error("socket hang up"); }
    if (how) { fake.requests.push({ url: input, body, headers: {} }); return { status: 200, ok: true, headers: new Headers(), json: async () => ({ url: body.url, markdown: { requested: true, success: false, data: null, error_code: how }, parsed: { success: false, error_code: how } }) } as unknown as Response; }
    return fake.fetchFn(input, init);
  });
  const budget = createJobCallBudget({ ceilingUsd: options.budget ?? 0.5, spentUsd: 0 });
  const deps: WebGatewayDeps = {
    store, missionId: id, jobId: "job_x", phase: options.phase ?? "execution", budget, recorder: rec.recorder, providerKey: async () => "ctx-key-for-test", fetchFn: fetchFn as any, counter: { seq: store.calls.length },
    ...(options.reuse === false ? {} : { pageReuse: { countryHint: "EG", ...(options.parents !== undefined ? { parentSites: async () => options.parents ?? null } : {}) } }),
  };
  const web = createWebGateway(deps);
  const paid = () => store.calls.filter((c) => Number(c.cost_usd) > 0);
  const reused = () => store.calls.filter((c) => c.endpoint_id === PAGE_REUSE_ENDPOINT);
  return { store, web, rec, fake, budget, paid, reused, requests: () => fake.requests.filter((r) => r.url.endsWith("/web/scrape")) };
}

describe("round 60: one paid fetch per page (execution)", () => {
  it("emails, phone-numbers, links and the page text of ONE page: one provider request, one charge; the other three are read by code at no charge, with the call that bought the page", async () => {
    const w = world();
    const url = "https://donnanatural.com/contact";
    const e: any = await w.web.parsePage({ parser: "emails", url });
    const p: any = await w.web.parsePage({ parser: "phone-numbers", url: "https://www.donnanatural.com/contact/" });
    const l: any = await w.web.parsePage({ parser: "links", url });
    const s: any = await w.web.webScrape({ provider: "contextdev", url });
    expect(w.requests()).toHaveLength(1);
    expect(w.requests()[0].body.formats).toEqual({ markdown: true });
    expect(w.paid()).toHaveLength(1);
    expect(Number(w.paid()[0].cost_usd)).toBeCloseTo(USD, 9);
    // the paid row keeps the parser's own endpoint, so the measured price of a parser call is what it always was
    expect(w.paid()[0]).toMatchObject({ endpoint_id: "contextdev.parse.emails", status: "ok", rows_returned: 1 });
    expect(w.paid()[0].params_digest).toMatchObject({ fetched_as: "page", extraction: "code" });
    expect(await rowsOf(w, e)).toEqual([{ email: "hello@donnanatural.com" }]);
    expect(await rowsOf(w, p)).toEqual([{ phone: "+201130755305" }]);
    // what the model reads in the reply is masked, as for every call; the full values are in the saved answer
    expect(p.first_rows[0].phone).not.toBe("+201130755305");
    expect(l.rows_in_page).toBeGreaterThan(5);
    expect(s.rows_in_page).toBe(1);
    expect(w.reused()).toHaveLength(3);
    expect(w.reused().every((c) => Number(c.cost_usd) === 0 && (c.params_digest as any).reused_from === "call_0001")).toBe(true);
    expect(p.note).toContain("no new charge");
    // the reuse is saved like any call: run_code reads its rows
    expect(JSON.parse((await w.store.getFile("msn_page0001", "raw/call_0002.json"))!)).toMatchObject({ parser: "phone-numbers", rows: [{ phone: "+201130755305" }], reused_from: "call_0001" });
    expect(w.budget.spentUsd()).toBeCloseTo(USD, 9);
  });

  it("a page first READ (scrape) answers every field after it at no charge", async () => {
    const w = world();
    await w.web.webScrape({ provider: "contextdev", url: "https://bobana-eg.com/pages/contact" });
    const e: any = await w.web.parsePage({ parser: "emails", url: "https://bobana-eg.com/pages/contact" });
    expect(w.requests()).toHaveLength(1);
    expect(await rowsOf(w, e)).toEqual([{ email: "info@bobana-eg.com" }, { email: "contact@bobana-eg.com" }]);
    expect(w.paid()).toHaveLength(1);
    expect(w.paid()[0].endpoint_id).toBe("contextdev.scrape");
  });

  it("two requests for one page at the same moment: one purchase", async () => {
    const w = world();
    const url = "https://yolo-cosmetics.com/language/en/contact-us/";
    const [a, b, c]: any[] = await Promise.all([w.web.parsePage({ parser: "emails", url }), w.web.parsePage({ parser: "phone-numbers", url }), w.web.webScrape({ provider: "contextdev", url })]);
    expect(w.requests()).toHaveLength(1);
    expect(a.ok && b.ok && c.ok).toBe(true);
    expect(b.rows_in_page).toBe(6);
    expect(w.paid()).toHaveLength(1);
  });

  it("A WORKER RESTART does not buy the page again: the cache file is read; and when the cache file was lost, the raw answer of the call that bought it", async () => {
    const store = createMemoryStore();
    const first = world({ store });
    await first.web.parsePage({ parser: "emails", url: "https://donnanatural.com/contact" });
    const again = world({ store });
    const p: any = await again.web.parsePage({ parser: "phone-numbers", url: "https://donnanatural.com/contact" });
    expect(await rowsOf(again, p)).toEqual([{ phone: "+201130755305" }]);
    expect(again.requests()).toHaveLength(0);
    // the cache file lost (a write that failed): the raw answer of call_0001 holds the page
    for (const k of [...store.files.keys()]) if (k.includes(`/${PAGES_DIR}/`)) store.files.delete(k);
    const third = world({ store });
    const l: any = await third.web.parsePage({ parser: "links", url: "https://donnanatural.com/contact" });
    expect(l.ok).toBe(true);
    expect(third.requests()).toHaveLength(0);
  });

  it("FAILED FETCHES ARE NOT FREE AND NOT ENDLESS: a call with no answer is counted in the mission's budget at its estimate (marked «charge_unknown»); a passing failure is tried once more; then the page is not bought again", async () => {
    const w = world({ failFor: (u) => (u.includes("avenscosmetics") ? "throw" : null) });
    const a: any = await w.web.parsePage({ parser: "emails", url: "https://avenscosmetics.com" });
    expect(a.failed).toBe(true);
    expect(w.store.calls[0].params_digest).toMatchObject({ charge_unknown: true });
    expect(w.budget.spentUsd()).toBeCloseTo(USD, 9);
    const b: any = await w.web.parsePage({ parser: "phone-numbers", url: "https://avenscosmetics.com" });
    expect(b.failed).toBe(true);
    const c: any = await w.web.parsePage({ parser: "links", url: "https://avenscosmetics.com" });
    expect(c.refused).toBe("page_failed_before");
    expect(w.requests()).toHaveLength(2);
    expect(w.budget.spentUsd()).toBeCloseTo(2 * USD, 9);
  });

  it("a page that does not exist is tried once only", async () => {
    const w = world({ failFor: (u) => (u.includes("hktrade") ? "WEBSITE_NOT_FOUND" : null) });
    await w.web.parsePage({ parser: "emails", url: "https://hktrade-eg.com" });
    const again: any = await w.web.webScrape({ provider: "contextdev", url: "https://hktrade-eg.com/" });
    expect(again.refused).toBe("page_failed_before");
    expect(w.requests()).toHaveLength(1);
  });

  it("a page with almost no text (drawn by scripts): the provider's own parser is asked once for that field, as before; never a third time", async () => {
    const store = createMemoryStore();
    const w = world({ store });
    const thin = "https://thin.example/contact";
    const fake = fakeContextDev({ scrape: () => ({ markdown: "Loading…", credits: 1 }), parse: () => ({ data: emailsOf(["hello@thin.example"]), credits: 1 }) });
    const web = createWebGateway({ store, missionId: "msn_page0001", jobId: "job_x", phase: "execution", budget: createJobCallBudget({ ceilingUsd: 1, spentUsd: 0 }), recorder: fakeRecorder({}).recorder, providerKey: async () => "k", fetchFn: fake.fetchFn as any, counter: { seq: 50 }, pageReuse: { countryHint: "EG" } });
    const first: any = await web.parsePage({ parser: "emails", url: thin });
    expect(first.rows_in_page).toBe(0);
    expect(first.note).toContain("almost no text");
    const second: any = await web.parsePage({ parser: "emails", url: thin });
    expect(JSON.parse((await store.getFile("msn_page0001", `raw/${second.call_id}.json`))!).rows).toEqual([{ email: "hello@thin.example" }]);
    const third: any = await web.parsePage({ parser: "emails", url: thin });
    expect(third.rows_in_page).toBe(0);
    expect(fake.requests.filter((r) => r.body?.formats?.parse)).toHaveLength(1);
    expect(fake.requests).toHaveLength(2);
    void w;
  });

  it("PLANNING is unchanged: every field is still its own parser call (the plan's price is measured from these calls)", async () => {
    const w = world({ phase: "planning" });
    await w.web.parsePage({ parser: "emails", url: "https://nanostetic.com" });
    await w.web.parsePage({ parser: "phone-numbers", url: "https://nanostetic.com" });
    expect(w.requests()).toHaveLength(2);
    expect(w.requests().every((r) => r.body.formats.parse === true)).toBe(true);
    expect(w.reused()).toHaveLength(0);
  });

  it("without page rules (the planning gateway, or DIGER_WEB_PAGE_REUSE=0) the gateway behaves exactly as before", async () => {
    process.env.DIGER_WEB_PAGE_REUSE = "0";
    const w = world();
    await w.web.parsePage({ parser: "emails", url: "https://nanostetic.com" });
    await w.web.parsePage({ parser: "phone-numbers", url: "https://nanostetic.com" });
    expect(w.requests()).toHaveLength(2);
    const none = world({ reuse: false });
    await none.web.parsePage({ parser: "emails", url: "https://nanostetic.com" });
    await none.web.parsePage({ parser: "emails", url: "https://nanostetic.com" });
    expect(none.requests()).toHaveLength(2);
  });

  it("other parsers (a social page, maps) are untouched: one provider parser call each", async () => {
    const w = world();
    const fake = fakeContextDev({ parse: () => ({ data: { posts: [] }, credits: 1 }) });
    const web = createWebGateway({ store: w.store, missionId: "msn_page0001", jobId: "job_x", phase: "execution", budget: createJobCallBudget({ ceilingUsd: 1, spentUsd: 0 }), recorder: fakeRecorder({}).recorder, providerKey: async () => "k", fetchFn: fake.fetchFn as any, counter: { seq: 80 }, pageReuse: { countryHint: "EG" } });
    await web.parsePage({ parser: "instagram-feed", url: "https://www.instagram.com/explore/tags/coffee/" });
    await web.parsePage({ parser: "instagram-feed", url: "https://www.instagram.com/explore/tags/coffee/" });
    expect(fake.requests.filter((r) => r.body?.formats?.parse)).toHaveLength(2);
  });
});

describe("round 60: no paid page for a company that is not saved (execution)", () => {
  it("no company saved yet: no page is bought", async () => {
    const w = world({ parents: new Set() });
    const r: any = await w.web.parsePage({ parser: "emails", url: "https://bobana-eg.com" });
    expect(r.refused).toBe("parent_not_saved");
    expect(w.requests()).toHaveLength(0);
    expect(Number(w.store.calls[0].cost_usd)).toBe(0);
  });

  it("first-cosmetics.com (not among the 9 saved companies) is refused; a saved company's pages are bought; a page linked from a saved company's page on another host is that company's", async () => {
    const sites = new Set(calls.delivered_company_sites);
    const w = world({ parents: sites });
    const refused: any = await w.web.parsePage({ parser: "emails", url: "https://first-cosmetics.com" });
    expect(refused.refused).toBe("parent_not_saved");
    expect((await w.web.parsePage({ parser: "emails", url: "https://go-natural.shop" }) as any).ok).toBe(true);
    // go-natural.shop now links its contact page on rootsegypt.shop
    const linked: any = await w.web.parsePage({ parser: "phone-numbers", url: "https://rootsegypt.shop/contact-us/" });
    expect(linked.refused).toBeUndefined();
    const elsewhere: any = await w.web.webScrape({ provider: "contextdev", url: "https://unrelated.example/contact" });
    expect(elsewhere.refused).toBe("parent_not_saved");
  });

  it("the saved sites come from the saved parent rows of a page-reading detail step only", () => {
    const plan = { stages: [
      { key: "companies", parent_key: null, deliver: true, endpoint_id: "tomba.companies.search.reveal" },
      { key: "contacts", parent_key: "companies", deliver: true, endpoint_id: "contextdev.parse.emails" },
    ] } as any;
    const items = { acceptedRows: (k: string) => (k === "companies" ? [{ website: "https://www.bobana-eg.com", linkedin_url: "https://linkedin.com/company/vision-cosmetics" }, { domain: "kaline.com" }] : []) };
    expect([...savedParentSites(plan, items)!].sort()).toEqual(["bobana-eg.com", "kaline.com"]);
    expect(savedParentSites(plan, { acceptedRows: () => [] })).toEqual(new Set());
    // saved companies that name no site: the rule cannot tell their pages apart, so it stops nothing
    expect(savedParentSites(plan, { acceptedRows: () => [{ name: "x" }] })).toBeNull();
    // no detail step reads pages: no rule
    expect(savedParentSites({ stages: [plan.stages[0], { ...plan.stages[1], endpoint_id: "tomba.email.finder" }] } as any, items)).toBeNull();
  });
});

// ------------------------------------------------------------------------------------------------ the replay of 13 Nov
describe("round 60: the execution of msn_088c replayed with the fix", () => {
  async function replay(fix: boolean) {
    const w = world({ reuse: fix, parents: fix ? new Set(calls.delivered_company_sites) : undefined, failFor: (u) => (/avenscosmetics|hktrade/.test(u) ? "TIMEOUT" : null) });
    const found = { emails: new Set<string>(), phones: new Set<string>() };
    for (const c of calls.calls.filter((x) => x.phase === "execution")) {
      const parser = c.endpoint_id.replace("contextdev.parse.", "");
      const r: any = c.endpoint_id === "contextdev.scrape" ? await w.web.webScrape({ provider: "contextdev", url: c.url }) : await w.web.parsePage({ parser, url: c.url });
      if (!r.ok) continue;
      const saved = JSON.parse((await w.store.getFile("msn_page0001", `raw/${r.call_id}.json`)) ?? "{}");
      const site = siteOf(c.url)!;
      if (!calls.delivered_company_sites.includes(site)) continue;
      for (const row of saved.rows ?? []) { if (row.email) found.emails.add(row.email); if (row.phone) found.phones.add(row.phone); }
    }
    const paid = w.store.calls.filter((x) => Number(x.cost_usd) > 0);
    return { w, paid, spend: Number(paid.reduce((n, x) => n + Number(x.cost_usd), 0).toFixed(6)), found, requests: w.requests().length };
  }

  it("today's behaviour (no fix) replays the 13 Nov count: 40 calls, the timeouts aside 37 paid; with the fix 11 pages are bought, once each", async () => {
    const before = await replay(false);
    const after = await replay(true);
    expect(before.requests).toBe(40);
    // a call that did not complete is no longer free here (the timeouts of avens and hktrade are 3 provider answers with no charge)
    expect(before.paid).toHaveLength(37);
    expect(before.spend).toBeCloseTo(37 * USD, 6);
    // with the fix: 6 home pages + 5 contact pages of saved companies; the 2 sites that time out are tried at most twice; first-cosmetics.com is never bought
    const pages = new Set(after.paid.map((x) => canonicalPageUrl((x.params_digest as any).url)));
    expect(after.paid).toHaveLength(11);
    expect(pages.size).toBe(11);
    expect(after.spend).toBeCloseTo(11 * USD, 6);
    expect([...pages].some((p) => p!.includes("first-cosmetics"))).toBe(false);
    expect(after.requests).toBe(11 + 3);
    expect(after.w.store.calls.filter((x) => x.refused_reason?.startsWith("parent_not_saved"))).toHaveLength(5);
    // repeated purchases of one page: 24 on 13 Nov (pinned in cost-audit-r59), none now; empty paid calls 16 -> 9 (a page whose FIRST-asked field was empty still gave its links or its other field)
    expect(after.paid.length - pages.size).toBe(0);
    expect(after.paid.filter((x) => x.status === "empty")).toHaveLength(9);
    expect(before.paid.filter((x) => x.status === "empty")).toHaveLength(16);
    expect(after.w.store.calls.filter((x) => x.endpoint_id === PAGE_REUSE_ENDPOINT)).toHaveLength(21);
    // the 40 calls of 13 Nov: 11 bought, 21 read from a bought page, 5 refused (first-cosmetics.com), 3 failed attempts (avens twice, hktrade once)
    expect(after.w.store.calls).toHaveLength(40);
  });

  it("the contact values of the saved companies are THE SAME with the fix: 3 e-mails and 9 phones, every delivered one among them", async () => {
    const before = await replay(false);
    const after = await replay(true);
    expect([...after.found.emails].sort()).toEqual([...before.found.emails].sort());
    expect([...after.found.phones].sort()).toEqual([...before.found.phones].sort());
    expect([...after.found.emails].sort()).toEqual(["contact@bobana-eg.com", "hello@donnanatural.com", "info@bobana-eg.com"]);
    expect(after.found.phones.size).toBe(9);
    for (const v of ["info@bobana-eg.com", "hello@donnanatural.com"]) expect(after.found.emails.has(v)).toBe(true);
    for (const v of ["+201003308322", "+201130755305"]) expect(after.found.phones.has(v)).toBe(true);
  });
});
