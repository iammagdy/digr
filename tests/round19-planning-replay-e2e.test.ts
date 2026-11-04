import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { OCCURRENCE_OPTIONS_AR } from "../src/lib/agentMission/foundation/occurrence";
import { NAMED_SHORTFALL_OPTIONS_AR } from "../src/lib/agentMission/foundation/namedShortfall";
import { NO_ABOUT_OPTIONS_AR } from "../src/lib/agentMission/foundation/topicChoice";
import { violationTextAr } from "../src/lib/agentMission/foundation/deliveryContract";
import { restRefuses } from "./helpers/fakeRestClient";
import { replayMission, type MissionReplay, type MissionReplayInput } from "./helpers/missionReplay";
import { runProductionPlanning, type ProductionPlanning, type ProductionPlanningInput } from "./helpers/productionPlanning";
import { FB, M12, MISSIONS, YT1 } from "./helpers/round14Missions";

/**
 * ROUND 19, ITEM 2: THE PERMANENT END-TO-END PLANNING REPLAY, one per platform (TikTok, X, Instagram, Facebook, YouTube), FROM THE STORED LIVE PAGES, with the TEST SEAM OFF.
 * Why it exists: on 4 Nov 2026 every TikTok request failed while every test was green. The tests that drove a mission through planning either ran the compiler alone (`planByCompiler`: no store write) or ran the run with the in-memory store (which accepts any body), on anonymised pages (every text a placeholder, so no
 * half-emoji ever reached a write), with the test seam on. Here the chain is the production one: `runPlanning` (the social gate, understand, Ask, the count questions, the pool and exposure reads through the REAL gateway and its caps, compile, price, the plan WRITTEN through the real store writer into a REST
 * stand-in that refuses what the real one refuses) -> the plan as SAVED -> the engine reading the stored execution pages -> the real workbook -> the delivery contract: ZERO violations. Each platform runs twice: on the pages as stored, and on the same pages with half an emoji at the end of every anonymised text (what a real caption or comment can carry).
 */
const IG = "msn_e3e7632e2fb2d42f9c19";
const X14 = "msn_b060d3347ed7660f972e";
const IG_REQUEST = "هات منشورين من حساب الحدث على إنستجرام (alhadath)، مع كل التعليقات والردود.";
const X_REQUEST = "هات ١٠ تغريدات على X فيها «العاصمة الإدارية» بالعربي في شهر أكتوبر ٢٠٢٦";
const TT_REQUEST = "هات فيديوهين تيك توك بالعربي عن الذكاء الاصطناعي من مصر، أكتر فيديوهات عليها تعليقات، و٢٠ تعليق من كل فيديو مع ردودهم";
// X: the stored search page is the page of the model's old query; the compiled query (Cairo October as UTC instants) has no stored page, so the one stored page of the same tool answers it (written here, as the replay options say)
const X_BORROW = [{ endpointId: "anyapi.x.search.posts", fromMission: X14, call: "call_0003", when: () => true }];

interface Case { platform: string; label: string; plan: ProductionPlanningInput; replay: MissionReplayInput; /** the engine calls that no stored page answers and the reason (nothing else may be unserved in execution) */ unservedOk?: (endpointId: string) => boolean }
const CASES: Case[] = [
  { platform: "tiktok", label: "TikTok M12", plan: { fixture: M12, request: TT_REQUEST, answer: NO_ABOUT_OPTIONS_AR.useAsIs, createdAt: "2026-11-02T11:35:00Z", platform: "tiktok" },
    replay: { fixture: M12, request: TT_REQUEST, answer: NO_ABOUT_OPTIONS_AR.useAsIs, createdAt: "2026-11-02T11:35:00Z", planningAt: "2026-11-02T11:36:00Z", readAt: "2026-11-02T11:40:00Z", platform: "tiktok" } },
  { platform: "x", label: "X M14 (the smoke's request: tweets, October 2026)", plan: { fixture: X14, request: X_REQUEST, createdAt: "2026-11-04T07:01:00Z", platform: "x", replay: { borrow: X_BORROW } },
    replay: { fixture: X14, request: X_REQUEST, createdAt: "2026-11-04T07:01:00Z", planningAt: "2026-11-04T07:01:30Z", readAt: "2026-11-04T07:02:00Z", platform: "x", replay: { borrow: X_BORROW } } },
  { platform: "instagram", label: "Instagram M16", plan: { fixture: IG, request: IG_REQUEST, createdAt: "2026-11-02T17:31:00Z", platform: "instagram" },
    replay: { fixture: IG, request: IG_REQUEST, createdAt: "2026-11-02T17:31:00Z", planningAt: "2026-11-02T17:32:00Z", readAt: "2026-11-02T17:40:00Z", platform: "instagram" },
    // the planned alternative route of the comments (round 16) has no stored page for this account's posts: the live run never called it
    unservedOk: (id) => id === "scrapecreators.instagram.post.comments" },
  // Facebook and YouTube are the stored missions of round 14 with their own, stated adjustments (the anonymiser replaced the words a live ranking read; the live videos were pinned): the same inputs `tests/round14-contract-replay.test.ts` replays
  fromRound14("facebook", FB, { testAccount: true }),
  fromRound14("youtube", YT1, { answer: OCCURRENCE_OPTIONS_AR.latest }),
];

function fromRound14(platform: string, id: string, extra: { testAccount?: boolean; answer?: string }): Case {
  const m = MISSIONS.find((x) => x.id === id)!;
  const i = m.input;
  return {
    platform, label: m.label,
    plan: { fixture: i.fixture, request: i.request, ...(i.answer ?? extra.answer ? { answer: i.answer ?? extra.answer } : {}), createdAt: i.createdAt, platform: i.platform, ...(extra.testAccount ? { testAccount: true } : {}), ...(i.replay ? { replay: i.replay } : {}), ...(i.transformPlanningPage ? { transformPlanningPage: i.transformPlanningPage } : {}) },
    replay: i,
  };
}

const HALF = "\uD83D";
const damage = (_endpoint: string, page: unknown): unknown => {
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return /^(نص_|txt_)/.test(v) ? `${v} ${HALF}` : v;
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(page);
};

describe.each(CASES)("end to end, $label", (c) => {
  for (const damaged of [false, true]) {
    describe(damaged ? "pages with half an emoji in every text" : "pages as stored", () => {
      let planned: ProductionPlanning;
      let replay: MissionReplay;
      beforeAll(async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(new Date(c.replay.planningAt));
        const own = c.plan.transformPlanningPage;
        planned = await runProductionPlanning({ ...c.plan, ...(damaged ? { transformPlanningPage: (e: string, p: unknown) => damage(e, own ? own(e, p) : p) } : {}) });
        vi.setSystemTime(new Date(c.replay.readAt));
        if (planned.plan) replay = await replayMission({ ...c.replay, savedPlan: planned.plan });
      }, 300_000);
      afterAll(() => { vi.useRealTimers(); });

      it("the production planning run ends plan_ready: the plan was compiled by code (no model), priced, and SAVED (no write refused)", () => {
        expect(planned.error).toBeNull();
        expect(planned.status).toBe("plan_ready");
        expect(planned.rejected).toEqual([]);
        expect(planned.plan?.compiled?.by).toBe("compiler");
        expect(planned.plan?.compiled?.platform).toBe(c.platform);
        expect(restRefuses(planned.savedBody ?? "")).toBe(false);
        expect(Number(planned.mission.reserved_points)).toBeGreaterThan(0);
        expect(Number(planned.mission.unit_price_points)).toBeGreaterThan(0);
      });
      it("every planning read was answered by a stored page of the same tool and inputs (a read nothing stored answers is not invented)", () => {
        for (const call of planned.providerCalls.filter((x) => !x.served)) expect(c.platform === "tiktok" || c.platform === "youtube" || c.platform === "instagram" ? true : false, `unserved ${call.endpointId}`).toBe(true);
      });
      it("the engine read the stored execution pages and delivered rows; the only calls no page answers are the ones this case lists", () => {
        const total = Object.values(replay.rowsByStage).reduce((n, rows) => n + rows.length, 0);
        expect(total).toBeGreaterThan(0);
        for (const u of replay.unserved.filter((x) => replay.unserved.indexOf(x) >= replay.unservedPlanning)) expect(c.unservedOk?.(u.endpointId) ?? false, `unserved in execution: ${u.endpointId}`).toBe(true);
      });
      it("the delivery contract (one number, every gap stated once, dates marked, marks filled): ZERO violations, and nothing completed behind its back", () => {
        expect(replay.built.contract.error).toBeUndefined();
        expect(replay.built.contract.violations.map(violationTextAr)).toEqual([]);
        expect(replay.built.contract.completed).toEqual([]);
      });
    });
  }
});
