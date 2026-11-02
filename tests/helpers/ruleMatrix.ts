import type { CatalogEndpoint, TregCatalog } from "../../src/lib/treg/catalog";

/** The five social platforms and the four request types of the consolidation (docs/S1-LIVE-FINDINGS.md, «Consolidation»). */
export const SOCIAL_PLATFORMS = ["tiktok", "instagram", "facebook", "youtube", "x"] as const;
export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number];
export const REQUEST_TYPES = ["search", "account", "comments", "replies"] as const;
export type RequestType = (typeof REQUEST_TYPES)[number];
export const REQUEST_TYPE_AR: Record<RequestType, string> = { search: "بحث منشورات", account: "منشورات حساب", comments: "تعليقات", replies: "ردود" };

/** The catalog capability each request type reads on each platform (null: the catalog has none; the matrix says so from the catalog). */
export const CAPABILITY: Record<SocialPlatform, Record<RequestType, string | null>> = {
  tiktok: { search: "tiktok.search.videos", account: "tiktok.user.videos", comments: "tiktok.video.comments", replies: "tiktok.comment.replies" },
  instagram: { search: "instagram.search.reels", account: "instagram.user.posts", comments: "instagram.post.comments", replies: "instagram.comment.replies" },
  facebook: { search: "facebook.search.posts", account: "facebook.user.posts", comments: "facebook.post.comments", replies: "facebook.comment.replies" },
  youtube: { search: "youtube.search.videos", account: "youtube.channel.videos", comments: "youtube.video.comments", replies: "youtube.comment.replies" },
  x: { search: "x.search.posts", account: "x.user.posts", comments: "x.post.comments", replies: null },
};

/** The direct, synchronous endpoints of the platform's capability for a request type. */
export function capabilitiesOf(catalog: TregCatalog, platform: SocialPlatform, type: RequestType): CatalogEndpoint[] {
  const capability = CAPABILITY[platform][type];
  if (!capability) return [];
  return catalog.endpoints.filter((e) => e.platform === platform && e.capability === capability && e.kind === "direct" && !e.async);
}

// ============================================================================================================ THE RULE × PLATFORM × REQUEST TYPE MATRIX (docs/S1-LIVE-FINDINGS.md, «Consolidation»)
import { toolProfile } from "../../src/lib/agentMission/toolProfile";
import { replySourcesFor } from "../../src/lib/agentMission/replies";

export const RULES = ["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8", "R9"] as const;
export type RuleId = (typeof RULES)[number];
export const RULE_TITLE: Record<RuleId, string> = {
  R1: "الوعد = عدّادات المنشورات المختارة (تعليقات وردود معًا)، لا تقدير",
  R2: "الاختيار الافتراضي = الأكثر تعليقًا (بحثًا وحسابًا)",
  R3: "بلد العميل ولغته أولًا؛ الترتيب بالتفاعل داخل المطابق فقط",
  R4: "معنى الموضوع (عن / معمول بـ / ملتبس) لأي موضوع",
  R5: "حدود يوم القاهرة في كل أداة تأخذ تواريخ",
  R6: "أداة الردود في كتالوج المنصة؛ الردود لتعليق عدّاده > ٠",
  R7: "الأداة التالية عند انتهاء الأولى قبل الوعد",
  R8: "قيم بالعربي فقط (لا true/false ولا رموز لغة)",
  R9: "نوع المرحلة من بنيتها لا من كلمات عنوانها",
};
/** The request types each rule concerns; the other cells are «not concerned» and are not counted. */
export const CONCERNED: Record<RuleId, ReadonlyArray<RequestType>> = {
  R1: ["comments", "replies"], R2: ["search", "account"], R3: ["search", "account"], R4: ["search", "account"], R5: ["search", "account"], R6: ["replies"], R7: ["comments"], R8: ["search", "account", "comments", "replies"], R9: ["search", "account", "comments", "replies"],
};
export interface Cell { status: "applied" | "not_possible"; /** The test file and a fragment of the test's title that proves the cell (applied), or that proves the fallback (not possible). */ test: string; /** The catalog evidence, computed. */ evidence: string }

const BENCH: Record<SocialPlatform, string> = { tiktok: "benchmark-antigravity-1-5.test.ts::3. TikTok", instagram: "benchmark-antigravity-1-5.test.ts::4. Instagram", facebook: "benchmark-antigravity-1-5.test.ts::1. Facebook", youtube: "benchmark-antigravity-1-5.test.ts::2. YouTube", x: "benchmark-antigravity-1-5.test.ts::5. X" };
/** The (platform, request type) pairs a benchmark end-to-end test runs: a cell is proved by the benchmark only for a pair it contains; every other cell is proved by the test of the same rule over the platform's own catalog tools (the code is platform-agnostic: the tools are not). */
const E2E: ReadonlySet<string> = new Set(["tiktok:search", "tiktok:comments", "tiktok:replies", "instagram:account", "instagram:comments", "instagram:replies", "facebook:account", "facebook:comments", "facebook:replies", "youtube:search", "youtube:comments", "youtube:replies", "x:search"]);
const E2E_BY_RULE: Partial<Record<RuleId, ReadonlySet<string>>> = {
  R2: new Set(["tiktok:search", "instagram:account"]), R3: new Set(["tiktok:search", "x:search"]), R4: new Set(["tiktok:search"]), R5: new Set(["x:search"]),
};
const proof = (rule: RuleId, p: SocialPlatform, t: RequestType, unit: string): string => {
  const set = E2E_BY_RULE[rule] ?? E2E;
  return set.has(`${p}:${t}`) && rule !== "R9" ? BENCH[p] : `consolidation-rules.test.ts::${unit}`;
};
const hasCounterField = (e: CatalogEndpoint): boolean => Object.keys(e.item_fields ?? {}).some((k) => /comment|repl/i.test(k));

export function buildMatrix(catalog: TregCatalog): Record<RuleId, Record<SocialPlatform, Partial<Record<RequestType, Cell>>>> {
  const out = {} as Record<RuleId, Record<SocialPlatform, Partial<Record<RequestType, Cell>>>>;
  for (const rule of RULES) { out[rule] = {} as Record<SocialPlatform, Partial<Record<RequestType, Cell>>>; for (const p of SOCIAL_PLATFORMS) out[rule][p] = {}; }
  for (const p of SOCIAL_PLATFORMS) {
    const tools = (t: RequestType) => capabilitiesOf(catalog, p, t);
    const n = (t: RequestType) => tools(t).length;
    const counters = (t: RequestType) => tools(t).filter(hasCounterField).length;
    const comments = tools("comments");
    const hasReplies = n("replies") > 0 || replySourcesFor(comments[0]?.id ?? "", catalog, { isAllowed: () => true, videoIdAvailable: true, urlAvailable: true }).length > 0;
    // R1: the promise
    for (const t of CONCERNED.R1) {
      const listing = counters("search") + counters("account");
      if (t === "replies" && !hasReplies) { out.R1[p][t] = { status: "not_possible", test: "consolidation-rules.test.ts::x: the catalog has no comment-replies capability", evidence: `the catalog has no ${p}.comment.replies tool (0 of ${catalog.endpoints.filter((e) => e.platform === p).length} ${p} endpoints)` }; continue; }
      out.R1[p][t] = listing > 0
        ? { status: "applied", test: proof("R1", p, t, `rule 1: ${p} / comments`), evidence: `${listing} listing tools give a comment counter field (search ${counters("search")} of ${n("search")}, account ${counters("account")} of ${n("account")}): comments + replies = the chosen posts' counters` }
        : { status: "not_possible", test: proof("R1", p, t, `rule 1: ${p} / comments`), evidence: `0 of ${n("search")} search and 0 of ${n("account")} account listing tools give a comment counter field, so no number is promised: the stage is open («كل التعليقات…»), priced from the estimate as a maximum, judged on what the source gave` };
    }
    // R2: the most commented
    for (const t of CONCERNED.R2) {
      const c = counters(t);
      out.R2[p][t] = c > 0
        ? { status: "applied", test: proof("R2", p, t, "rule 2"), evidence: `${c} of ${n(t)} tools give a comment counter: the highest counters first (an order, never a filter); the tool's most-liked order is used when it has one` }
        : { status: "not_possible", test: "consolidation-rules.test.ts::rule 2", evidence: `0 of ${n(t)} tools give a comment counter: no comment count to order by; the tool's own order stands and the card says so` };
    }
    // R3: country and language first
    for (const t of CONCERNED.R3) {
      const withCountry = tools(t).filter((e) => toolProfile(e).country?.enforces === true).length;
      const withLanguage = tools(t).filter((e) => { const pr = toolProfile(e); return pr.language !== null || pr.queryOperators; }).length;
      out.R3[p][t] = withCountry + withLanguage > 0
        ? { status: "applied", test: proof("R3", p, t, "rule 3"), evidence: `country input on ${withCountry} of ${n(t)} tools, language input or operator on ${withLanguage}: written into the tool's own field; the matching results come first, then the engagement order` }
        : { status: "not_possible", test: "consolidation-rules.test.ts::rule 3", evidence: `0 of ${n(t)} tools have a country or language input: the card states the gap and the file marks each row's place and language; the matching rows still come first among the results read` };
    }
    // R4: the topic's meaning
    for (const t of CONCERNED.R4) {
      const withQuery = tools(t).filter((e) => toolProfile(e).query !== null).length;
      out.R4[p][t] = withQuery > 0
        ? { status: "applied", test: proof("R4", p, t, "rule 4"), evidence: `${withQuery} of ${n(t)} tools have a query field: the model's own query (topic_meaning) is written there; the videos that discuss the topic come first` }
        : { status: "not_possible", test: "consolidation-rules.test.ts::rule 4", evidence: `0 of ${n(t)} tools have a query field (an account's listing has no search words): the meaning orders the posts read (discussion class), it cannot shape the request` };
    }
    // R5: Cairo days
    for (const t of CONCERNED.R5) {
      const dated = tools(t).filter((e) => { const pr = toolProfile(e); return pr.queryOperators || ((pr.date?.from || pr.date?.to) && pr.date.format !== "unknown"); }).length;
      const presets = tools(t).filter((e) => toolProfile(e).date?.preset).length;
      out.R5[p][t] = dated > 0
        ? { status: "applied", test: proof("R5", p, t, "rule 5"), evidence: `${dated} of ${n(t)} tools take dates (a range input in a stated format, or query operators): the customer's days are Cairo days converted to UTC with the offset of each date` }
        : { status: "not_possible", test: "consolidation-rules.test.ts::rule 5", evidence: `0 of ${n(t)} tools take a calendar date range (${presets} take only a rolling preset): a Cairo day boundary cannot be written; the card says so and the file marks each row's membership` };
    }
    // R6: the replies tool
    out.R6[p].replies = hasReplies
      ? { status: "applied", test: `${BENCH[p]}`, evidence: `${n("replies")} replies tools in the catalog${n("replies") === 0 ? "" : ""}; fed by the comment's id or by the tokens its own row carries; read only for comments whose reply counter is above zero when counters exist` }
      : { status: "not_possible", test: "consolidation-rules.test.ts::x: the catalog has no comment-replies capability", evidence: `no ${p}.comment.replies capability in the catalog; the replies to a post ARE its comments (x.post.comments), and replies inside search results are kept and marked` };
    // R7: the next tool
    {
      const pageable = comments.filter((e) => toolProfile(e).cursor !== null).length;
      out.R7[p].comments = comments.length >= 2
        ? { status: "applied", test: "s6-live-fixture.test.ts::keep reading", evidence: `${comments.length} comments tools (${pageable} with a cursor): when the first ends before the promise the stage's next tool reads the same parent from the start` }
        : { status: "not_possible", test: "s6-live-fixture.test.ts::keep reading", evidence: `only ${comments.length} comments tool in the catalog for ${p}: there is no next tool to read` };
    }
    // R8 and R9: every type that has a tool
    for (const t of CONCERNED.R8) {
      out.R8[p][t] = t === "replies" && !hasReplies
        ? { status: "not_possible", test: "consolidation-rules.test.ts::x: the catalog has no comment-replies capability", evidence: `no replies sheet exists for ${p} (no replies capability)` }
        : { status: "applied", test: proof("R8", p, t, "rule 8"), evidence: "the sample table and every cell of the customer's file: true/false are نعم/لا, numbers Arabic-Indic, language codes Arabic names" };
    }
    for (const t of CONCERNED.R9) {
      out.R9[p][t] = n(t) > 0
        ? { status: "applied", test: `consolidation-rules.test.ts::rule 9`, evidence: `${n(t)} tools of ${CAPABILITY[p][t]}: the stage's capability decides its type under ten trap titles` }
        : { status: "not_possible", test: "consolidation-rules.test.ts::x: the catalog has no comment-replies capability", evidence: `no ${p} tool for ${t} in the catalog` };
    }
  }
  return out;
}

/** The matrix as the table of the findings document (Arabic headings for the rules, one row a rule and platform). */
export function matrixMarkdown(m: ReturnType<typeof buildMatrix>): { markdown: string; applied: number; notPossible: number } {
  let applied = 0; let notPossible = 0;
  const lines = ["| القاعدة | المنصة | بحث | حساب | تعليقات | ردود |", "|---|---|---|---|---|---|"];
  const cell = (c: Cell | undefined): string => { if (!c) return "—"; if (c.status === "applied") { applied += 1; return `✔ ${c.test.split("::")[0].replace(".test.ts", "")}`; } notPossible += 1; return `✖ ${c.evidence.slice(0, 90)}`; };
  for (const rule of RULES) for (const p of SOCIAL_PLATFORMS) lines.push(`| ${rule} ${RULE_TITLE[rule]} | ${p} | ${REQUEST_TYPES.map((t) => cell(m[rule][p][t])).join(" | ")} |`);
  return { markdown: lines.join("\n"), applied, notPossible };
}
