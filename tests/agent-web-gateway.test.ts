import { describe, expect, it, vi } from "vitest";
import { createJobCallBudget } from "../src/lib/server/callBudget";
import { createMemoryStore, newMission } from "../agent/src/memoryStore";
import { createWebGateway } from "../agent/src/webGateway";
import { fakeRecorder, USER_ID } from "./helpers/agentHarness";
import { emailsOf, fakeContextDev, igFeed, mapsReviews, phonesOf } from "./helpers/fakeContextDev";

vi.stubGlobal("fetch", () => { throw new Error("a real network call was attempted"); });
const USD_PER_CREDIT = 0.00254;

function setup(options: { budget?: number; key?: string | null; fake?: Parameters<typeof fakeContextDev>[0]; dailyCap?: number; phase?: "planning" | "execution" } = {}) {
  const store = createMemoryStore();
  const mission = newMission({ id: "msn_web00001", user_id: USER_ID, status: "planning" });
  store.missions.set(mission.id, mission);
  const rec = fakeRecorder({ dailyCapUsd: options.dailyCap });
  const world = fakeContextDev(options.fake);
  const budget = createJobCallBudget({ ceilingUsd: options.budget ?? 0.1, spentUsd: 0 });
  const web = createWebGateway({ store, missionId: mission.id, jobId: options.phase === "execution" ? "job_x" : null, phase: options.phase ?? "planning", budget, recorder: rec.recorder, providerKey: async () => (options.key === undefined ? "ctx-key-for-test" : options.key), fetchFn: world.fetchFn as any, counter: { seq: 0 } });
  return { store, mission, rec, world, budget, web };
}

describe("parse_page: ONE parser, ONE URL, the same rules as treg_call", () => {
  it("sends the documented request, records the charge the answer REPORTS, saves the raw answer and returns a digest and the first rows", async () => {
    const t = setup({ fake: { parse: () => ({ data: igFeed("قهوة", 12), credits: 1 }) } });
    const r = await t.web.parsePage({ parser: "instagram-feed", url: "https://www.instagram.com/explore/tags/%D9%82%D9%87%D9%88%D8%A9/" });
    expect(r).toMatchObject({ ok: true, call_id: "call_0001", source: "contextdev.parse.instagram-feed", rows_in_page: 12, cost_basis: "reported" });
    // the documented request: POST /v1/web/scrape { url, formats: { parse: true }, parseParams: { type: "prebuilt", parser } }
    expect(t.world.requests[0].url).toBe("https://api.context.dev/v1/web/scrape");
    expect(t.world.requests[0].body).toMatchObject({ formats: { parse: true }, parseParams: { type: "prebuilt", parser: "instagram-feed" } });
    expect(t.world.requests[0].body.parseParams.rules).toBeUndefined();
    expect(t.world.requests[0].headers.Authorization).toBe("Bearer ctx-key-for-test");
    // the actual charge is committed into provider_costs (through the approved functions) against the provider's own cap
    expect(t.rec.rows).toHaveLength(1);
    expect(t.rec.rows[0]).toMatchObject({ provider: "contextdev", capabilityId: "contextdev.parse", status: "success", units: 12 });
    expect(t.rec.rows[0].committedUsd).toBeCloseTo(USD_PER_CREDIT, 9);
    // the call row and the raw answer
    expect(t.store.calls[0]).toMatchObject({ id: "msn_web00001:call_0001", endpoint_id: "contextdev.parse.instagram-feed", status: "ok", rows_returned: 12 });
    expect(Number(t.store.calls[0].cost_usd)).toBeCloseTo(USD_PER_CREDIT, 9);
    expect(t.store.calls[0].params_digest).toMatchObject({ cost_basis: "reported" });
    const saved = JSON.parse((await t.store.getFile("msn_web00001", "raw/call_0001.json"))!);
    expect(saved.rows).toHaveLength(12);
    expect(saved.rows[0].caption).toBe("قهوة صورة 0");
    // the model gets a digest and the first rows only, never the page
    expect((r as any).first_rows).toHaveLength(5);
    expect(JSON.stringify((r as any).shape)).toContain("caption");
    expect(t.budget.spentUsd()).toBeCloseTo(USD_PER_CREDIT, 9);
    expect(t.store.missions.get("msn_web00001")!.planning_treg_usd).toBeCloseTo(USD_PER_CREDIT, 6);
  });

  it("an answer that reports no charge is recorded at the documented base credit and marked ESTIMATED", async () => {
    const t = setup({ fake: { parse: () => ({ data: igFeed("قهوة", 3) }) } });
    const r: any = await t.web.parsePage({ parser: "instagram-feed", url: "https://www.instagram.com/explore/tags/coffee/" });
    expect(r.cost_basis).toBe("estimated");
    expect(r.note).toContain("estimate");
    expect(t.rec.rows[0].committedUsd).toBeCloseTo(1 * USD_PER_CREDIT, 9);
    expect(t.store.calls[0].params_digest).toMatchObject({ cost_basis: "estimated" });
  });

  it("a failed parse has no rows and costs nothing; a target that answered 404 keeps the base credit (documented)", async () => {
    const blocked = setup({ fake: { parse: () => ({ fail: { error_code: "WEBSITE_BLOCKED" } }) } });
    const a: any = await blocked.web.parsePage({ parser: "tiktok-feed", url: "https://www.tiktok.com/tag/food" });
    expect(a).toMatchObject({ ok: false, failed: true });
    expect(a.message).toContain("WEBSITE_BLOCKED");
    expect(blocked.rec.rows[0].committedUsd).toBe(0);
    expect(blocked.store.calls[0]).toMatchObject({ status: "failed", rows_returned: 0 });
    const missing = setup({ fake: { parse: () => ({ fail: { error_code: "NOT_FOUND" } }) } });
    const b: any = await missing.web.parsePage({ parser: "tiktok-video", url: "https://www.tiktok.com/@nasa/video/123456" });
    expect(b.message).toContain("does not exist");
    expect(missing.rec.rows[0].committedUsd).toBeCloseTo(USD_PER_CREDIT, 9);
  });

  it("an empty list is an empty call (charged, no rows)", async () => {
    const t = setup({ fake: { parse: () => ({ data: { posts: [] }, credits: 1 }) } });
    const r: any = await t.web.parsePage({ parser: "instagram-feed", url: "https://www.instagram.com/explore/tags/nothing/" });
    expect(r).toMatchObject({ ok: true, rows_in_page: 0 });
    expect(t.store.calls[0].status).toBe("empty");
  });

  it("google-maps-reviews takes sort and limit; the other parsers refuse them; a bad value is refused", async () => {
    const t = setup({ fake: { parse: () => ({ data: mapsReviews(5), credits: 1 }) } });
    await t.web.parsePage({ parser: "google-maps-reviews", url: "https://www.google.com/maps/place/?q=place_id:ChIJplace0001", sort: "oldest", limit: 50 });
    expect(t.world.requests[0].body.parseParams).toEqual({ type: "prebuilt", parser: "google-maps-reviews", sort: "oldest", limit: 50 });
    expect(await t.web.parsePage({ parser: "google-maps-reviews", url: "https://www.google.com/maps/place/?q=place_id:X", sort: "best" })).toMatchObject({ refused: "bad_input" });
    expect(await t.web.parsePage({ parser: "google-maps-reviews", url: "https://www.google.com/maps/place/?q=place_id:X", limit: 5000 })).toMatchObject({ refused: "bad_input" });
    await t.web.parsePage({ parser: "instagram-feed", url: "https://www.instagram.com/explore/tags/coffee/", sort: "oldest", limit: 5 });
    expect(t.world.requests[t.world.requests.length - 1].body.parseParams).toEqual({ type: "prebuilt", parser: "instagram-feed" });
  });

  it("refuses, BEFORE any call and at no cost: an unknown parser, a URL of the wrong shape, a login page, a private host, no key", async () => {
    const t = setup();
    expect(await t.web.parsePage({ parser: "x-posts", url: "https://x.com/a/status/1" })).toMatchObject({ refused: "bad_source" });
    expect(await t.web.parsePage({ parser: "instagram-feed", url: "https://www.instagram.com/natgeo/" })).toMatchObject({ refused: "bad_url" });
    expect(await t.web.parsePage({ parser: "emails", url: "https://acme.com/login" })).toMatchObject({ refused: "bad_url" });
    expect(await t.web.parsePage({ parser: "emails", url: "https://www.instagram.com/accounts/login/" })).toMatchObject({ refused: "bad_url" });
    expect(await t.web.parsePage({ parser: "links", url: "http://10.0.0.5/admin" })).toMatchObject({ refused: "bad_url" });
    expect(await t.web.parsePage({ parser: "links", url: "javascript:alert(1)" })).toMatchObject({ refused: "bad_url" });
    expect(t.world.fetchFn).not.toHaveBeenCalled();
    expect(t.rec.rows).toHaveLength(0);
    expect(t.store.calls.every((c) => c.status === "refused")).toBe(true);
    const nokey = setup({ key: null });
    expect(await nokey.web.parsePage({ parser: "emails", url: "https://acme.example/contact" })).toMatchObject({ refused: "source_unavailable" });
    expect(nokey.world.fetchFn).not.toHaveBeenCalled();
  });

  it("the mission budget is asked BEFORE the call: a call that would pass it is not made; the provider's daily cap is asked too", async () => {
    const t = setup({ budget: 0.003, fake: { parse: () => ({ data: emailsOf(["a@acme.example"]), credits: 1 }) } });
    expect(await t.web.parsePage({ parser: "emails", url: "https://acme.example/contact" })).toMatchObject({ ok: true });
    expect(await t.web.parsePage({ parser: "emails", url: "https://acme.example/about" })).toMatchObject({ refused: "over_budget" });
    expect(t.world.fetchFn).toHaveBeenCalledTimes(1);
    const capped = setup({ dailyCap: 0.0001, fake: { parse: () => ({ data: emailsOf([]), credits: 1 }) } });
    expect(await capped.web.parsePage({ parser: "emails", url: "https://acme.example/contact" })).toMatchObject({ refused: "daily_cap" });
    expect(capped.world.fetchFn).not.toHaveBeenCalled();
  });

  it("a read of a public SOCIAL page is allowed (read only)", async () => {
    const t = setup({ fake: { parse: () => ({ data: phonesOf(["+20227945000"]), credits: 1 }) } });
    expect(await t.web.parsePage({ parser: "phone-numbers", url: "https://www.facebook.com/somepage/about" })).toMatchObject({ ok: true, rows_in_page: 1 });
  });

  it("execution calls are recorded against the JOB", async () => {
    const t = setup({ phase: "execution", fake: { parse: () => ({ data: emailsOf(["a@acme.example"]), credits: 1 }) } });
    await t.web.parsePage({ parser: "emails", url: "https://acme.example/contact" });
    expect(t.rec.rows[0].jobId).toBe("job_x");
    expect(t.store.missions.get("msn_web00001")!.execution_treg_usd).toBeGreaterThan(0);
  });
});

describe("web search, page scrape and people search through the same gateway", () => {
  it("web search through Context.dev: the hits are rows, the charge is recorded", async () => {
    const t = setup({ fake: { search: () => [{ url: "https://acme.example", title: "Acme", description: "شركة" }] } });
    const r: any = await t.web.webSearch({ provider: "contextdev", query: "شركات كهروميكانيكا في مصر", limit: 10 });
    expect(r).toMatchObject({ ok: true, source: "contextdev.search", rows_in_page: 1 });
    expect(t.rec.rows[0]).toMatchObject({ provider: "contextdev", capabilityId: "contextdev.search" });
    expect(await t.web.webSearch({ provider: "contextdev", query: "x" })).toMatchObject({ refused: "bad_input" });
  });

  it("page scrape: the text and links are saved for run_code, the model gets the start of the page", async () => {
    const t = setup({ fake: { scrape: () => ({ markdown: "# اتصل بنا\n[فريقنا](https://acme.example/team)\nهاتف: +20227945000" }) } });
    const r: any = await t.web.webScrape({ provider: "contextdev", url: "https://acme.example/contact" });
    expect(r).toMatchObject({ ok: true, source: "contextdev.scrape" });
    const saved = JSON.parse((await t.store.getFile("msn_web00001", "raw/call_0001.json"))!);
    expect(saved.markdown).toContain("اتصل بنا");
    expect(saved.links).toContain("https://acme.example/team");
    expect(await t.web.webScrape({ provider: "firecrawl", url: "https://acme.example/login" })).toMatchObject({ refused: "bad_url" });
  });

  it("people search: 10 per page at the documented price, a cursor to page, NO e-mail and NO phone", async () => {
    const t = setup({ fake: { people: () => ({ results: [{ name: "Alex Morgan", role: { title: "VP of Sales", company: { name: "Solstice", domain: "solstice.example" } }, profiles: ["https://alexmorgan.example"] }], next_cursor: "c2", credits: 10 }) } });
    const r: any = await t.web.peopleSearch({ query: "VPs of sales at solar companies in California", country: "us" });
    expect(r).toMatchObject({ ok: true, source: "contextdev.people.search", rows_in_page: 1, next_cursor: "c2", cost_basis: "reported" });
    expect(r.note).toContain("no e-mail and no phone");
    expect(t.world.requests[0].body).toMatchObject({ query: "VPs of sales at solar companies in California", mode: "fast", filters: { countries: ["US"] } });
    expect(t.rec.rows[0].committedUsd).toBeCloseTo(10 * USD_PER_CREDIT, 9);
    expect(JSON.stringify(r.first_rows)).not.toMatch(/@/);
    await t.web.peopleSearch({ query: "VPs of sales at solar companies in California", cursor: "c2" });
    expect(t.world.requests[1].body.cursor).toBe("c2");
    // a page with no match is free (documented)
    const empty = setup({ fake: { people: () => ({ results: [] }) } });
    await empty.web.peopleSearch({ query: "nobody at all here" });
    expect(empty.rec.rows[0].committedUsd).toBe(0);
  });
});
