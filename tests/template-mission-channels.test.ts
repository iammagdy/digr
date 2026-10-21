import { describe, expect, it } from "vitest";
import { runConversation } from "./helpers/chatSession";
import { formatStructuredClarificationAnswers } from "../src/functions/shared/clarification";
import { getDeterministicDiscoveryQuestion } from "../src/functions/shared/chatHandler";
import { channelsCountAr, handlesInText, parseChannelAnswer } from "../src/lib/channelNames";
import { understandMission } from "../src/lib/consultantCopy";

/**
 * The big-mission template «أعلى ١٠ فيديوهات مشاهدة من ٣ قنوات تيك توك مع كل التعليقات»: whatever number of channels the customer gives
 * (one, three, five, more than a job holds), in any form (handle with or without «@», a link, a plain name), typed in one message or
 * several, the conversation reaches a plan. A skipped question never ends in a refusal: the plan goes ahead with what is known, or
 * one DIFFERENT question is asked. Offline: the chat handler runs with the model stubbed out, exactly like the production path.
 */
const answer = (questionId: string, question: string, value?: string) =>
  formatStructuredClarificationAnswers({ type: "clarification_answers", answers: [value ? { questionId, question, value } : { questionId, question, skipped: true }] } as any);

const TEMPLATE = "أعلى ١٠ فيديوهات مشاهدة من ٣ قنوات تيك توك مع كل التعليقات";
const CHANNELS_Q = "ما أسماء القنوات أو روابطها؟";
const CAP_Q = "ما الحد الأقصى لعدد التعليقات الذي تريده؟";
const TIME_Q = "ما الفترة الزمنية التي تهمّك؟";
const TOPIC_Q = "ما موضوع الفيديوهات التي تريد تعليقاتها؟ سأبحث عن أعلاها مشاهدة بدل القنوات.";

const BANNED = /لا أستطيع|لم يحدد المستخدم|undefined|null|NaN|USD|treg|tikhub|Failed to fetch/i;
const visible = (r: any) => [r.contentAr, r.planQuote?.summaryAr, r.planQuote?.understoodAr, r.clarificationIntro, ...(r.clarificationQuestions || [])].filter(Boolean).join(" \n ");
const planOf = (responses: any[]) => responses.find((r) => r.outputType === "propose_plan");
const ids = (r: any) => (r.clarificationItems || []).map((q: any) => q.id);

describe("channels in any form", () => {
  it("handles with and without «@», names, «قناة X» and links are all read", () => {
    expect(parseChannelAnswer("@aljazeera و@alarabiya و@skynews")).toEqual(["@aljazeera", "@alarabiya", "@skynews"]);
    expect(parseChannelAnswer("aljazeera, alarabiya و skynews")).toEqual(["@aljazeera", "@alarabiya", "@skynews"]);
    expect(parseChannelAnswer("الجزيرة والعربية")).toEqual(["الجزيرة", "العربية"]);
    expect(parseChannelAnswer("قناة الجزيرة مباشر\nقناة سكاي نيوز عربية")).toEqual(["الجزيرة مباشر", "سكاي نيوز عربية"]);
    expect(parseChannelAnswer("https://www.tiktok.com/@aljazeera و https://www.youtube.com/@skynews")).toEqual(["@aljazeera", "@skynews"]);
    expect(parseChannelAnswer("https://www.youtube.com/channel/UCNye-wNBqNL5ZzHSJj3l8Bg")).toHaveLength(1);
    expect(parseChannelAnswer("@aljazeera ، @aljazeera ، aljazeera")).toEqual(["@aljazeera"]);
    expect(handlesInText("شوف @aljazeera وكمان https://www.tiktok.com/@skynews")).toEqual(["@skynews", "@aljazeera"].sort((a, b) => (a === "@skynews" ? -1 : 1)));
  });

  it("an answer that means «no answer» is never a channel", () => {
    expect(parseChannelAnswer("لا")).toEqual([]);
    expect(parseChannelAnswer("معرفش")).toEqual([]);
    expect(parseChannelAnswer("تخطي")).toEqual([]);
    expect(parseChannelAnswer("٣")).toEqual([]);
  });

  it("the count of channels is correct Arabic", () => {
    expect([1, 2, 3, 10, 11].map(channelsCountAr)).toEqual(["قناة واحدة", "قناتين", "٣ قنوات", "١٠ قنوات", "١١ قناة"]);
  });

  it("the template itself still asks for the channels, and a typed answer is not mistaken for a topic", () => {
    const u = understandMission(`${TEMPLATE} القنوات المطلوبة: الجزيرة والعربية`);
    expect(u.channels.named).toEqual(["الجزيرة", "العربية"]);
    expect(u.missing).not.toContain("channels");
    expect(understandMission(TEMPLATE).missing).toContain("channels");
  });
});

describe("a template mission reaches a plan with any number of channels", () => {
  it("one channel typed with «@»: one question for the cap, then a plan that says one of three was given", async () => {
    const { responses } = await runConversation([TEMPLATE, "@aljazeera", answer("volume_cap_required", CAP_Q, "٢٠٠٠ تعليق")]);
    expect(ids(responses[0])).toEqual(["social_channel_required"]);
    expect(ids(responses[1])).toEqual(["volume_cap_required"]);
    const plan = planOf(responses);
    expect(plan).toBeTruthy();
    expect(plan.planQuote.items[0].params.channels).toEqual(["@aljazeera"]);
    expect(plan.contentAr).toContain("ذكرت قناة واحدة من ٣ قنوات، فخططت على ما ذكرته.");
    expect(plan.contentAr).not.toContain("قيمة افتراضية");
    for (const r of responses) expect(visible(r)).not.toMatch(BANNED);
  });

  it("three channels typed in one message: a plan with all three and no «fewer» sentence", async () => {
    const { responses } = await runConversation([TEMPLATE, "@aljazeera و@alarabiya و@skynews", answer("volume_cap_required", CAP_Q, "١٠٠٠ تعليق")]);
    const plan = planOf(responses);
    expect(plan.planQuote.items[0].params.channels).toEqual(["@aljazeera", "@alarabiya", "@skynews"]);
    expect(plan.planQuote.items[0].params.topPerChannel).toBe(10);
    expect(plan.contentAr).not.toContain("ذكرت");
    expect(plan.planQuote.understoodAr).toContain("@aljazeera");
  });

  it("handles with and without «@» in one answer", async () => {
    const { responses } = await runConversation([TEMPLATE, "aljazeera و @alarabiya وskynews", answer("volume_cap_required", CAP_Q, "١٠٠٠ تعليق")]);
    expect(planOf(responses).planQuote.items[0].params.channels).toEqual(["@aljazeera", "@alarabiya", "@skynews"]);
  });

  it("plain Arabic names typed without any handle", async () => {
    const { responses } = await runConversation([TEMPLATE, "الجزيرة والعربية", answer("volume_cap_required", CAP_Q, "١٠٠٠ تعليق")]);
    const plan = planOf(responses);
    expect(plan.planQuote.items[0].params.channels).toEqual(["الجزيرة", "العربية"]);
    expect(plan.contentAr).toContain("ذكرت قناتين من ٣ قنوات");
  });

  it("links in the card answer are kept (they are the answer, not markup)", async () => {
    const { responses } = await runConversation([
      TEMPLATE,
      answer("social_channel_required", CHANNELS_Q, "https://www.tiktok.com/@aljazeera و https://www.tiktok.com/@skynews"),
      answer("volume_cap_required", CAP_Q, "٥٠٠ تعليق"),
    ]);
    expect(planOf(responses).planQuote.items[0].params.channels).toEqual(["@aljazeera", "@skynews"]);
  });

  it("channels in several messages add up", async () => {
    const { responses } = await runConversation([TEMPLATE, "@aljazeera", "وكمان @alarabiya", answer("volume_cap_required", CAP_Q, "١٠٠٠ تعليق")]);
    expect(planOf(responses).planQuote.items[0].params.channels).toEqual(["@aljazeera", "@alarabiya"]);
  });

  it("five channels", async () => {
    const { responses } = await runConversation([TEMPLATE, "@a1 و@b2 و@c3 و@d4 و@e5", answer("volume_cap_required", CAP_Q, "١٠٠٠ تعليق")]);
    const plan = planOf(responses);
    expect(plan.planQuote.items[0].params.channels).toHaveLength(5);
    expect(plan.contentAr).not.toContain("ذكرت");
  });

  it("more channels than one job holds: the plan keeps the first ten and says so in one sentence", async () => {
    const many = Array.from({ length: 12 }, (_, k) => `@ch${k + 1}`).join(" و");
    const { responses } = await runConversation([TEMPLATE, many, answer("volume_cap_required", CAP_Q, "١٠٠٠ تعليق")]);
    const plan = planOf(responses);
    expect(plan.planQuote.items[0].params.channels).toHaveLength(10);
    expect(plan.contentAr).toContain("كتبت ١٢ قناة، واعتمدت أول ١٠ قنوات");
  });
});

describe("a skip never ends in a refusal", () => {
  it("one channel, then the cap skipped: the plan goes ahead with an explicit default count, never a silent ten", async () => {
    const { responses } = await runConversation([TEMPLATE, "@aljazeera", answer("volume_cap_required", CAP_Q)]);
    const plan = planOf(responses);
    expect(plan).toBeTruthy();
    expect(plan.contentAr).toContain("العدد المطلوب: ٥٠٠ تعليق (قيمة افتراضية لأنك لم تحدد عددًا)، وتقدر تعدّله من الخطة.");
    expect(plan.planQuote.targetVolumeMax).toBe(500);
    expect(plan.planQuote.askedVolumeMax).toBeUndefined();
    expect(plan.planQuote.items[0].params.channels).toEqual(["@aljazeera"]);
    for (const r of responses) expect(visible(r)).not.toMatch(BANNED);
  });

  it("the channel question skipped at the start: a different question (the topic), then a plan by topic that says so", async () => {
    const { responses } = await runConversation([
      TEMPLATE,
      answer("social_channel_required", CHANNELS_Q),
      "منتخب مصر",
      answer("volume_cap_required", CAP_Q, "٢٠٠٠ تعليق"),
      answer("social_time_required", TIME_Q, "آخر شهر"),
    ]);
    expect(ids(responses[0])).toEqual(["social_channel_required"]);
    expect(ids(responses[1])).toEqual(["social_topic_required"]);
    expect(responses[1].clarificationItems[0].text).toBe(TOPIC_Q);
    const plan = planOf(responses);
    expect(plan).toBeTruthy();
    expect(plan.planQuote.items[0].params.query).toBe("منتخب مصر");
    // 2,000 comments by topic: 30 videos (the videos ceiling is now 50, it was 20)
    expect(plan.planQuote.items[0].params.videoCount).toBe(30);
    expect(plan.contentAr).toContain("القنوات: لم تحدد قنوات، فأبحث عن أعلى الفيديوهات مشاهدة عن «منتخب مصر».");
    for (const r of responses) expect(visible(r)).not.toMatch(BANNED);
  });

  it("the channels skipped and the cap skipped too: still a plan, with the default count shown", async () => {
    const { responses } = await runConversation([
      TEMPLATE,
      answer("social_channel_required", CHANNELS_Q),
      answer("social_topic_required", TOPIC_Q, "منتخب مصر"),
      answer("volume_cap_required", CAP_Q),
      answer("social_time_required", TIME_Q, "آخر شهر"),
    ]);
    const plan = planOf(responses);
    expect(plan).toBeTruthy();
    expect(plan.contentAr).toContain("قيمة افتراضية");
  });

  it("both the channels and the topic skipped: one constructive sentence, not a refusal and not the same card", async () => {
    const { responses } = await runConversation([TEMPLATE, answer("social_channel_required", CHANNELS_Q), answer("social_topic_required", TOPIC_Q)]);
    expect(responses[2].outputType).toBe("answer_question");
    expect(responses[2].clarificationItems ?? []).toHaveLength(0);
    expect(responses[2].contentAr).toContain("اكتب موضوعًا أو اسم قناة");
    expect(responses[2].contentAr).not.toMatch(BANNED);
  });

  it("a channel typed after both were skipped goes on to a plan", async () => {
    const { responses } = await runConversation([
      TEMPLATE,
      answer("social_channel_required", CHANNELS_Q),
      answer("social_topic_required", TOPIC_Q),
      "@aljazeera",
      answer("volume_cap_required", CAP_Q, "٥٠٠ تعليق"),
    ]);
    expect(planOf(responses)?.planQuote.items[0].params.channels).toEqual(["@aljazeera"]);
  });

  it("no skipped question id of the discovery gate ever produces a refusal sentence", () => {
    const brief: any = { platforms: [], topics: [], notes: "" };
    for (const id of ["social_platform_required", "social_comment_target_required", "social_channel_required", "social_topic_required", "social_x_topic_required", "company_country_required", "people_roles_required", "goal_required"]) {
      const question = getDeterministicDiscoveryQuestion(TEMPLATE, brief, [], { skipped: new Set([id]) });
      if (question?.plain) expect(question.text).not.toMatch(BANNED);
    }
    // the generic sentence is used for any other id
    const generic = getDeterministicDiscoveryQuestion("عايز ٥٠ شركة", brief, [], { skipped: new Set(["company_country_required", "company_industry_required"]) });
    if (generic?.plain) expect(generic.text).not.toMatch(BANNED);
  });
});

describe("the customer text of a mission plan", () => {
  it("is Arabic only: Arabic-Indic digits, no Latin words other than the handles the customer typed", async () => {
    const { responses } = await runConversation([TEMPLATE, "الجزيرة", answer("volume_cap_required", CAP_Q)]);
    const text = planOf(responses).contentAr as string;
    expect(text).not.toMatch(/[0-9]/);
    expect(text).not.toMatch(/[A-Za-z]/);
    expect(text).not.toMatch(BANNED);
  });
});
