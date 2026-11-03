import { describe, expect, it } from "vitest";
import type { MemoryStore } from "../agent/src/memoryStore";
import { readWorkbook } from "./helpers/agentReplay";
import { runS4 } from "./helpers/s4World";
import { isRepliesStage } from "../src/lib/agentMission/replies";

/**
 * S4, the live test of 2026-11-02 10:26 Cairo (docs/S1-LIVE-FINDINGS.md, S4). The exact request «... من مصر، مع كل التعليقات والردود».
 *  1. D7: the customer named a country; the cheapest search had no country input (both videos were Iraqi); a search that can express it wins, even if dearer.
 *  2. The replies stage delivered 0: no comment of the delivered page said it had replies, so no reply was read. Replies are read for every comment that has them.
 *  3. The comments sheet has the comment language column, with Arabic labels, as the videos sheet has.
 */
const run = (o = {}) => runS4(o);
const callsOf = (r: Awaited<ReturnType<typeof run>>) => (r.call.mock.calls as Array<[{ endpointId: string; params: Record<string, unknown> }]>).map((c) => c[0]);





import { languageOfTextAr } from "../src/lib/agentMission/languageLabel";
import { countryToolsFor } from "../src/lib/agentMission/conditionTools";
import { loadTregCatalog } from "../src/lib/treg/catalog";

describe("the pure helpers", () => {
  it("the language of a text by its script: Arabic, another language, or none (an emoji, a number)", () => {
    expect(languageOfTextAr("ما شاء الله، كلام جميل جدا")).toBe("العربية");
    expect(languageOfTextAr("great video, thanks")).toBe("لغة أخرى");
    expect(languageOfTextAr("😂😂 ١٢٣")).toBe("غير محددة");
    expect(languageOfTextAr("")).toBe("غير محددة");
  });
});
