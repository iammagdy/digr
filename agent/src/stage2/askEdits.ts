import { ASK_EDITS_FOLDER, askEditsOf } from "../../../src/lib/agentMission/stage2/askEditStore";
import type { AskEdit } from "../../../src/lib/agentMission/stage2/askCard";
import type { AgentStore } from "../types";

/**
 * STAGE 2 (docs/STAGE-2.md S2): the customer's accepted card edits of a mission, read by the worker before it plans again: the listing of `ask_edits/` (consistent right after a write), then
 * each create-only object. A folder that cannot be read gives no edit (the planning is then today's), never a failed run.
 */
export async function readAskEdits(store: Pick<AgentStore, "listFiles" | "getFile">, missionId: string): Promise<AskEdit[]> {
  try {
    const listed = await store.listFiles(missionId, ASK_EDITS_FOLDER);
    const files = await Promise.all(listed.map(async (f) => ({ name: f.name, body: await store.getFile(missionId, f.name).catch(() => null) })));
    return askEditsOf(files);
  } catch {
    return [];
  }
}
