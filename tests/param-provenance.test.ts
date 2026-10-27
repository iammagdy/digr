import { describe, expect, it, vi } from "vitest";
import { ChatHandler } from "../src/functions/shared/chatHandler";
import { clearBriefCacheForTesting } from "../src/functions/shared/briefManager";
import { createChatDb } from "./helpers/chatSession";
import { comparableValue, findParamProvenanceGaps, isIdLikeParamName, isStepReference, looksLikePlaceholder, provenanceQuestionAr, valueIsInText } from "../src/lib/paramProvenance";
import { quoteScopeGaps } from "../src/lib/quoteScopeGaps";

describe("placeholders: a rule about the SHAPE, not a closed list", () => {
  it.each([
    "<UNKNOWN>", "<unknown>", "<tweet_id>", "<TBD>", "[ID]", "[tweet id]", "{{tweet_id}}", "{tweet_id}", "(value)", "UNKNOWN", "unknown", "N/A", "n/a", "TBD", "null", "undefined",
    "placeholder", "xxx", "XXXXXX", "...", "…", "---", "https://x.com/<handle>/status/<id>", "https://x.com/i/status/${id}",
  ])("%s is a placeholder", (value) => {
    expect(looksLikePlaceholder(value)).toBe(true);
  });

  it.each(["1234567890123456789", "elonmusk", "@SaudiMOH", "https://x.com/SaudiMOH/status/1", "كرة القدم", "(بيتكوين)", "none of your business", "test", "id"])("%s is NOT a placeholder by shape", (value) => {
    expect(looksLikePlaceholder(value)).toBe(false);
  });

  it("the plan scope check refuses every placeholder shape, not only the angle-bracket words it knew", () => {
    for (const value of ["<UNKNOWN>", "[ID]", "{{tweet_id}}", "UNKNOWN", "xxx"]) {
      expect(quoteScopeGaps([{ capabilitySlug: "social-x-posts", params: { channel: value } }])).toContain("placeholder");
    }
  });
});

describe("which parameters name a thing the customer must have pointed at", () => {
  it.each(["tweet_id", "tweetId", "postUrl", "post_url", "video-url", "aweme_id", "uniqueId", "username", "handle", "permalink", "link", "channel", "channels", "secUid", "videoIds"])("%s is id-like", (name) => {
    expect(isIdLikeParamName(name)).toBe(true);
  });
  it.each(["query", "limit", "cursor", "dateFrom", "country", "topPerChannel", "maxPages", "perVideo", "valid", "paid", "language", "topic"])("%s is not", (name) => {
    expect(isIdLikeParamName(name)).toBe(false);
  });
});

describe("the origin of a value", () => {
  const TEXT = "هات لي منشورات حساب @SaudiMOH وهذا المنشور https://www.facebook.com/youm7/posts/1234567890123 وفيديو https://www.youtube.com/watch?v=dQw4w9WgXcQ";

  it("a value written by the customer is accepted, with or without «@», scheme, «www.», query or a trailing slash", () => {
    for (const v of ["@SaudiMOH", "SaudiMOH", "saudimoh", "https://www.facebook.com/youm7/posts/1234567890123", "facebook.com/youm7/posts/1234567890123/", "https://m.facebook.com/youm7/posts/1234567890123?ref=x", "dQw4w9WgXcQ"]) {
      expect(valueIsInText(v, TEXT), v).toBe(true);
    }
  });

  it("the id inside a link written another way is found by its long digits", () => {
    expect(valueIsInText("https://www.facebook.com/story.php?story_fbid=1234567890123", TEXT)).toBe(true);
  });

  it("Arabic and digits are compared folded (hamza, ta marbuta, Arabic-Indic digits)", () => {
    expect(valueIsInText("حساب الأخبار ٢٤", "هات منشورات حساب الاخبار 24")).toBe(true);
    expect(comparableValue("https://www.X.com/Name/")).toBe("x.com/name");
  });

  it("a value the customer never wrote is not found", () => {
    expect(valueIsInText("2101118004087886212", TEXT)).toBe(false);
    expect(valueIsInText("elonmusk", TEXT)).toBe(false);
  });

  it("references to an earlier step", () => {
    for (const ref of ["from_step_1", "$step1.postUrl", "{{step1.url}}", "step1.output.url"]) expect(isStepReference(ref)).toBe(true);
    for (const text of ["https://x.com/a", "elonmusk", ""]) expect(isStepReference(text)).toBe(false);
  });
});

describe("findParamProvenanceGaps", () => {
  const ask = "هات لي منشورات حساب @SaudiMOH";

  it("the live failure: a comments item with «<UNKNOWN>» as the tweet id is a placeholder gap", () => {
    const gaps = findParamProvenanceGaps([{ params: { tweet_id: "<UNKNOWN>", country: "Saudi Arabia" } }], { requestText: ask });
    expect(gaps).toEqual([{ itemIndex: 0, param: "tweet_id", reason: "placeholder", kind: "id" }]);
  });

  it("a PLAUSIBLE invented id (the number the old list let through) is a gap too: it is not in the customer's words", () => {
    const gaps = findParamProvenanceGaps([{ params: { tweet_id: "1234567890123456789" } }], { requestText: ask });
    expect(gaps).toEqual([{ itemIndex: 0, param: "tweet_id", reason: "not_from_customer", kind: "id" }]);
  });

  it("the account the customer wrote passes, in the account param of an X account plan", () => {
    expect(findParamProvenanceGaps([{ params: { channel: "@SaudiMOH", dateFrom: "2026-01-01" } }], { requestText: ask })).toEqual([]);
  });

  it("a link the model made up is a gap; the customer's own link passes", () => {
    expect(findParamProvenanceGaps([{ params: { postUrl: "https://www.facebook.com/post/999" } }], { requestText: ask })).toHaveLength(1);
    expect(findParamProvenanceGaps([{ params: { postUrl: "https://www.facebook.com/youm7/posts/1234567890123" } }], { requestText: "حلل https://www.facebook.com/youm7/posts/1234567890123" })).toEqual([]);
  });

  it("a literal the code set is accepted (and only that one)", () => {
    expect(findParamProvenanceGaps([{ params: { username: "public_user" } }], { requestText: ask, literals: ["public_user"] })).toEqual([]);
    expect(findParamProvenanceGaps([{ params: { username: "other_user" } }], { requestText: ask, literals: ["public_user"] })).toHaveLength(1);
  });

  it("a reference to an earlier step is accepted only in a step that depends on one", () => {
    expect(findParamProvenanceGaps([{ params: {} }, { params: { postUrl: "from_step_1" }, dependsOn: ["s1"] }], { requestText: ask })).toEqual([]);
    const dangling = findParamProvenanceGaps([{ params: { postUrl: "from_step_1" } }], { requestText: ask });
    expect(dangling).toEqual([{ itemIndex: 0, param: "postUrl", reason: "dangling_reference", kind: "link" }]);
  });

  it("an empty value is not an invented one (the required-field check owns it); counts, dates and queries are never checked", () => {
    expect(findParamProvenanceGaps([{ params: { tweet_id: "", query: "الصحة", limit: 400, dateFrom: "2026-01-01", topPerChannel: 3 } }], { requestText: "" })).toEqual([]);
  });

  it("every value of a list is checked (channels)", () => {
    const gaps = findParamProvenanceGaps([{ params: { channels: ["@SaudiMOH", "@NotMentioned"] } }], { requestText: ask });
    expect(gaps.map((g) => g.param)).toEqual(["channels"]);
    expect(gaps).toHaveLength(1);
  });

  it("the question is Arabic only, with no field name and no provider word", () => {
    for (const kind of ["link", "account", "id"] as const) {
      const q = provenanceQuestionAr({ kind });
      expect(q).not.toMatch(/[A-Za-z]/);
      expect(q).not.toMatch(/\p{Extended_Pictographic}/u);
      expect(q).not.toMatch(/treg|anyapi|tikhub|endpoint|_/i);
    }
  });
});

describe("in the chat: a value the model invented is never planned, never priced", () => {
  async function chatWithModelPlan(item: Record<string, any>, message: string) {
    const db: any = createChatDb();
    const handler = new ChatHandler(db);
    const plan = { type: "propose_plan", summaryAr: "خطة", conversationTitle: "طلب", capabilities: [{ stepId: "s1", targetVolumeMin: 1, targetVolumeMax: 10, paginationStrategy: "cursor", ...item }], outputFormats: ["xlsx"] };
    (handler as any).llm.executeTurn = vi.fn(async () => ({ output: plan, inputTokens: 10, outputTokens: 10, costUsd: 0, model: "fake", promptVersion: "x" }));
    await db.createRow({ tableId: "conversations", rowId: "conv_pp", data: { userId: "user_pp", title: "محادثة جديدة", status: "active", totalTokens: 0 } });
    clearBriefCacheForTesting();
    const r: any = await handler.handleUserMessage({ userId: "user_pp", conversationId: "conv_pp", message, userBalance: 20000 });
    return { r, db };
  }

  it.each(["<UNKNOWN>", "UNKNOWN", "[ID]", "https://www.instagram.com/p/INVENTED99/"])("a post link «%s» the customer never wrote: ONE plain question, no plan, no quote, no build failure", async (value) => {
    const { r, db } = await chatWithModelPlan({ capabilitySlug: "instagram-comments", endpointId: "internal-instagram-comments", params: { postUrl: value } }, "عايز ١٠ تعليقات من بوست على انستجرام");
    expect(r.outputType).toBe("ask_clarification");
    expect(r.clarificationItems.map((q: any) => q.id)).toEqual(["plan_param_required"]);
    expect(r.clarificationItems[0].text).toBe(provenanceQuestionAr({ kind: "link" }));
    expect(r.planQuote).toBeUndefined();
    expect(db.store.get("plans_quotes") ?? []).toEqual([]);
    expect(String(r.contentAr)).not.toMatch(/plan_build_failed|الخطة غير مكتملة/);
  });

  it("the same plan with the link the customer pasted is planned", async () => {
    const link = "https://www.instagram.com/p/Cx1y2z3AbCd/";
    const { r } = await chatWithModelPlan({ capabilitySlug: "instagram-comments", endpointId: "internal-instagram-comments", params: { postUrl: link } }, `عايز ١٠ تعليقات من بوست انستجرام ${link}`);
    expect(r.clarificationItems?.map((q: any) => q.id) ?? []).not.toContain("plan_param_required");
  });
});
