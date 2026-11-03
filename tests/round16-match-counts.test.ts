import { describe, expect, it } from "vitest";
import { buildAsk } from "../src/lib/agentMission/foundation/ask";
import { MATCH_COUNTS_PREFIX_AR, matchCountsLineAr } from "../src/lib/agentMission/foundation/compilePlan";
import { factsOf } from "../src/lib/agentMission/foundation/pool";
import { customerPlanView } from "../src/lib/agentMission/plan";
import { tiktokWorld } from "./helpers/round11Worlds";
import { MISSIONS } from "./helpers/round14Missions";

/**
 * ROUND 16, PART 3: THE CARD STATES, FROM THE INSPECTED PLANNING ROWS, how many of the selected items match the customer's conditions and how many are alternatives marked in the file. The numbers are recounted here, independently, from the rows the plan pinned.
 */
describe("the sentence", () => {
  it("all match: said so, with no alternative; some do not: the counts, in Arabic-Indic digits", () => {
    expect(matchCountsLineAr(3, 0)).toBe("من العناصر المختارة وعددها ٣: كلها تطابق شروطك، ولا بديل بينها.");
    expect(matchCountsLineAr(3, 1)).toBe("من العناصر المختارة وعددها ٣: ٢ تطابق شروطك، و١ منها بدائل عليها علامة في الملف.");
    expect(matchCountsLineAr(2, 5)).toBe("من العناصر المختارة وعددها ٢: ٠ تطابق شروطك، و٢ منها بدائل عليها علامة في الملف.");
    expect(matchCountsLineAr(3, 1)).not.toMatch(/[0-9]/);
  });
});

describe("on the stored TikTok planning pages (country and language asked)", () => {
  it("the plan's sentence carries the counts recomputed from its own pinned rows, once", async () => {
    const w = await tiktokWorld();
    const m = MISSIONS.find((x) => x.input.platform === "tiktok")!.input;
    const ask = buildAsk(m.request, m.answer ?? null, Date.parse(m.createdAt));
    const pinned = (w.plan.stages[0].pinned_rows ?? []) as Array<Record<string, unknown>>;
    const mismatched = pinned.filter((r) => { const f = factsOf(r, ask, false); return !f.country || !f.language || !f.named; }).length;
    const lines = (w.plan.notes_ar ?? []).filter((l) => l.startsWith(MATCH_COUNTS_PREFIX_AR));
    expect(lines).toEqual([matchCountsLineAr(pinned.length, mismatched)]);
    // the customer's view carries it too, and no provider or endpoint
    const shown = JSON.stringify(customerPlanView(w.plan));
    expect(shown).toContain(lines[0].replace(/"/g, '\\"'));
    expect(shown).not.toMatch(/tikhub|anyapi|crawl4ai|scrapecreators/i);
  }, 120_000);
});
