import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The first live run of the Facebook keyword mission (2026-10-24): what failed and why, one test group per cause. FAKE review models and fixtures only: nothing here
 * calls a provider or a model, and what a real model answers to the post prompt is NOT proven by any of it.
 */
const state = vi.hoisted(() => ({ user: null as any, files: new Map<string, string>(), reads: [] as string[] }));
vi.mock("../src/lib/supabase/server", () => ({
  createServerSideClient: vi.fn(async () => ({ auth: { getUser: vi.fn(async () => ({ data: { user: state.user }, error: null })) } })),
  createAdminClient: vi.fn(() => ({
    storage: { from: () => ({ download: async (p: string) => { state.reads.push(p); const text = state.files.get(p); return text ? { data: new Blob([text]), error: null } : { data: null, error: { message: "missing" } }; } }) },
    from: () => { const b: any = { select: () => b, eq: () => b, insert: async () => ({}), maybeSingle: async () => ({ data: null }) }; return b; },
  })),
}));

import { understandMission } from "../src/lib/consultantCopy";
import { cleanSocialTopicAr, perItemCommentCount, socialSubjectText, stripPerItemPhrases } from "../src/lib/socialTasks";
import { readSocialFacts, socialDiscoveryItems, socialDiscoveryTrigger } from "../src/lib/socialDiscoveryCard";
import { evaluateResearchRowRelevance } from "../src/lib/server/researchRelevanceGate";
import { callClaudeRowAdvisor, SOCIAL_BROAD_TOPIC_RULE, SOCIAL_NOT_A_MATCH_RULE } from "../src/lib/server/rowReviewAdvisor";
import { resetProviderKeyCache } from "../src/lib/server/providerKeys";
import { POST_OFF_TOPIC_REASON_AR, POST_ON_TOPIC_REASON_AR, POST_UNREVIEWED_REASON_AR, VIDEO_UNREVIEWED_REASON_AR, judgeVideos, selectionKindFor, videoSelectionEventAr, type VideoJudgement } from "../src/lib/server/videoRelevance";
import { buildLivePreviewSample, postSelectionFromEvents, previewCountsLineAr } from "../src/lib/liveJobView";
import ActivityTerminal from "../src/app/dashboard/chat/components/ActivityTerminal";
import { emptyDiagnostic, mergeDiagnostic, recordPostJudgements, recordRowGate, saveStepDiagnostic, readDiagnosticFile, totalDiagnostic, zeroDeliveryEventAr, DIAGNOSTIC_SAMPLE_LIMIT } from "../src/lib/server/zeroDeliveryDiagnostic";
import { GET as diagnosticGet } from "../src/app/api/admin/job-diagnostic/route";

const LIVE_REQUEST = "هات ٥ بوستات عن الترندات الصحية على فيسبوك في مصر وكل بوست معاه ٥ تعليقات";
const LIVE_ANSWER = "٥ بوستات، وكل بوست معاه ٥ تعليقات";

describe("B: the topic is the subject, never a fragment of the per-post phrase", () => {
  it("the exact live request: subject, posts, comments per post and the topic the plan shows", () => {
    const u = understandMission(LIVE_REQUEST);
    expect(u.subject).toBe("الترندات الصحية");
    expect(u.videos).toBe(5);
    expect(u.commentsPerVideo).toBe(5);
    expect(u.impliedVolume).toBe(25);
    expect(socialSubjectText(LIVE_REQUEST)).toBe("الترندات الصحية");
    expect(cleanSocialTopicAr(LIVE_REQUEST)).toBe("الترندات الصحية في مصر");
  });

  it("the answer alone says no subject (it is not a topic), and the request followed by the answer keeps the clean topic", () => {
    expect(socialSubjectText(LIVE_ANSWER)).toBe("");
    const joined = `هات ٥ بوستات وتعليقاتهم عن الترندات الصحية على فيسبوك في مصر ${LIVE_ANSWER}`;
    expect(socialSubjectText(joined)).toBe("الترندات الصحية");
    expect(understandMission(joined).commentsPerVideo).toBe(5);
  });

  it("every word order of the per-post phrase is cut out of the topic and read as the count", () => {
    const phrases: Array<[string, number]> = [
      ["وكل بوست معاه ٥ تعليقات", 5], ["وكل بوست فيه ٥ تعليقات", 5], ["كل منشور عليه ٧ تعليقات", 7], ["وكل بوست ٥ تعليقات", 5], ["٥ تعليقات لكل بوست", 5],
      ["ومعاها ٥ تعليقات لكل منشور", 5], ["بخمس تعليقات لكل بوست", 5], ["٢٠ تعليق من كل منشور", 20], ["٣ كومنتات في كل بوست", 3], ["وكل بوست يكون معاه ١٠ كومنتات", 10],
    ];
    for (const [phrase, count] of phrases) {
      const text = `هات ٥ بوستات عن الترندات الصحية على فيسبوك في مصر ${phrase}`;
      expect(perItemCommentCount(text), phrase).toBe(count);
      expect(socialSubjectText(text), phrase).toBe("الترندات الصحية");
      expect(stripPerItemPhrases(text), phrase).not.toMatch(/تعليق|كومنت/);
    }
  });

  it("a sentence with no per-post phrase is untouched, and a number that is not a per-post count is not read as one", () => {
    expect(stripPerItemPhrases("هات ٥ بوستات عن الترندات الصحية")).toBe("هات 5 بوستات عن الترندات الصحية");
    expect(perItemCommentCount("هات ٥ بوستات عن الترندات الصحية")).toBeNull();
    expect(perItemCommentCount("هات ٥٠٠ تعليق عن الترندات الصحية")).toBeNull();
    expect(perItemCommentCount("كل بوست فيه تعليقات كتير")).toBeNull();
  });

  it("the old reading stays: «٥٠ تعليق لكل فيديو» on TikTok, and an English count", () => {
    const u = understandMission("هات ٣ فيديوهات تيك توك عن كرة السلة بـ ٥٠ تعليق لكل فيديو");
    expect(u.videos).toBe(3);
    expect(u.commentsPerVideo).toBe(50);
    expect(understandMission("30 comments about football on youtube").volume).toBe(30);
  });
});

describe("A: what is already written is never asked again", () => {
  it("the per-post count inside the sentence answers the question: the card has nothing to ask about it", () => {
    expect(readSocialFacts(LIVE_REQUEST).commentsPerPost).toBe(5);
    expect(readSocialFacts(LIVE_REQUEST).postsCount).toBe(5);
    for (const context of [{}, { otherFacebookService: true }]) {
      expect(socialDiscoveryItems(LIVE_REQUEST, context).map((q) => q.id)).not.toContain("social_comments_per_post");
      expect(socialDiscoveryItems(LIVE_REQUEST, context).map((q) => q.id)).not.toContain("social_posts_count_required");
    }
  });

  it("the typed answer folded after the request gives the same facts, so the question is gone", () => {
    const folded = `هات ٥ بوستات وتعليقاتهم عن الترندات الصحية على فيسبوك في مصر ${LIVE_ANSWER}`;
    expect(readSocialFacts(folded).commentsPerPost).toBe(5);
    expect(socialDiscoveryItems(folded, { otherFacebookService: true }).map((q) => q.id)).not.toContain("social_comments_per_post");
    // without the answer the question is still asked
    expect(socialDiscoveryItems("هات ٥ بوستات وتعليقاتهم عن الترندات الصحية على فيسبوك في مصر", { otherFacebookService: true }).map((q) => q.id)).toContain("social_comments_per_post");
    expect(socialDiscoveryTrigger("هات ٥ بوستات وتعليقاتهم عن الترندات الصحية على فيسبوك في مصر", { otherFacebookService: true })).not.toBeNull();
  });
});

describe("C: how the relevance gate judges the comments of a Facebook keyword job", () => {
  const params = { query: "الترندات الصحية", region: "EG", perVideo: 5, videoCount: 5 };
  const under = (post: string, text: string) => ({ comment_id: "c1", text, video_title: post, video_url: "https://www.facebook.com/p/1", post_text: post });
  const gate = (slug: string, row: Record<string, any>, p: Record<string, any> = params) => evaluateResearchRowRelevance(row, { capabilitySlug: slug, endpointId: slug, params: p } as any);
  const HEALTH_POST = "نصائح لتغذية صحية للأطفال في المدارس وأثرها على التركيز";

  it("a comment under an adopted post is accepted although neither it nor its post repeats the topic's words (the live failure: 0 of 25)", () => {
    for (const text of ["معلومة مفيدة جدًا شكرًا لكم", "ابني بيحب الخضار بعد ما جربت الطريقة دي", "هل هذا مناسب لعمر ست سنوات؟"]) {
      expect(gate("social-facebook-keyword-comments", under(HEALTH_POST, text)).decision, text).toBe("match");
    }
  });

  it("OWNER DECISION: only an empty comment and a bare link stay out; an ad text, a supplication and a two-letter reaction are comments and are kept", () => {
    const slug = "social-facebook-keyword-comments";
    expect(gate(slug, under(HEALTH_POST, "اطلب الآن واتساب خصم خاص ٥٠٪ https://shop.example.test/x")).decision).toBe("match");
    expect(gate(slug, under(HEALTH_POST, "https://shop.example.test/x")).decision).toBe("no_match");
    expect(gate(slug, under(HEALTH_POST, "اللهم ارحمنا وارحم موتانا")).decision).toBe("match");
    expect(gate(slug, under(HEALTH_POST, "ok")).decision).toBe("match");
    expect(gate(slug, under(HEALTH_POST, "")).decision).toBe("no_match");
  });

  it("a comment that names another country in its row metadata is still out of the requested country", () => {
    expect(gate("social-facebook-keyword-comments", { ...under(HEALTH_POST, "معلومة مفيدة جدًا"), country: "Germany" }).decision).toBe("no_match");
  });

  it("NO OTHER SERVICE IS LOOSENED: the same comment, with the same topic search, under the Facebook page-comments service and other platforms is still judged by the strict rule", () => {
    for (const slug of ["social-facebook-comments", "social-instagram-comments", "social-reddit-comments"]) {
      expect(gate(slug, under(HEALTH_POST, "معلومة مفيدة جدًا شكرًا لكم")).decision, slug).not.toBe("match");
    }
    // and the presumption is exactly the four topic-search slugs of the gate's own list
    const source = readFileSync("src/lib/server/researchRelevanceGate.ts", "utf8");
    expect(source).toContain("social-(?:x-posts|tiktok-comments|youtube-comments|facebook-keyword-comments)");
  });
});

describe("C: the review of the Facebook posts has its own prompt, and the video prompt is untouched", () => {
  const originalFetch = globalThis.fetch;
  const saved = { key: process.env.ANTHROPIC_API_KEY, provider: process.env.LLM_PROVIDER, enabled: process.env.LLM_ENABLED, live: process.env.LLM_LIVE };
  beforeEach(() => { process.env.ANTHROPIC_API_KEY = "test-anthropic-key"; delete process.env.LLM_PROVIDER; delete process.env.LLM_ENABLED; delete process.env.LLM_LIVE; resetProviderKeyCache(); });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const [name, value] of [["ANTHROPIC_API_KEY", saved.key], ["LLM_PROVIDER", saved.provider], ["LLM_ENABLED", saved.enabled], ["LLM_LIVE", saved.live]] as const) { if (value === undefined) delete (process.env as any)[name]; else (process.env as any)[name] = value; }
    resetProviderKeyCache();
  });
  const promptFor = async (kind: string) => {
    const bodies: any[] = [];
    globalThis.fetch = vi.fn(async (_url: any, init: any) => { bodies.push(JSON.parse(init.body)); return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: "{\"reviews\":[{\"index\":0,\"verdict\":\"match\"}]}" }], stop_reason: "end_turn", usage: { input_tokens: 900, output_tokens: 30 } }) } as any; });
    await callClaudeRowAdvisor({ customerRequest: "الترندات الصحية", kind, rows: [{ index: 0, row: { title: "نصائح لتغذية صحية للأطفال" } }] });
    return String(bodies[0].messages[0].content);
  };

  it("the post prompt talks about POSTS, matches the subject AREA of a broad topic, keeps the ad / passing-mention exclusions, and holds nothing about a video", async () => {
    const prompt = await promptFor("social-facebook-keyword-comments-post-list");
    expect(prompt).toContain("Each row is a POST found by a keyword search on Facebook");
    expect(prompt).toContain("or about the subject area the topic names");
    expect(prompt).toContain("does NOT have to repeat the words of the request");
    expect(prompt).toContain(SOCIAL_NOT_A_MATCH_RULE);
    expect(prompt).toContain("a post that names no country at all is judged by its topic alone");
    expect(prompt).not.toMatch(/VIDEO|video/);
    // the «hold a doubtful row» rule of the generic prompt is what turned a broad topic into zero: the post list asks for «uncertain» only when the subject cannot be told
    expect(prompt).not.toContain(SOCIAL_BROAD_TOPIC_RULE);
    expect(prompt).toContain("Answer \"uncertain\" only when you cannot tell what the post is about");
    expect(prompt).toContain("{\"reviews\":[{\"index\":0,\"verdict\"");
  });

  it("the video prompt (TikTok, YouTube) is byte-for-byte what it was: it still talks about videos and does not get the field rule", async () => {
    const prompt = await promptFor("social-tiktok-comments-video-list");
    expect(prompt).toContain("Each row is a VIDEO found by a topic search");
    expect(prompt).not.toContain("subject area the topic names");
    expect(prompt).not.toContain("does NOT have to repeat the words");
  });

  it("the kind carries the unit: «…-post-list» for posts, «…-video-list» otherwise", () => {
    expect(selectionKindFor("social-facebook-keyword-comments", "post")).toBe("social-facebook-keyword-comments-post-list");
    expect(selectionKindFor("social-youtube-comments")).toBe("social-youtube-comments-video-list");
  });
});

describe("C: the wording says posts for posts and keeps videos for videos", () => {
  const judgement = (decision: VideoJudgement["decision"], reasonAr = "") => ({ decision, reasonAr, by: "review" as const });
  it("the activity line of a post list", () => {
    const line = videoSelectionEventAr([judgement("match"), judgement("match"), judgement("no_match", POST_OFF_TOPIC_REASON_AR), judgement("uncertain")], { unit: "post", carried: true });
    expect(line).toBe("راجعنا منشورات هذه القائمة: اعتمدنا ٢ منها، واستبعدنا ١ لأنها لا تتناول موضوعك (المنشور لا يتناول موضوع طلبك)، وسنقرأ تعليقات ١ للتحقق من موضوعها.");
    expect(line).not.toMatch(/فيديو/);
  });

  it("the video line is unchanged", () => {
    expect(videoSelectionEventAr([judgement("match"), judgement("no_match", "الفيديو لا يتناول موضوع طلبك")])).toBe("راجعنا فيديوهات هذه الصفحة: اعتمدنا ١ فيديو، واستبعدنا ١ لأنها لا تتناول موضوعك (الفيديو لا يتناول موضوع طلبك).");
  });

  it("the reasons of a post judged by its own text or not reviewed say «المنشور»", async () => {
    const advisor = async (input: any) => ({ verdicts: new Map<number, any>(), usage: undefined, failure: null as any, rows: input.rows });
    const out = await judgeVideos({
      advisor: advisor as any, customerRequest: "الترندات الصحية", kind: "social-facebook-keyword-comments-post-list", unit: "post",
      videos: [{ key: "a", title: "الترندات الصحية الجديدة في مصر", channel: "", rowIndexes: [0], sampleComments: [] }, { key: "b", title: "نصائح لتغذية صحية", channel: "", rowIndexes: [1], sampleComments: [] }],
      request: { query: "الترندات الصحية", region: "EG" }, budgetUsd: 1,
    });
    expect(out.judgements.get("a")).toEqual({ decision: "match", reasonAr: POST_ON_TOPIC_REASON_AR, by: "evidence" });
    expect(out.judgements.get("b")?.reasonAr).toBe(POST_UNREVIEWED_REASON_AR);
    expect(POST_UNREVIEWED_REASON_AR).not.toBe(VIDEO_UNREVIEWED_REASON_AR);
    for (const text of [POST_ON_TOPIC_REASON_AR, POST_OFF_TOPIC_REASON_AR, POST_UNREVIEWED_REASON_AR]) expect(text).not.toMatch(/فيديو|[A-Za-z]/);
  });
});

describe("live preview: every count that is known is shown, a zero included", () => {
  const PAGE = "الصفحة ١: استلمنا ١٣ سجل · الجديد ٠ · مكرر أو مستبعد ٠ · قيد المراجعة ٠";
  const SELECTION = "راجعنا منشورات هذه القائمة: اعتمدنا ٧ منها، واستبعدنا ١ لأنها لا تتناول موضوعك (المنشور لا يتناول موضوع طلبك).";

  it("the counts line", () => {
    expect(previewCountsLineAr({ accepted: 0, requested: 25, received: 13, underReview: 0, posts: { adopted: 7, excluded: 1 } })).toBe("المقبول حتى الآن ٠ من ٢٥ · المنشورات المعتمدة ٧، المستبعدة ١ · استلمنا ١٣ · قيد المراجعة ٠");
    expect(previewCountsLineAr({ accepted: 3, requested: 50, received: null, underReview: null })).toBe("المقبول حتى الآن ٣ من ٥٠");
  });

  it("the selection lines of the run are summed, and a run with none gives null", () => {
    expect(postSelectionFromEvents([{ textAr: SELECTION }, { textAr: "راجعنا منشورات هذه القائمة: اعتمدنا ٣ منها، وسنقرأ تعليقات ٢ للتحقق من موضوعها." }])).toEqual({ adopted: 10, excluded: 1 });
    expect(postSelectionFromEvents([{ textAr: PAGE }])).toBeNull();
    expect(postSelectionFromEvents(undefined)).toBeNull();
  });

  it("the running panel shows zero accepted with the post counts and the review count, and no row table", () => {
    const events = [{ $id: "1", kind: "info", textAr: SELECTION, createdAt: "2026-10-24T03:01:00Z" }, { $id: "2", kind: "progress", textAr: PAGE, createdAt: "2026-10-24T03:02:00Z" }] as any[];
    const html = renderToStaticMarkup(createElement(ActivityTerminal as any, { status: "running", events, rowsCollected: 0, requestedRows: 25, reservedPoints: 372, preview: null }));
    const text = html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
    expect(html).toContain('data-testid="live-preview-waiting"');
    expect(html).not.toContain("live-preview-table");
    expect(text).toContain("المقبول حتى الآن ٠ من ٢٥ · المنشورات المعتمدة ٧، المستبعدة ١ · استلمنا ١٣ · قيد المراجعة ٠");
    expect(buildLivePreviewSample([], ["text"], false)).toBeNull();
  });
});

describe("the diagnostic of a job that ended with nothing", () => {
  const posts = Array.from({ length: 8 }, (_, i) => ({ text: `منشور ${i} عن موضوع آخر ${"طويل ".repeat(60)} https://example.test/p/${i} واتصل ٠١٢٣٤٥٦٧٨٩٠١`, decision: "no_match" as const, by: "review" as const, reasonAr: POST_OFF_TOPIC_REASON_AR }));

  it("the customer line: counts per reason, Arabic, Arabic-Indic digits, no source name, no amount, no text of any post", () => {
    const d = emptyDiagnostic();
    recordPostJudgements(d, [...posts.slice(0, 1), { text: "ا", decision: "match", by: "evidence", reasonAr: "" }, { text: "ب", decision: "uncertain", by: "review", reasonAr: "" }]);
    recordRowGate(d, { received: 13, outsideWindow: 3, accepted: 0, excluded: [{ text: "ممتاز", _relevance_reason: "لا يتضمن نص السجل كلمات من موضوع البحث" }, { text: "رائع", _relevance_reason: "لا يتضمن نص السجل كلمات من موضوع البحث" }, { text: "x", _relevance_reason: "النطاق الجغرافي في السجل لا يطابق الدولة المطلوبة" }], held: 2, unreviewed: 0 });
    const line = zeroDeliveryEventAr(d)!;
    expect(line).toBe("لم يُسلَّم شيء، وهذا ما حدث: راجعنا ٣ منشورات: اعتمدنا ١، واستبعدنا ١ لأنها لا تتناول موضوعك، وأحلنا ١ إلى المراجعة. ثم فحصنا ١٠ سجلات: قُبل ٠، واستُبعد ٣ (٢ لا تذكر موضوع بحثك، ١ خارج الدولة المطلوبة)، وأُحيل ٢ إلى المراجعة ولم يُحتسب، وخرج ٣ عن الفترة المطلوبة.");
    expect(line).not.toMatch(/[A-Za-z0-9]/);
    expect(line).not.toMatch(/\p{Extended_Pictographic}|[#*_`]/u);
  });

  it("nothing judged, nothing to say", () => {
    expect(zeroDeliveryEventAr(emptyDiagnostic())).toBeNull();
  });

  it("the owner's sample: at most five posts and five rows, cut to 140 characters, links and numbers masked", () => {
    const d = recordRowGate(recordPostJudgements(emptyDiagnostic(), posts), { received: 12, outsideWindow: 0, accepted: 0, excluded: posts.map((p) => ({ text: p.text, _relevance_reason: "لا يتضمن نص السجل كلمات من موضوع البحث" })), held: 0, unreviewed: 0 });
    expect(d.samples.posts).toHaveLength(DIAGNOSTIC_SAMPLE_LIMIT);
    expect(d.samples.rows).toHaveLength(DIAGNOSTIC_SAMPLE_LIMIT);
    for (const sample of [...d.samples.posts, ...d.samples.rows]) {
      expect(sample.text.length).toBeLessThanOrEqual(140);
      expect(sample.text).not.toContain("example.test/p");
      expect(sample.text).not.toMatch(/٠١٢٣٤٥٦٧٨٩٠١|01234567890/);
    }
    expect(d.posts.excluded).toBe(8);
  });

  it("a chunk that runs twice replaces its own entry: nothing is counted twice", async () => {
    const files = new Map<string, Buffer>();
    const store = { download: async (p: string) => (files.has(p) ? { data: new Blob([new Uint8Array(files.get(p)!)]) } : { data: null }), upload: async (p: string, body: Buffer) => { files.set(p, body); return {}; } };
    const chunk = recordPostJudgements(emptyDiagnostic(), posts.slice(0, 3));
    await saveStepDiagnostic(store, "job_x1234567", 0, chunk);
    await saveStepDiagnostic(store, "job_x1234567", 0, chunk);
    const total = await saveStepDiagnostic(store, "job_x1234567", 1, recordPostJudgements(emptyDiagnostic(), posts.slice(3, 5)));
    expect(total.posts.judged).toBe(5);
    expect(totalDiagnostic(await readDiagnosticFile(store, "job_x1234567")).posts.excluded).toBe(5);
    expect(mergeDiagnostic(null, chunk).posts.judged).toBe(3);
  });
});

describe("the admin route: admin only, read only", () => {
  const ADMIN = { id: "admin-1", email: "owner@example.test", app_metadata: { role: "admin" }, user_metadata: { name: "المدير" } };
  const call = (jobId: string) => diagnosticGet(new NextRequest(`http://127.0.0.1:3000/api/admin/job-diagnostic?jobId=${encodeURIComponent(jobId)}`));
  const file = { v: 1, steps: { "0": { ...recordPostJudgements(emptyDiagnostic(), [{ text: "منشور عن موضوع آخر", decision: "no_match", by: "review", reasonAr: POST_OFF_TOPIC_REASON_AR }]) } } };
  beforeEach(() => { state.user = null; state.files.clear(); state.reads.length = 0; });

  it("a signed-out visitor and a customer get nothing and nothing is read", async () => {
    state.files.set("job_abc12345/diagnostic.json", JSON.stringify(file));
    expect((await call("job_abc12345")).status).toBe(401);
    state.user = { id: "u1", email: "c@example.test", app_metadata: { role: "customer" } };
    expect((await call("job_abc12345")).status).toBe(403);
    expect(state.reads).toEqual([]);
  });

  it("the admin reads the totals and the sample; a job with no diagnostic answers null; a bad id is refused", async () => {
    state.user = ADMIN;
    state.files.set("job_abc12345/diagnostic.json", JSON.stringify(file));
    const ok = await call("job_abc12345");
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body.diagnostic.posts.excluded).toBe(1);
    expect(body.diagnostic.samples.posts[0].text).toBe("منشور عن موضوع آخر");
    expect((await (await call("job_zzzzzzzz")).json()).diagnostic).toBeNull();
    expect((await call("../etc/passwd")).status).toBe(400);
  });

  it("no customer-facing source reads the diagnostic: only the worker (which writes it), the admin route and the admin panel (a type) import it", () => {
    const importers: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(name) && /zeroDeliveryDiagnostic/.test(readFileSync(full, "utf8"))) importers.push(path.relative("src", full).replace(/\\/g, "/"));
      }
    };
    walk("src");
    expect(importers.sort()).toEqual(["app/api/admin/job-diagnostic/route.ts", "app/api/worker/chunk/route.ts", "components/admin/JobDiagnosticPanel.tsx"].sort());
  });
});
