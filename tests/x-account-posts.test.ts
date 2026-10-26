import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { ChatHandler, routeUnavailablePlatformRequest } from "../src/functions/shared/chatHandler";
import { clearBriefCacheForTesting } from "../src/functions/shared/briefManager";
import { resetProviderBalanceCacheForTesting, setProviderBalanceForTesting } from "../src/functions/shared/providerSpend";
import { formatStructuredClarificationAnswers, validateStructuredClarificationAnswers } from "../src/functions/shared/clarification";
import { detectMentionedPlatforms } from "../src/functions/shared/capabilityRegistry";
import { applyPlanOperations } from "../src/functions/shared/planManager";
import { createChatDb } from "./helpers/chatSession";
import { detectSocialIntent } from "../src/lib/socialTasks";
import { X_COMMENTS_UNAVAILABLE_AR, X_ONE_ACCOUNT_AR, X_REQUEST_NOT_SERVED_AR, UNSUPPORTED_PLATFORM_AR, unsupportedPlatformAnswerAr } from "../src/lib/socialDiscoveryCard";
import { X_ACCOUNT_EDIT_AR, getSocialCapability, normalizeXAccountPlanItem, resolveSocialMode, socialPlanSummaryAr, xAccountNoteAr } from "../src/lib/socialSources";
import { quoteScopeGaps } from "../src/lib/quoteScopeGaps";
import { evaluateResearchRowRelevance, isXAccountRequest, postAuthorHandle } from "../src/lib/server/researchRelevanceGate";
import { emptyDiagnostic, heldToReport, mergeDiagnostic, recordRowGate, zeroDeliveryEventAr } from "../src/lib/server/zeroDeliveryDiagnostic";
import { summarizeActivityCounts, zeroDeliveryPageLineAr } from "../src/lib/activityCounts";
import { reserveForUnits } from "../src/lib/recordPricing";

/**
 * «X account posts» on production (2026-10-26). Two live failures, both reproduced here on the exact request texts and the exact payload the chat sends for a card
 * answer (questionId, the question's text, the value). FAKE database and FAKE model (it throws if asked); no provider is called.
 *
 *  1. «٤٠٠ منشور من الصفحة الرسمية … عن الشائعات والتعليقات» was planned as a post-comments service priced per call (٢٬٧٦٠ points for ٤٠٠ posts) and failed.
 *  2. «منشورات من حساب @elonmusk و @BillGates» looped on the platform question (X was not an option and «إكس» was not read), then ran as a keyword search for the
 *     two names, and every row was rejected for not containing the topic's words.
 */
beforeEach(() => { vi.stubEnv("JOB_MAX_POINTS_CAP", ""); resetProviderBalanceCacheForTesting(); setProviderBalanceForTesting(50); });
afterEach(() => { vi.unstubAllEnvs(); resetProviderBalanceCacheForTesting(); });

const FAILURE_1 = "أريد 400 منشور من الصفحة الرسمية لمنصة أكس التابعة لوزارة الصحة السعودية عن الشائعات والتعليقات الخاصة بها خلال الفترة من 1 يناير حتى 1 يونيو 2026";
const FAILURE_1_WITHOUT_COMMENTS = "أريد 400 منشور من الصفحة الرسمية لمنصة أكس التابعة لوزارة الصحة السعودية عن الشائعات خلال الفترة من 1 يناير حتى 1 يونيو 2026";
const FAILURE_2_FIRST = "أريد آخر 3 منشورات نشرها حساب إيلون ماسك (@elonmusk) على منصة إكس، وآخر 3 منشورات نشرها حساب بيل غيتس (@BillGates) على منصة إكس، مع عدد الإعجابات وعدد إعادة النشر لكل منشور، وعدد الردود إذا كان متاحًا. هذه منشورات صادرة عن الحسابين أنفسهما، وليست تعليقات ولا بحثًا عن موضوع.";
const FAILURE_2_CORRECTION = "تصحيح: لا أريد فيديوهات ولا تعليقات ولا آخر شهر. أريد فقط آخر 3 منشورات نصية أو منشورات صادرة من حساب إيلون ماسك (@elonmusk) على إكس، وآخر 3 منشورات صادرة من حساب بيل غيتس (@BillGates) على إكس، أي 6 منشورات في المجموع، مع عدد الإعجابات وعدد إعادة النشر وعدد الردود لكل منشور.";
const FAILURE_2_ACCOUNTS = "أريد أحدث 3 تغريدات من حساب @elonmusk على إكس، وأحدث 3 تغريدات من حساب @BillGates على إكس، مع عدد الإعجابات وعدد إعادة التغريد وعدد الردود لكل تغريدة.";
const PLATFORM_QUESTION = "على أي منصة تريد البحث؟";

let seq = 0;
async function chat() {
  const db: any = createChatDb();
  const handler = new ChatHandler(db);
  (handler as any).llm.executeTurn = vi.fn(async () => { throw new Error("the model must not be asked"); });
  const conversationId = `conv_xa_${++seq}`;
  await db.createRow({ tableId: "conversations", rowId: conversationId, data: { userId: "user_xa", title: "محادثة جديدة", status: "active", totalTokens: 0 } });
  clearBriefCacheForTesting();
  const send = (message: string): Promise<any> => handler.handleUserMessage({ userId: "user_xa", conversationId, message, userBalance: 40_000 }) as Promise<any>;
  /** A card answer exactly as the route builds it: validated, then serialised from {questionId, question, value}. */
  const answer = (questionId: string, question: string, value: string) =>
    send(formatStructuredClarificationAnswers(validateStructuredClarificationAnswers({ type: "clarification_answers", answers: [{ questionId, question, value }] })!));
  return { db, send, answer };
}

const CUSTOMER_TEXT_RULES = (text: string) => {
  expect(text.replace(/منصة X|منصة إكس/g, "")).not.toMatch(/[A-Za-z]/); // the platform's own name is the one Latin letter allowed
  expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
  expect(text).not.toMatch(/[*_#`]|\$|USD|دولار/);
  expect(text).not.toMatch(/treg|anyapi|tikhub|scrapecreators|crawl4ai|endpoint/i);
};

describe("one reader of the platform name: «أكس», «إكس», «اكس», «منصة X» and the answer to the platform question", () => {
  const X_NAMES = [
    "منشورات من الصفحة الرسمية لمنصة أكس",
    "عايز منشورات على إكس",
    "عايز منشورات على اكس",
    "هات ١٠٠ منشور عبر أكس عن الصحة",
    "على منصة X",
    "منصة البحث المطلوبة: إكس",
    "منصة البحث المطلوبة: أكس",
    "منصة البحث المطلوبة: منصة X",
    "المنصة التي تقصدها: أكس",
    "تغريدات عن الصحة",
    "منشورات عن الصحة على تويتر",
  ];
  it.each(X_NAMES)("both detectors read X in: %s", (text) => {
    expect(detectSocialIntent(text).platform).toBe("x");
    expect(detectMentionedPlatforms(text)).toContain("x");
  });

  it.each(["جدول اكسل للأسعار", "منشورات عن ماكس", "ملف إكسل", "منصة اكسل التعليمية"])("a word that only starts like the letter is not X: %s", (text) => {
    expect(detectMentionedPlatforms(text)).not.toContain("x");
    expect(detectSocialIntent(text).platform).not.toBe("x");
  });

  it("a typed «أكس» or «إكس» as the platform answer is a platform this service serves, never the unsupported-platform sentence", () => {
    for (const name of ["أكس", "إكس", "اكس", "منصة X", "X", "تويتر"]) {
      expect(unsupportedPlatformAnswerAr(`منصة البحث المطلوبة: ${name}`), name).toBe(false);
    }
    expect(unsupportedPlatformAnswerAr("منصة البحث المطلوبة: سناب شات")).toBe(true);
  });
});

describe("FAILURE 1: the official page of a ministry, posts about rumors and their comments, 1 January to 1 June 2026", () => {
  it("«أكس» is read as the platform, so no platform question is asked; the comments of X posts are refused in one sentence BEFORE any plan, and nothing is held", async () => {
    const c = await chat();
    const r = await c.send(FAILURE_1);
    expect(r.outputType).toBe("answer_question");
    expect(r.contentAr).toBe(X_COMMENTS_UNAVAILABLE_AR);
    expect(r.contentAr).toContain("لم يُحجز أي رصيد");
    expect(r.planQuote).toBeUndefined();
    expect(r.clarificationItems ?? []).toEqual([]);
    expect(c.db.store.get("plans_quotes") ?? []).toEqual([]);
    expect(c.db.store.get("credit_ledger") ?? []).toEqual([]);
    CUSTOMER_TEXT_RULES(r.contentAr);
  });

  it("the same request with the platform chosen on the card (the real answer payload, typed «منصة X» into the «أخرى» field) is refused the same way", async () => {
    const c = await chat();
    const first = await c.send("أريد 400 منشور من الصفحة الرسمية لوزارة الصحة السعودية عن الشائعات والتعليقات الخاصة بها خلال الفترة من 1 يناير حتى 1 يونيو 2026");
    expect(first.outputType).toBe("ask_clarification");
    expect(first.clarificationItems[0].id).toBe("social_platform_required");
    expect(first.clarificationItems[0].options).toContain("منصة X");
    const r = await c.answer("social_platform_required", PLATFORM_QUESTION, "منصة X");
    expect(r.outputType).toBe("answer_question");
    expect(r.contentAr).toBe(X_COMMENTS_UNAVAILABLE_AR);
    expect(r.planQuote).toBeUndefined();
    expect(c.db.store.get("plans_quotes") ?? []).toEqual([]);
  });

  it("without the comments, the page is an ACCOUNT: the account is asked for (never turned into a topic made of the page's description)", async () => {
    const c = await chat();
    const r = await c.send(FAILURE_1_WITHOUT_COMMENTS);
    expect(r.outputType).toBe("ask_clarification");
    expect(r.clarificationItems.map((q: any) => q.id)).toEqual(["social_x_account_required"]);
    expect(r.planQuote).toBeUndefined();
  });

  it("the account answered (the real payload): ONE plan on the X posts service, the account as its scope, the window kept, the price from the shared function (not 2,760)", async () => {
    const c = await chat();
    await c.send(FAILURE_1_WITHOUT_COMMENTS);
    const r = await c.answer("social_x_account_required", "ما اسم حساب إكس أو رابطه؟", "@SaudiMOH");
    expect(r.outputType).toBe("propose_plan");
    const item = r.planQuote.items[0];
    expect(item.capabilitySlug).toBe("social-x-posts");
    expect(item.params).toEqual({ channel: "@SaudiMOH", dateFrom: "2026-01-01", dateTo: "2026-06-01" });
    expect(item.params.query).toBeUndefined();
    expect(item.unitPricePoints).toBe(0.11715);
    expect(item.targetVolumeMax).toBe(400);
    expect(r.planQuote.quotedPoints).toBe(reserveForUnits(400, 0.11715));
    expect(r.planQuote.quotedPoints).toBeLessThan(100);
    expect(r.planQuote.quotedPoints).not.toBe(2760);
    // the plan says what it does: the account as it published, no topic filter, the window kept by dropping what is outside it, so fewer may arrive
    expect(r.planQuote.summaryAr).toContain("دون تصفية بالموضوع");
    expect(r.planQuote.summaryAr).toContain("لأن المصدر لا يحدد الفترة عند الطلب");
    expect(r.planQuote.summaryAr).toMatch(/١ يناير ٢٠٢٦/);
    expect(r.planQuote.summaryAr).toMatch(/١ يونيو ٢٠٢٦/);
    CUSTOMER_TEXT_RULES(r.planQuote.summaryAr);
  });
});

describe("FAILURE 2: posts FROM @elonmusk and @BillGates (the tester's two attempts)", () => {
  it("first attempt, first message: two accounts get ONE honest sentence before any plan; it is not read as videos, comments or a health topic", async () => {
    const c = await chat();
    const r = await c.send(FAILURE_2_FIRST);
    expect(r.outputType).toBe("answer_question");
    expect(r.contentAr).toBe(X_ONE_ACCOUNT_AR);
    expect(r.contentAr).not.toMatch(/فيديو|الصحة|الرعاية|تعليقاتها/);
    expect(r.planQuote).toBeUndefined();
    expect(r.clarificationItems ?? []).toEqual([]);
    expect(c.db.store.get("plans_quotes") ?? []).toEqual([]);
    CUSTOMER_TEXT_RULES(r.contentAr);
  });

  it("the correction message («لا أريد فيديوهات ولا تعليقات») never makes it a comments or videos request; the platform question never appears", async () => {
    const c = await chat();
    await c.send(FAILURE_2_FIRST);
    const r = await c.send(FAILURE_2_CORRECTION);
    expect(r.outputType).toBe("answer_question");
    expect(r.contentAr).toBe(X_ONE_ACCOUNT_AR);
    expect(JSON.stringify(r)).not.toContain(PLATFORM_QUESTION);
  });

  it("the second attempt's wording («تغريدات من حساب … على إكس») is read the same way: two accounts, one honest sentence", async () => {
    const c = await chat();
    const r = await c.send(FAILURE_2_ACCOUNTS);
    expect(r.contentAr).toBe(X_ONE_ACCOUNT_AR);
    expect(r.planQuote).toBeUndefined();
  });

  it("ONE account in the same sentence («وليست تعليقات ولا بحثًا عن موضوع») plans the account's posts: scope is the account, no keyword, no topic invented", async () => {
    const c = await chat();
    const r = await c.send("أريد آخر 3 منشورات نشرها حساب إيلون ماسك (@elonmusk) على منصة إكس، مع عدد الإعجابات وعدد إعادة النشر لكل منشور. هذه منشورات صادرة عن الحساب نفسه، وليست تعليقات ولا بحثًا عن موضوع.");
    expect(r.outputType).toBe("propose_plan");
    const item = r.planQuote.items[0];
    expect(item.capabilitySlug).toBe("social-x-posts");
    expect(item.params).toEqual({ channel: "@elonmusk" });
    expect(item.unitPricePoints).toBe(0.11715);
    expect(resolveSocialMode(item.params)).toBe("channel");
    expect(JSON.stringify(r)).not.toMatch(/الصحة والرعاية|فيديو|تعليقات/);
  });

  it("the account link is an account too, not a topic", async () => {
    const c = await chat();
    const r = await c.send("أريد آخر 5 منشورات من حساب https://x.com/elonmusk على إكس");
    expect(r.outputType).toBe("propose_plan");
    expect(r.planQuote.items[0].params.channel).toMatch(/elonmusk/);
    expect(r.planQuote.items[0].params.query).toBeUndefined();
  });
});

describe("X chosen in the platform question is accepted, and the question is never asked twice", () => {
  const REQUEST = "عايز ٤٠٠ منشور عن الشائعات الصحية آخر شهر";

  it("the platform card offers «منصة X» next to the others", async () => {
    const c = await chat();
    const r = await c.send(REQUEST);
    expect(r.outputType).toBe("ask_clarification");
    expect(r.clarificationItems[0].id).toBe("social_platform_required");
    expect(r.clarificationItems[0].options).toContain("منصة X");
  });

  for (const value of ["منصة X", "إكس", "أكس", "اكس", "تويتر"]) {
    it(`the answer «${value}» (the payload the card sends) moves on to the plan on the X posts service at the normal price`, async () => {
      const c = await chat();
      await c.send(REQUEST);
      const r = await c.answer("social_platform_required", PLATFORM_QUESTION, value);
      expect(r.outputType, value).toBe("propose_plan");
      expect(JSON.stringify(r.clarificationItems ?? [])).not.toContain("social_platform_required");
      expect(r.planQuote.items[0].capabilitySlug).toBe("social-x-posts");
      expect(r.planQuote.items[0].unitPricePoints).toBe(0.11715);
    });
  }

  it("a platform that is not served is still told so in one sentence (the unsupported-platform sentence is unchanged)", async () => {
    const c = await chat();
    await c.send(REQUEST);
    const r = await c.answer("social_platform_required", PLATFORM_QUESTION, "سناب شات");
    expect(r.contentAr).toBe(UNSUPPORTED_PLATFORM_AR);
  });

  it("the card sources of the platform list all carry X (the hard-coded lists the fallback uses)", () => {
    for (const file of ["src/functions/shared/chatHandler.ts", "src/lib/consultantCopy.ts"]) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toContain('["تيك توك", "فيسبوك", "يوتيوب", "إنستغرام", "أخرى"]');
      expect(source, file).toContain('["تيك توك", "فيسبوك", "يوتيوب", "منصة X", "إنستغرام", "أخرى"]');
    }
  });
});

describe("a normal X topic request still plans at the same price per post", () => {
  it("«٤٠٠ منشور عن الذكاء الاصطناعي على منصة إكس آخر شهر»: the topic search service, 0.11715 per post, the reserve from the shared function, the window as search operators", async () => {
    const c = await chat();
    const r = await c.send("عايز 400 منشور عن الذكاء الاصطناعي على منصة إكس آخر شهر");
    expect(r.outputType).toBe("propose_plan");
    const item = r.planQuote.items[0];
    expect(item.capabilitySlug).toBe("social-x-posts");
    expect(item.params.query).toBe("الذكاء الاصطناعي");
    expect(item.params.channel).toBeUndefined();
    expect(item.unitPricePoints).toBe(0.11715);
    expect(r.planQuote.quotedPoints).toBe(reserveForUnits(400, 0.11715));
    expect(r.planQuote.summaryAr).not.toContain("دون تصفية بالموضوع");
  });
});

describe("the editor of a plan keeps an X account plan an account plan", () => {
  const accountItem = () => ({ capabilitySlug: "social-x-posts", params: { channel: "@elonmusk" }, targetVolumeMax: 3 });

  it("the OLD editor operation (the topic field written as «query») no longer turns the account into a search: the keyword is dropped, the account stays", () => {
    const plan = applyPlanOperations({ summaryAr: "x", items: [accountItem() as any], outputFormats: ["xlsx"] } as any, [{ action: "set_param", capabilitySlug: "social-x-posts", key: "query", value: "@elonmusk و @BillGates" } as any]);
    expect(plan.items[0].params.query).toBe("@elonmusk و @BillGates");
    expect(normalizeXAccountPlanItem(plan.items[0] as any)).toBeNull();
    expect(plan.items[0].params).toEqual({ channel: "@elonmusk" });
    expect(resolveSocialMode(plan.items[0].params)).toBe("channel");
  });

  it("the new editor operation (the field written as «channel»): one account, a link or a bare name are normalised to «@name»; two accounts in the field are refused in Arabic", () => {
    const edit = (value: string) => {
      const item: any = accountItem();
      item.params.channel = value;
      return { error: normalizeXAccountPlanItem(item), item };
    };
    expect(edit("@BillGates").item.params.channel).toBe("@BillGates");
    expect(edit("BillGates").item.params.channel).toBe("@BillGates");
    expect(edit("https://x.com/BillGates").item.params.channel).toBe("@BillGates");
    for (const bad of ["@elonmusk و @BillGates", "الصحة والرعاية الطبية", "https://x.com/search?q=a"]) {
      expect(edit(bad).error, bad).toBe(X_ACCOUNT_EDIT_AR);
    }
    CUSTOMER_TEXT_RULES(X_ACCOUNT_EDIT_AR);
  });

  it("a topic plan and every other service are left alone", () => {
    const topic: any = { capabilitySlug: "social-x-posts", params: { query: "الصحة" } };
    expect(normalizeXAccountPlanItem(topic)).toBeNull();
    expect(topic.params).toEqual({ query: "الصحة" });
    const facebook: any = { capabilitySlug: "social-facebook-posts", params: { channel: "صفحة اليوم السابع", query: "x" } };
    expect(normalizeXAccountPlanItem(facebook)).toBeNull();
    expect(facebook.params.query).toBe("x");
  });

  it("the chat page writes the topic field of an X account plan as the account (read from its source)", () => {
    const source = readFileSync("src/app/dashboard/chat/page.tsx", "utf8");
    expect(source).toContain('const isAccountPlan = slug === "social-x-posts"');
    expect(source).toContain('const paramKey = isAccountPlan ? "channel"');
    expect(source).toContain("isPostOrUrl && !isAccountPlan &&");
  });

  it("the edit route cleans the plan before it is priced (read from its source)", () => {
    const source = readFileSync("src/app/api/chat/edit-plan/route.ts", "utf8");
    expect(source.indexOf("normalizeXAccountPlanItem(planItem)")).toBeGreaterThan(source.indexOf("applyPlanOperations(currentPlan"));
    expect(source.indexOf("normalizeXAccountPlanItem(planItem)")).toBeLessThan(source.indexOf("createAndSaveManagedQuote("));
    // and the account plan keeps the sentence the plan itself writes after an edit, not the generic line that named the account like a sector
    expect(source).toContain("socialPlanSummaryAr(xPosts, primaryItem.params");
    expect(source.indexOf("socialPlanSummaryAr(xPosts")).toBeLessThan(source.indexOf("createAndSaveManagedQuote("));
  });
});

describe("the plan says what the account route does with a period", () => {
  const x = () => getSocialCapability("social-x-posts")!;
  const n = (value: number) => String(value);
  it("a window: the posts inside it are kept, the others skipped, fewer may arrive; without one only the no-topic note", () => {
    expect(xAccountNoteAr(x(), { channel: "@a", dateFrom: "2026-01-01", dateTo: "2026-06-01" })).toContain("ويُبقى منها ما نُشر من ١ يناير ٢٠٢٦ إلى ١ يونيو ٢٠٢٦ فقط");
    expect(xAccountNoteAr(x(), { channel: "@a" })).toBe("، كما نشرها الحساب دون تصفية بالموضوع");
    expect(xAccountNoteAr(x(), { channel: "@a", dateFrom: "2026-01-01" })).toContain("منذ ١ يناير ٢٠٢٦");
    expect(xAccountNoteAr(getSocialCapability("social-tiktok-videos")!, { channel: "@a", dateFrom: "2026-01-01" })).toBe("");
  });
  it("the topic search summary is untouched", () => {
    expect(socialPlanSummaryAr(x(), { query: "كرة السلة" }, 100, n)).toBe("سحب المنشورات على منصة إكس عن «كرة السلة»");
  });
});

describe("the relevance gate judges an X account's rows by who wrote them, never by topic words", () => {
  const gate = (row: Record<string, any>, params: Record<string, any>) => evaluateResearchRowRelevance(row, { capabilitySlug: "social-x-posts", endpointId: "anyapi.x.search.posts", params } as any);
  const ACCOUNT = { channel: "@elonmusk" };

  it("the tester's 12 rows: posts of the account that say nothing about the old topic are all accepted", () => {
    const texts = ["Starship flight 7 is go", "Haha true", "Grok 3 release soon", "Exactly", "Mars by 2030", "Wow", "Tesla update", "Nice", "X is the everything app", "Indeed", "Falcon 9 launch", "Yes"];
    const rows = texts.map((text, i) => ({ id: String(i), text, author_username: "elonmusk" }));
    expect(rows.map((row) => gate(row, ACCOUNT).decision)).toEqual(Array(12).fill("match"));
  });

  it("the SAME rows under the search shape the tester's plan had (a keyword beside the account) were rejected: the rule that rejected them, in its own words", () => {
    const strict = { channel: "@elonmusk", query: "@elonmusk و @BillGates" };
    expect(isXAccountRequest(strict)).toBe(false);
    const result = gate({ id: "1", text: "Starship flight 7 is go", author_username: "elonmusk" }, strict);
    expect(result.decision).toBe("no_match");
    expect(result.reasonAr).toBe("لا يتضمن نص السجل كلمات من موضوع البحث");
  });

  it("a post written by another account is not the account's post; a row that names no author is kept (it cannot be shown to be foreign)", () => {
    expect(gate({ id: "1", text: "hello", author_username: "BillGates" }, ACCOUNT)).toMatchObject({ decision: "no_match", reasonAr: "المنشور ليس من الحساب المطلوب" });
    expect(gate({ id: "2", text: "hello" }, ACCOUNT).decision).toBe("match");
    expect(gate({ id: "3", text: "hello", author_username: "ElonMusk" }, ACCOUNT).decision).toBe("match");
    expect(gate({ id: "4", text: "hello", author_username: "@elonmusk" }, { channel: "https://x.com/elonmusk" }).decision).toBe("match");
  });

  it("the author is read from the flat keys sources use and from an author object", () => {
    expect(postAuthorHandle({ screen_name: "Foo_1" })).toBe("foo_1");
    expect(postAuthorHandle({ author: { userName: "Bar" } })).toBe("bar");
    expect(postAuthorHandle({ user: { screen_name: "baz" } })).toBe("baz");
    expect(postAuthorHandle({ author: "Some Name With Spaces" })).toBeNull();
    expect(postAuthorHandle({})).toBeNull();
  });

  it("the topic search keeps its own rule (a post of a search is presumed on topic), and another service never takes the account rule", () => {
    expect(gate({ id: "1", text: "الذكاء الاصطناعي في التعليم", author_username: "someone" }, { query: "الذكاء الاصطناعي" }).decision).toBe("match");
    const other = evaluateResearchRowRelevance({ id: "1", text: "hello", author_username: "BillGates" }, { capabilitySlug: "social-facebook-posts", endpointId: "x", params: ACCOUNT } as any);
    expect(other.reasonAr).not.toBe("المنشور ليس من الحساب المطلوب");
  });
});

describe("the three counters of a job that ends with nothing delivered agree (the tester's job: 12 received, 5 not matching, 7 held)", () => {
  const PAGE_ONE = "الصفحة ١: استلمنا ٦ سجلات · الجديد ٠ · الإجمالي ٠ · غير مطابق ٥ · قيد المراجعة ١ · سبب التخطي: لا يتضمن نص السجل كلمات من موضوع البحث · الوقت المتوقع بحسب زمن الصفحات المسجل: نحو ١٢ ثانية";
  const excluded = (n: number) => Array.from({ length: n }, (_, i) => ({ text: `منشور ${i}`, _relevance_reason: "لا يتضمن نص السجل كلمات من موضوع البحث" }));
  const chunk1 = recordRowGate(emptyDiagnostic(), { received: 6, outsideWindow: 0, accepted: 0, excluded: excluded(5), held: 1, unreviewed: 0 });
  const chunk2 = recordRowGate(emptyDiagnostic(), { received: 6, outsideWindow: 0, accepted: 0, excluded: [], held: 6, unreviewed: 0 });
  const total = mergeDiagnostic(chunk1, chunk2);
  const PAGE_TWO = zeroDeliveryPageLineAr({ pageNumber: 2, receivedThisPage: 6, receivedSoFar: 12, dateExcluded: 0, notMatching: 0, underReview: 6, unreviewed: 0 });

  it("the closing page line carries the labels the panel adds up, in the same shape as the first page's line", () => {
    expect(PAGE_TWO).toBe("الصفحة ٢: استلمنا ٦ سجلات · المستلم حتى الآن ١٢ · الجديد ٠ · قيد المراجعة ٦");
    expect(zeroDeliveryPageLineAr({ pageNumber: 1, receivedThisPage: 1, receivedSoFar: null, dateExcluded: 2, notMatching: 3, underReview: 0, unreviewed: 4 })).toBe("الصفحة ١: استلمنا سجل واحد · الجديد ٠ · خارج الفترة ٢ · غير مطابق ٣ · غير مراجَع ٤");
  });

  it("top counter (the panel), the message and the job's own line all say 7 held and 12 received", () => {
    const panel = summarizeActivityCounts([{ textAr: PAGE_ONE }, { textAr: PAGE_TWO }]);
    expect(panel.underReview).toBe(7);
    expect(panel.received).toBe(12);
    const messageHeld = heldToReport(total, 6); // the last page held 6; the job held 7: the sentence says the job's
    expect(messageHeld).toBe(7);
    expect(total.rows.held).toBe(7);
    expect(zeroDeliveryEventAr(total)).toContain("وأُحيل ٧ إلى المراجعة ولم يُحتسب");
    expect(new Set([panel.underReview, messageHeld, total.rows.held]).size).toBe(1);
  });

  it("before the fix the closing line had no label, so the panel read 1: the old line, recomputed", () => {
    const oldPageTwo = "الصفحة ٢: استلمنا ٦ سجلات · المستلم حتى الآن ١٢ · الجديد ٠";
    expect(summarizeActivityCounts([{ textAr: PAGE_ONE }, { textAr: oldPageTwo }]).underReview).toBe(1);
  });

  it("the sentence never says fewer than the page it ends on, and a missing record falls back to that page", () => {
    expect(heldToReport(null, 6)).toBe(6);
    expect(heldToReport(undefined, 0)).toBe(0);
    expect(heldToReport(chunk1, 4)).toBe(4);
  });

  it("the worker route builds its closing line and its sentence from these (read from its source)", () => {
    const source = readFileSync("src/app/api/worker/chunk/route.ts", "utf8");
    expect(source).toContain("zeroDeliveryPageLineAr({");
    expect(source).toContain("const heldShown = heldToReport(diagnosticTotal, uncertainRows.length);");
    expect(source).not.toContain("(أُحيل ${toArabicDigits(uncertainRows.length)} إلى المراجعة ولم يُحتسب)");
  });
});

describe("a plan is never shown at the price of another service", () => {
  const plan = { type: "propose_plan", capabilities: [] };

  it("the exact plan item of failure 1 (a post-comments service priced per call, with an invented post id) is an incomplete plan: it cannot be quoted", () => {
    const item = { capabilitySlug: "tikhub-x-twitter-web-fetch-post-comments", endpointId: "tikhub.x.twitter-web-fetch-post-comments", params: { dateTo: "2026-06-01", country: "Saudi Arabia", dateFrom: "2026-01-01", location: "Saudi Arabia", tweet_id: "<UNKNOWN>" }, targetVolumeMax: 400 };
    expect(quoteScopeGaps([item])).toContain("placeholder");
    expect(quoteScopeGaps([{ ...item, params: { ...item.params, tweet_id: "1234567890123456789" } }])).not.toContain("placeholder");
  });

  it("an X request whose final plan holds any service other than ours is refused once, with nothing held; ours and other platforms pass untouched", () => {
    const refused = routeUnavailablePlatformRequest(plan, FAILURE_1, [{ capabilitySlug: "tikhub-x-twitter-web-fetch-post-comments" }]);
    expect(refused).toEqual({ type: "refuse", reasonAr: X_REQUEST_NOT_SERVED_AR });
    CUSTOMER_TEXT_RULES(X_REQUEST_NOT_SERVED_AR);
    expect(routeUnavailablePlatformRequest(plan, "هات منشورات عن الصحة على إكس", [{ capabilitySlug: "social-x-posts" }])).toBe(plan);
    expect(routeUnavailablePlatformRequest(plan, "هات تعليقات يوتيوب عن الصحة", [{ capabilitySlug: "social-youtube-comments" }])).toBe(plan);
    expect(routeUnavailablePlatformRequest(plan, "هات منشورات عن الصحة على إكس")).toBe(plan);
  });

  it("every new customer sentence is Arabic only (the platform's own name apart), has no markdown, emoji, amounts or provider names, and holds nothing", () => {
    for (const text of [X_COMMENTS_UNAVAILABLE_AR, X_ONE_ACCOUNT_AR, X_REQUEST_NOT_SERVED_AR, X_ACCOUNT_EDIT_AR]) CUSTOMER_TEXT_RULES(text);
    for (const text of [X_COMMENTS_UNAVAILABLE_AR, X_ONE_ACCOUNT_AR, X_REQUEST_NOT_SERVED_AR]) expect(text).toContain("لم يُحجز أي رصيد");
    for (const text of [X_COMMENTS_UNAVAILABLE_AR, X_ONE_ACCOUNT_AR, X_REQUEST_NOT_SERVED_AR, X_ACCOUNT_EDIT_AR]) expect(text).not.toContain("حجز مؤقت");
  });
});
