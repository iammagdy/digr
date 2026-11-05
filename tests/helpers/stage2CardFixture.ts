import { readFileSync } from "node:fs";
import { createMemoryStore } from "../../agent/src/memoryStore";
import { planByCompiler } from "../../agent/src/compiled";
import { ItemStore, type Op } from "../../agent/src/items/itemStore";
import { buildLiveSnapshot } from "../../agent/src/stage2/liveSnapshot";
import { customerMissionView, type CustomerMissionView } from "../../src/lib/agentMission/customerView";
import { NO_ABOUT_OPTIONS_AR } from "../../src/lib/agentMission/foundation/topicChoice";
import { customerPlanView } from "../../src/lib/agentMission/plan";
import { pollResponse, type LivePollResponse } from "../../src/lib/agentMission/stage2/liveSheet";
import { loadTregCatalog } from "../../src/lib/treg/catalog";
import { replayGateway } from "./replayGateway";

/**
 * STAGE 2 F-2 tests: the REAL plan of the stored M12 mission (TikTok: 2 videos, 20 comments each, with replies), its stored real rows and the customer view the site builds from them, so that the card's own numbers and the live
 * sheet's numbers are the production ones at the same moment. Nothing here is typed in as a number except how many stored rows have arrived.
 */
const catalog = loadTregCatalog();
const M12 = "msn_5851abc92a1e6645a9cd";
const ID = "msn_f2fixture000001";
const read = (rel: string): Array<Record<string, unknown>> => JSON.parse(readFileSync(new URL(`../fixtures/live/missions/${M12}/${rel}.json`, import.meta.url), "utf8"));

export interface Arrived { v: number; c: number; r: number }
export interface M12Fixture {
  view: (arrived: Arrived, status: "executing" | "completed", delivered?: number) => CustomerMissionView;
  live: (arrived: Arrived, status: "running" | "done") => Promise<Extract<LivePollResponse, { changed: true }>>;
}

export async function m12Fixture(): Promise<M12Fixture> {
  const store = createMemoryStore();
  const { gateway } = replayGateway(M12, catalog, store, ID);
  const planned = await planByCompiler({ mission: { id: ID, request_text: "هات فيديوهين تيك توك بالعربي عن الذكاء الاصطناعي من مصر، أكتر فيديوهات عليها تعليقات، و٢٠ تعليق من كل فيديو مع ردودهم", answer_text: NO_ABOUT_OPTIONS_AR.useAsIs, created_at: "2026-11-02T11:35:00Z" }, gateway, store, catalog, nowMs: Date.parse("2026-11-02T11:36:00Z") });
  if (planned.kind !== "plan") throw new Error(planned.kind);
  const plan = planned.plan;
  const rows = { videos: read("rows/videos"), comments: read("rows/comments"), comments_replies: read("rows/comments_replies") };
  const op = (stage: string, row: Record<string, unknown>): Op => ({ t: "item", stage, id: String(row.id), state: "accepted", by: "rule", row });
  return {
    view: (a, status, deliveredUnits) => {
      const events = [
        { id: 1, kind: "progress", message_ar: "x", counts: { stage: 1, saved: a.v, planned: 2 }, created_at: "2026-11-05T08:31:00Z" },
        ...(a.c > 0 ? [{ id: 2, kind: "progress", message_ar: "x", counts: { stage: 2, saved: Math.min(a.c, 40), planned: 40 }, created_at: "2026-11-05T08:31:30Z" }] : []),
      ];
      const done = status === "completed";
      const row = { id: ID, status, question_ar: null, plan_public: customerPlanView(plan), reserved_points: 450, unit_price_points: 1, delivered_units: done ? deliveredUnits ?? a.v + a.c + a.r : null, charged_points: done ? deliveredUnits ?? a.v + a.c + a.r : null, summary_ar: done ? "تم تسليم طلبك." : null, files: done ? [{ name: "result.xlsx", kind: "xlsx" }] : null, created_at: "2026-11-05T08:00:00Z" };
      return customerMissionView({ mission: row as never, events: events as never, queue: { ahead: 0, running: 0, workerAlive: true }, now: Date.parse("2026-11-05T08:32:00Z") });
    },
    live: async (a, status) => {
      const items = await ItemStore.open(createMemoryStore(), ID);
      await items.commit([...rows.videos.slice(0, a.v).map((r) => op("videos", r)), ...rows.comments.slice(0, a.c).map((r) => op("comments", r)), ...rows.comments_replies.slice(0, a.r).map((r) => op("comments_replies", r))]);
      const snap = buildLiveSnapshot({ missionId: ID, plan, snap: items.snapshotOfMemory(), status, nowMs: 0 });
      const r = pollResponse(snap, { cursor: null, sheet: "comments", offset: 0, limit: 10 });
      if (!r.changed) throw new Error("unchanged");
      return r;
    },
  };
}
