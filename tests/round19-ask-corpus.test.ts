import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildAsk } from "../src/lib/agentMission/foundation/ask";
import { questionNeeded } from "../src/lib/agentMission/foundation/countChoice";
import { buildRequestContract } from "../src/lib/agentMission/requestContract";
import { numberOfToken, numberOfWord } from "../src/lib/agentMission/arabicNumberWords";

/**
 * ROUND 19, ITEM 4 (smoke of 4 Nov 2026, YouTube: «هات فيديو واحد ... مع ١٠ تعليقات» was asked the count and the comments per video although it said «فيديو واحد» and «١٠ تعليقات»).
 * THE PERMANENT CORPUS: `tests/fixtures/ask-requests.json`, real-style Arabic requests (the live requests of tests/fixtures/live and of the smoke of 4 Nov 2026, marked `live`, and variations of them) each with the Ask it must give: the platform, the number of parents, the comments per parent, a bare
 * number of comments (asked once), a total number of comments (never asked), what the comments ask is («none» / «some» / «all»), and which question, if any, the production run asks BEFORE any read. Adding a request here is how a new phrasing is pinned.
 */
interface Entry { request: string; source: string; expect: { platform: string | null; count: number | null; commentsPerParent: number | null; commentsBare: number | null; commentsTotal: number | null; comments: string; question: string | null } }
const corpus = JSON.parse(readFileSync(new URL("./fixtures/ask-requests.json", import.meta.url), "utf8")) as Entry[];
const AT = Date.parse("2026-11-04T07:00:00Z");

describe("the Ask corpus", () => {
  it("has at least 40 requests, at least 14 of them live", () => {
    expect(corpus.length).toBeGreaterThanOrEqual(40);
    expect(corpus.filter((e) => e.source === "live").length).toBeGreaterThanOrEqual(14);
  });
  it("covers every number form: words, the dual, «واحد», Arabic-Indic digits, Latin digits, a bare count, a total", () => {
    const all = corpus.map((e) => e.request).join("\n");
    for (const rx of [/فيديو واحد/, /منشور واحد/, /تغريدة واحدة/, /فيديوهين/, /منشورين/, /تغريدتين/, /تلات|ثلاث/, /خمس/, /عشر/, /[٠-٩]/, /\b\d+\b/, /في المجموع|إجمالي/]) expect(all).toMatch(rx);
    expect(corpus.some((e) => e.expect.commentsBare !== null)).toBe(true);
    expect(corpus.some((e) => e.expect.commentsTotal !== null)).toBe(true);
  });
  it.each(corpus.map((e) => [e.request, e] as const))("%s", (_request, e) => {
    const ask = buildAsk(e.request, null, AT);
    const got = { platform: ask.platform, count: ask.count, commentsPerParent: ask.commentsPerParent, commentsBare: ask.commentsBare, commentsTotal: ask.edits.comments ?? null, comments: ask.comments, question: questionNeeded(ask, {}, 0)?.why ?? null };
    expect(got).toEqual(e.expect);
  });
});

describe("number words", () => {
  it("the words a customer types, in the standard and the dialect forms", () => {
    expect([numberOfWord("واحد"), numberOfWord("واحدة"), numberOfWord("اتنين"), numberOfWord("تلات"), numberOfWord("ثلاث"), numberOfWord("ثلاثة"), numberOfWord("خمس"), numberOfWord("عشر"), numberOfWord("عشرة"), numberOfWord("عشرين"), numberOfWord("مية"), numberOfWord("خمسة عشر")]).toEqual([1, 1, 2, 3, 3, 3, 5, 10, 10, 20, 100, 15]);
    expect(numberOfWord("فيديو")).toBeNull();
    expect(numberOfToken("12")).toBe(12);
    expect(numberOfToken("تلاتين")).toBe(30);
  });
  it("the request contract (the plan gate's own reader) agrees with the Ask on the count", () => {
    for (const e of corpus) expect(buildRequestContract(e.request).count).toBe(e.expect.count);
  });
});
