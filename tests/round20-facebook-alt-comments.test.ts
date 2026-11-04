import { readFileSync } from "node:fs";
import ExcelJS from "exceljs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { COMMENT_ID_PROOFS, idsProvenEqual } from "../src/lib/agentMission/foundation/alternatives";
import { violationTextAr } from "../src/lib/agentMission/foundation/deliveryContract";
import { cardOf, mapPage } from "../src/lib/agentMission/foundation/toolCards";
import { checkCardOnPage } from "../src/lib/agentMission/foundation/toolCards/verify";
import { restRefuses } from "./helpers/fakeRestClient";
import { replayMission, type MissionReplay } from "./helpers/missionReplay";
import { runProductionPlanning, type ProductionPlanning } from "./helpers/productionPlanning";
import { inputKey } from "./helpers/replayGateway";
import { FB20_REPLAY, FB20_REQUEST, restoreFb20PageName } from "./helpers/round14Missions";

/**
 * ROUND 20, ITEM 1: THE ALTERNATIVE COMMENTS CARD OF FACEBOOK (`anyapi.facebook.post_comments`) ON ITS FIRST REAL PAGES.
 * Mission msn_934781c56a01a96825af (the Facebook smoke of 4 Nov 2026, test account): two posts, each read by the main card (`scrapecreators.x.v1-facebook-post-comments`, calls 5 to 7 and 9) and then by the alternative (calls 8 and 10, the first it ever answered with rows).
 * The pages are the owner's admin ZIP, anonymised with tests/fixtures/live/anonymise.py (the privacy scan passes on them: tests/fixtures-anonymised.test.ts). What the card needs to be `verified` for EVERY account (owner's rule): its pages map AND its comment ids are proven equal to the main card's on the SAME posts.
 */
const M = "msn_934781c56a01a96825af";
const MAIN = "scrapecreators.x.v1-facebook-post-comments";
const ALT = "anyapi.facebook.post_comments";
type IndexRow = [string, string, string, string, number, Record<string, unknown>];
const INDEX = JSON.parse(readFileSync(new URL("./fixtures/live/call-index.json", import.meta.url), "utf8")) as { missions: Record<string, IndexRow[]> };
const call = (id: string): IndexRow => INDEX.missions[M].find((c) => c[0] === id)!;
const page = (id: string): Record<string, unknown> => JSON.parse(readFileSync(new URL(`./fixtures/live/missions/${M}/raw/${id}.json`, import.meta.url), "utf8"));
const main = cardOf(MAIN)!;
const alt = cardOf(ALT)!;
/** The two posts: [main call, alternative call] on the same post link. */
const PAIRS: Array<[string, string]> = [["call_0007", "call_0008"], ["call_0009", "call_0010"]];
const decodeId = (id: string): string => Buffer.from(id, "base64").toString("utf8");

describe("what the first real pages of the alternative card show (ZIP of msn_934781c56a01a96825af, anonymised)", () => {
  it("the mission is stored: 10 calls, the two cards on the same two posts, the third page listing refused", () => {
    expect(INDEX.missions[M]).toHaveLength(10);
    expect(INDEX.missions[M].map((c) => c[2]).filter((e) => e === ALT)).toHaveLength(2);
    expect(call("call_0004")[3]).toBe("refused");
  });

  for (const [a, b] of PAIRS) {
    describe(`${a} (main) and ${b} (alternative)`, () => {
      it("both calls name the SAME post (same link in the index) and both answered ok with 4 comments", () => {
        expect(call(a)[2]).toBe(MAIN);
        expect(call(b)[2]).toBe(ALT);
        expect(inputKey(MAIN, call(a)[5])).toBe(inputKey(MAIN, call(b)[5]).replace(ALT, MAIN));
        expect([call(a)[3], call(b)[3]]).toEqual(["ok", "ok"]);
        expect([call(a)[4], call(b)[4]]).toEqual([4, 4]);
      });
      it("the alternative's pages map with its card: the list at the card's path, one row per listed comment, an id and the reply counter on each, the next-page field where the card says", () => {
        const check = checkCardOnPage(alt, page(b));
        expect(check.issues).toEqual([]);
        expect(check.listed).toBe(4);
        expect(check.rows).toHaveLength(4);
        for (const r of check.rows) expect(typeof r.replies_count).toBe("number");
      });
      it("THE IDS ARE EQUAL: the same four comments, in the same order, with the same id (the id decodes to «comment:<post>_<comment>»: the post is inside it), and the same text, author, instant, likes and replies", () => {
        const rowsMain = mapPage(main, page(a));
        const rowsAlt = mapPage(alt, page(b));
        expect(rowsAlt.map((r) => r.id)).toEqual(rowsMain.map((r) => r.id));
        expect(new Set(rowsAlt.map((r) => r.id)).size).toBe(4);
        const posts = new Set(rowsAlt.map((r) => /^comment:(\d+)_\d+$/.exec(decodeId(String(r.id)))?.[1]));
        expect(posts.size).toBe(1);
        for (let i = 0; i < rowsMain.length; i += 1) {
          const [x, y] = [rowsMain[i], rowsAlt[i]];
          expect([y.text, y.author, y.posted_at, y.likes, y.replies_count]).toEqual([x.text, x.author, x.posted_at, x.likes, x.replies_count]);
        }
      });
      it("the end of the list: `hasNextPage` false on the alternative (and `has_next_page` false on the main card), although BOTH keep a non-empty next cursor on a last page: a cursor alone never says there is more", () => {
        const o = (page(b).output as { data: { hasNextPage: boolean; nextCursor: string } }).data;
        expect(o.hasNextPage).toBe(false);
        expect(o.nextCursor).toMatch(/^cur_/);
        expect((page(a) as { has_next_page: boolean; cursor: string }).has_next_page).toBe(false);
        expect(String((page(a) as { cursor: string }).cursor).length).toBeGreaterThan(0);
      });
      it("the alternative billed one call each: 0.0012 USD for 4 rows (the page file's own cost), against the catalog's 0.002 the card prices by; the main card's call is 1 credit (0.00188 USD)", () => {
        expect(page(b)).toMatchObject({ provider: "AnyAPI", costUsd: 0.0012, items: 4 });
        expect(page(a)).toMatchObject({ credits_charged: 1 });
      });
    });
  }

  it("the two posts hold 8 comments between them and 8 DIFFERENT ids (the alternative's second post is not the first post's page)", () => {
    const ids = PAIRS.flatMap(([, b]) => mapPage(alt, page(b)).map((r) => String(r.id)));
    expect(ids).toHaveLength(8);
    expect(new Set(ids).size).toBe(8);
  });
});

describe("the card is VERIFIED, with this mission as its evidence, and its ids are PROVEN equal to the main card's", () => {
  it("status verified; the calls it lists are the two alternative calls, and they are the alternative's own", () => {
    expect(alt.status).toBe("verified");
    expect(alt.verifiedOn).toEqual([{ mission: M, calls: ["call_0008", "call_0010"] }]);
    for (const v of alt.verifiedOn) for (const c of v.calls) expect(call(c)[2]).toBe(ALT);
  });
  it("COMMENT_ID_PROOFS holds the pair (this mission, both posts), recomputed above on the stored pages; the order of the pair does not matter", () => {
    const p = COMMENT_ID_PROOFS.find((x) => [x.a, x.b].sort().join() === [MAIN, ALT].sort().join());
    expect(p).toBeTruthy();
    expect(p!.mission).toEqual({ a: M, b: M });
    expect(idsProvenEqual(MAIN, ALT)).toBe(true);
    expect(idsProvenEqual(ALT, MAIN)).toBe(true);
  });
  it("the price the card plans by is still the catalog's 0.002 (the main card, 0.00188, stays the cheaper page, so it stays the main card of a customer's stage)", () => {
    expect(alt.costUsdPerPage).toBe(0.002);
    expect(main.costUsdPerPage).toBeLessThan(alt.costUsdPerPage);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// THE REPLAY: the production planning of the smoke's request, then the engine on the stored execution pages, then the workbook and the delivery contract, for a customer's account and a test account.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
const REQUEST = FB20_REQUEST;
const CREATED = "2026-11-04T07:10:14Z";
const PLANNING_AT = "2026-11-04T07:10:24Z";
const READ_AT = "2026-11-04T07:11:49Z";
const LISTING_BY_CURSOR = { ...FB20_REPLAY };
const restorePageName = restoreFb20PageName;

describe.each([{ label: "a customer's account", test: false }, { label: "a test account", test: true }])("the smoke's request replayed end to end, $label", ({ test }) => {
  let planned: ProductionPlanning;
  let replay: MissionReplay;
  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(PLANNING_AT));
    planned = await runProductionPlanning({ fixture: M, request: REQUEST, createdAt: CREATED, platform: "facebook", testAccount: test, transformPlanningPage: restorePageName, replay: LISTING_BY_CURSOR });
    vi.setSystemTime(new Date(READ_AT));
    if (planned.plan) replay = await replayMission({ fixture: M, request: REQUEST, createdAt: CREATED, planningAt: PLANNING_AT, readAt: READ_AT, platform: "facebook", catalogOnly: test, replay: LISTING_BY_CURSOR, savedPlan: planned.plan });
  }, 300_000);
  afterAll(() => { vi.useRealTimers(); });

  it("the production planning run ends plan_ready on the compiled path, the plan saved (no write refused); every planning read is answered by a stored page except the refused third listing page", () => {
    expect(planned.error).toBeNull();
    expect(planned.status).toBe("plan_ready");
    expect(planned.plan?.compiled?.by).toBe("compiler");
    expect(planned.plan?.compiled?.platform).toBe("facebook");
    expect(restRefuses(planned.savedBody ?? "")).toBe(false);
    for (const u of planned.providerCalls.filter((x) => !x.served)) expect(u.endpointId, "unserved in planning").toBe("anyapi.facebook.user.posts");
  });

  it("the comments stage keeps the alternative as an ordinary, PROVEN route (never a capture: no page cap of decision 7.4) and the promise is the counters: 9 + 6 comments, 2 + 15 = 17", () => {
    const stage = planned.plan!.stages.find((s) => s.key === "comments")!;
    expect(stage.endpoint_id).toBe(MAIN);
    expect(stage.engine!.alternatives!.map((a) => a.endpoint_id)).toEqual([ALT]);
    expect(stage.max_pages ?? null).toBeNull();
    expect(planned.plan!.stages.reduce((n, s) => n + (s.expected_rows ?? 0), 0)).toBe(17);
  });

  it("the engine read the main card then the alternative on each post (4 calls served, none refused) and the alternative's four comments were the main card's four: 8 unique comments delivered, no id twice", () => {
    expect(replay.unservedExecution, "an execution call no stored page answers").toBe(0);
    const comments = replay.rowsByStage.comments;
    expect(comments).toHaveLength(8);
    expect(new Set(comments.map((r) => String(r.id))).size).toBe(8);
  });

  it("the delivery contract: ZERO violations, nothing completed behind its back, and one limit line per post that says the counter, the delivered count, the gap and the routes tried", () => {
    expect(replay.built.contract.error).toBeUndefined();
    expect(replay.built.contract.violations.map(violationTextAr)).toEqual([]);
    expect(replay.built.contract.completed).toEqual([]);
  });

  it("the delivered file says it once per post: the counter, the delivered count, the gap and BOTH routes tried, in one sentence (the unique lines of the limits)", async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(replay.built.xlsx as unknown as ArrayBuffer);
    const lines = new Set<string>();
    wb.eachSheet((ws) => ws.eachRow((row) => { for (const v of row.values as unknown[]) if (typeof v === "string") for (const l of v.split("\n")) if (/^المنشور رقم [١٢]: المتوقع .*الفرق/.test(l)) lines.add(l); }));
    expect([...lines].sort()).toEqual([
      "المنشور رقم ١: المتوقع ٩ تعليقًا، وسُلّم ٤ تعليقًا فريدًا، والفرق ٥؛ جرّبنا المسار الرئيسي ومسارًا بديلًا واحدًا للمنصة نفسها، ولم يعطِ أيٌّ منها الباقي.",
      "المنشور رقم ٢: المتوقع ٦ تعليقًا، وسُلّم ٤ تعليقًا فريدًا، والفرق ٢؛ جرّبنا المسار الرئيسي ومسارًا بديلًا واحدًا للمنصة نفسها، ولم يعطِ أيٌّ منها الباقي.",
    ]);
  });
});
