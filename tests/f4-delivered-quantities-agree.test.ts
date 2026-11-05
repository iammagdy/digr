import { readFileSync } from "node:fs";
import ExcelJS from "exceljs";
import { beforeAll, describe, expect, it } from "vitest";
import { buildMissionFiles } from "../agent/src/workbook";
import { planByCompiler } from "../agent/src/compiled";
import { createMemoryStore } from "../agent/src/memoryStore";
import { customerMissionView } from "../src/lib/agentMission/customerView";
import { NO_ABOUT_OPTIONS_AR } from "../src/lib/agentMission/foundation/topicChoice";
import { customerPlanView, type PricedPlan } from "../src/lib/agentMission/plan";
import { promisedTotalOf } from "../src/lib/agentMission/promisedNumbers";
import { withRepliesJudged } from "../src/lib/agentMission/repliesCard";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { replayGateway } from "./helpers/replayGateway";

/**
 * FINDING F-4 (launch round): «the completed card says «أكثر من ٤٢» while the Excel and the live counter say «٧٠»».
 *
 * RESULT OF THE INVESTIGATION: not reproducible on the production path. The earlier observation came from a TEST fixture that built a COMPLETED card from the plan as it was at APPROVAL. The worker does not do that: at the end of a run whose replies had no promised number it
 * judges the replies against the delivered comments (`withRepliesJudged`) and stores THAT plan as `plan_public` in the same update that marks the mission completed (agent/src/runMission.ts, `...(hadOpenReplies ? { plan_public: customerPlanView(plan) } : {})`), and the Excel
 * is built from the same judged plan. This test pins the production path: for the REAL plan of the stored TikTok mission M12 (2 videos, 20 comments each, with their replies) and the REAL stored rows, over every delivery from a short one to an over-delivery,
 * the number after «من» in the card's result sentence is the denominator of the Excel's own summary sentence, and both are `promisedTotalOf`. If a future change makes them differ, this fails.
 */
const M12 = "msn_5851abc92a1e6645a9cd";
const ID = "msn_f4agree0000001";
const rd = (stage: string): Array<Record<string, unknown>> => JSON.parse(readFileSync(new URL(`./fixtures/live/missions/${M12}/rows/${stage}.json`, import.meta.url), "utf8"));
const AR = (n: number) => n.toLocaleString("ar-EG");

let plan: PricedPlan;
const all = { videos: rd("videos"), comments: rd("comments"), comments_replies: rd("comments_replies") };

beforeAll(async () => {
  const catalog = loadTregCatalog();
  const store = createMemoryStore();
  const { gateway } = replayGateway(M12, catalog, store, ID);
  const planned = await planByCompiler({ mission: { id: ID, request_text: "هات فيديوهين تيك توك بالعربي عن الذكاء الاصطناعي من مصر، أكتر فيديوهات عليها تعليقات، و٢٠ تعليق من كل فيديو مع ردودهم", answer_text: NO_ABOUT_OPTIONS_AR.useAsIs, created_at: "2026-11-02T11:35:00Z" }, gateway, store, catalog, nowMs: Date.parse("2026-11-02T11:36:00Z") });
  if (planned.kind !== "plan") throw new Error(planned.kind);
  plan = planned.plan;
}, 120000);

/** What the worker stores when the mission completes: the judged plan, as `plan_public`. */
function cardLineOf(by: { videos: number; comments: number; comments_replies: number }) {
  const rows = { videos: all.videos.slice(0, by.videos), comments: all.comments.slice(0, by.comments), comments_replies: all.comments_replies.slice(0, by.comments_replies) };
  const judged = withRepliesJudged(plan, rows as never);
  const total = by.videos + by.comments + by.comments_replies;
  const view = customerMissionView({ mission: { id: ID, status: "completed", question_ar: null, plan_public: customerPlanView(judged), reserved_points: 450, unit_price_points: 1, delivered_units: total, charged_points: total, summary_ar: "تم", files: [{ name: "result.xlsx", kind: "xlsx" }], created_at: "2026-11-05T08:00:00Z" } as never, events: [] as never, queue: { ahead: 0, running: 0, workerAlive: true }, now: 1 });
  return { line: view.resultLinesAr[0] ?? "", judged, rows, total };
}

describe("F-4: the completed card and the Excel tell the same quantities", () => {
  it("the stored M12 plan has open replies, so the worker judges and re-stores it (the premise of the production path)", () => {
    expect(plan.stages.some((s) => s.replies_open)).toBe(true);
    const unjudged = customerMissionView({ mission: { id: ID, status: "completed", question_ar: null, plan_public: customerPlanView(plan), reserved_points: 450, unit_price_points: 1, delivered_units: 109, charged_points: 109, summary_ar: "تم", files: [{ name: "result.xlsx", kind: "xlsx" }], created_at: "2026-11-05T08:00:00Z" } as never, events: [] as never, queue: { ahead: 0, running: 0, workerAlive: true }, now: 1 }).resultLinesAr[0];
    // the plan AT APPROVAL tells «٤٢»: this is what the earlier fixture showed, and the reason the finding looked real
    expect(unjudged).toContain("٤٢");
  });

  it("every delivery from short to over-delivery: the card's denominator is the Excel's (promisedTotalOf), 215 combinations", () => {
    let checked = 0;
    for (const videos of [0, 1, 2]) for (const comments of [0, 10, 25, 30, 39, 40, 41, 100, 300]) for (const replies of [0, 1, 10, 27, 28, 29, 67, 120]) {
      if (videos + comments + replies === 0) continue;
      const { line, judged, rows } = cardLineOf({ videos, comments, comments_replies: replies });
      const { promised } = promisedTotalOf(judged, Object.fromEntries(Object.entries(rows).map(([k, v]) => [k, v.length])), true);
      expect(line, JSON.stringify({ videos, comments, replies })).toContain(AR(promised));
      checked++;
    }
    expect(checked).toBe(215);
  });

  it("the Excel's own first sheet says the same denominator as the card (short, exact and over-delivery)", async () => {
    for (const by of [{ videos: 2, comments: 30, comments_replies: 10 }, { videos: 2, comments: 40, comments_replies: 28 }, { videos: 2, comments: 300, comments_replies: 67 }]) {
      const { line, judged, rows } = cardLineOf(by);
      const built = await buildMissionFiles(judged, rows as never, undefined, undefined, { repliesJudged: true });
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(built.xlsx as never);
      const texts: string[] = [];
      wb.worksheets[0].eachRow((row) => row.eachCell((cell) => { if (typeof cell.value === "string") texts.push(cell.value); }));
      const excel = texts.find((t) => t.startsWith("تم تسليم"));
      expect(excel, JSON.stringify(by)).toBeTruthy();
      const { promised } = promisedTotalOf(judged, Object.fromEntries(Object.entries(rows).map(([k, v]) => [k, v.length])), true);
      expect(excel!).toContain(AR(promised));
      expect(line).toContain(AR(promised));
      // the delivered number is the same in both
      expect(excel!).toContain(AR(by.videos + by.comments + by.comments_replies));
      expect(line).toContain(AR(by.videos + by.comments + by.comments_replies));
    }
  }, 120000);
});
