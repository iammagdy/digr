import { afterEach, describe, expect, it, vi } from "vitest";
import { loadTregCatalog, type TregCatalog } from "../src/lib/treg/catalog";
import { discoverCursor } from "../src/lib/agentMission/toolProfile";
import { rankByCoverage } from "../src/lib/agentMission/sourceRanking";
import { replay } from "./helpers/agentReplay";
import { ENDPOINT, PER_PAGE, page, planning } from "./helpers/engineXScenario";
import { tregResult } from "./helpers/agentFakeWorld";

/**
 * S1 item 1.8: PAGINATION COVERAGE. A cursor input the catalog's `pagination` list does not name (x.x.search-posts-recent: next_token; youtube video comments: pageToken) is discovered from `inputs[]` and VERIFIED on a real page (the shape reader finds a next-page
 * value in the page the measuring call returned). An endpoint with no cursor at all ranks below a pageable one when the request needs more than one page.
 */
afterEach(() => { vi.unstubAllGlobals(); });
const catalog = loadTregCatalog();

describe("discoverCursor", () => {
  it("the recent X search: next_token, verified by a page that carries one", () => {
    expect(discoverCursor(catalog.byId.get("x.x.search-posts-recent")!, { data: [{ id: "1", text: "a" }], meta: { next_token: "b26v89c19zqg8o3fpz" } })).toBe("next_token");
  });
  it("YouTube comments: pageToken, verified by nextPageToken", () => {
    expect(discoverCursor(catalog.byId.get("youtube.youtube.video.comments")!, { items: [{ id: "c1", snippet: {} }], nextPageToken: "CDIQAA" })).toBe("pageToken");
  });
  it("a page that carries no next-page value does not claim paging", () => {
    expect(discoverCursor(catalog.byId.get("x.x.search-posts-recent")!, { data: [{ id: "1", text: "a" }], meta: { result_count: 1 } })).toBeNull();
  });
  it("an endpoint whose pagination already names its cursor keeps that name", () => {
    expect(discoverCursor(catalog.byId.get("anyapi.x.search.posts")!, { output: { data: { items: [{ id: "1" }], nextCursor: "c2" } } })).toBe("cursor");
  });
  it("an endpoint with no cursor input at all gives null", () => {
    const e = { ...catalog.byId.get("youtube.youtube.video.comments")!, inputs: catalog.byId.get("youtube.youtube.video.comments")!.inputs.filter((i) => i.name !== "pageToken") };
    expect(discoverCursor(e, { items: [{ id: "c1" }], nextPageToken: "CDIQAA" })).toBeNull();
  });
});

describe("an endpoint with no cursor ranks below a pageable one when more than one page is needed", () => {
  const pageable = catalog.byId.get("anyapi.x.search.posts")!;
  const oneShot = { ...pageable, id: "z.oneshot.search", inputs: pageable.inputs.filter((i) => i.name !== "cursor"), pagination: [] };
  const cat = { ...catalog, byId: new Map([...catalog.byId, [oneShot.id, oneShot]]) } as unknown as TregCatalog;
  it("for 300 rows the pageable comes first; for 5 rows price decides", () => {
    const many = rankByCoverage([oneShot, pageable], cat, new Map(), Date.now(), [], { rows: 300 });
    expect(many.ranked[0].id).toBe("anyapi.x.search.posts");
    const cheapOneShot = { ...oneShot, cost: { ...oneShot.cost!, usd: 0.00001 } };
    const cat2 = { ...catalog, byId: new Map([...catalog.byId, [cheapOneShot.id, cheapOneShot]]) } as unknown as TregCatalog;
    expect(rankByCoverage([cheapOneShot, pageable], cat2, new Map(), Date.now(), [], { rows: 300 }).ranked[0].id).toBe("anyapi.x.search.posts");
    expect(rankByCoverage([cheapOneShot, pageable], cat2, new Map(), Date.now(), [], { rows: 5 }).ranked[0].id).toBe("z.oneshot.search");
  });
});

describe("a replay of three pages on an endpoint whose pagination list is empty", () => {
  /** The same catalog with the cursor removed from the endpoint's `pagination` list (the input stays, as in x.x.search-posts-recent). */
  const unlisted = (): TregCatalog => {
    const e = { ...catalog.byId.get(ENDPOINT)!, pagination: [] as string[] };
    return { ...catalog, endpoints: catalog.endpoints.map((x) => (x.id === ENDPOINT ? e : x)), byId: new Map([...catalog.byId, [ENDPOINT, e]]) } as unknown as TregCatalog;
  };
  const answers = () => [page(0, "cur_20"), page(PER_PAGE, "cur_40"), page(2 * PER_PAGE, "cur_60"), page(3 * PER_PAGE, null)].map((p) => tregResult(p, 0.00075));
  const run = (flags: unknown) => replay({ request: "هات ٤٠ تغريدة عن محمد صلاح", planning: planning(), execution: () => [], answers: [answers()[0], ...answers()], deps: (d) => { d.store.settings.redesign_flags = flags; return { ...d, catalog: unlisted() }; } });
  it("flag on: the cursor input is discovered, three pages are read and 40 are delivered", async () => {
    const r = await run({ social_posts: "on" });
    expect(r.plannedPlan.stages[0].engine!.cursor_param).toBe("cursor");
    expect(r.mission.delivered_units).toBe(40);
    const cursors = r.call.mock.calls.map((c) => (c[0] as { params: Record<string, unknown> }).params.cursor).filter((x) => x !== undefined);
    expect(cursors).toEqual(["cur_20", "cur_40", "cur_60"].slice(0, cursors.length));
    expect(cursors.length).toBeGreaterThanOrEqual(2);
  });
  it("flags off: the old path is unchanged (no cursor input known, one page read)", async () => {
    const r = await run({});
    expect(r.plannedPlan.stages[0].engine!.cursor_param).toBeNull();
    expect(Number(r.mission.delivered_units)).toBeLessThan(40);
  });
});
