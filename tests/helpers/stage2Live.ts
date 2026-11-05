import { readFileSync } from "node:fs";
import { createMemoryStore } from "../../agent/src/memoryStore";
import { planByCompiler } from "../../agent/src/compiled";
import { ItemStore, type Op } from "../../agent/src/items/itemStore";
import { buildLiveSnapshot } from "../../agent/src/stage2/liveSnapshot";
import { NO_ABOUT_OPTIONS_AR } from "../../src/lib/agentMission/foundation/topicChoice";
import { pollResponse, type LivePollResponse } from "../../src/lib/agentMission/stage2/liveSheet";
import { loadTregCatalog } from "../../src/lib/treg/catalog";
import { replayGateway } from "./replayGateway";

/** STAGE 2 tests: one poll answer of the live sheet built from the stored real rows of M12 (msn_5851abc92a1e6645a9cd) by the worker's own builder and the route's own contract. */
const catalog = loadTregCatalog();
const M12 = "msn_5851abc92a1e6645a9cd";
const read = (rel: string): any => JSON.parse(readFileSync(new URL(`../fixtures/live/missions/${M12}/${rel}.json`, import.meta.url), "utf8"));

export async function liveAnswer(query: { sheet: string | null; offset: number; limit: number }): Promise<Extract<LivePollResponse, { changed: true }>> {
  const store = createMemoryStore();
  const { gateway } = replayGateway(M12, catalog, store, "msn_ui");
  const planned = await planByCompiler({ mission: { id: "msn_ui", request_text: "هات فيديوهين تيك توك بالعربي عن الذكاء الاصطناعي من مصر، أكتر فيديوهات عليها تعليقات، و٢٠ تعليق من كل فيديو مع ردودهم", answer_text: NO_ABOUT_OPTIONS_AR.useAsIs, created_at: "2026-11-02T11:35:00Z" }, gateway, store, catalog, nowMs: Date.parse("2026-11-02T11:36:00Z") });
  if (planned.kind !== "plan") throw new Error(planned.kind);
  const items = await ItemStore.open(createMemoryStore(), "msn_ui");
  for (const key of ["videos", "comments", "comments_replies"]) await items.commit((read(`rows/${key}`) as Array<Record<string, unknown>>).map((row): Op => ({ t: "item", stage: key, id: String(row.id), state: "accepted", by: "rule", row })));
  const snap = buildLiveSnapshot({ missionId: "msn_ui", plan: planned.plan, snap: items.snapshotOfMemory(), status: "running", events: [{ kind: "progress", created_at: "2026-11-04T08:31:00Z", counts: { stage: 2, saved: 30, planned: 40 } }], nowMs: 0 });
  const r = pollResponse(snap, { cursor: null, ...query });
  if (!r.changed) throw new Error("unchanged");
  return r;
}

