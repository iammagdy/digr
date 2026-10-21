import { describe, expect, it, vi } from "vitest";
import { ChatHandler } from "../src/functions/shared/chatHandler";
import { createChatDb } from "./helpers/chatSession";
import { formatStructuredClarificationAnswers } from "../src/functions/shared/clarification";
import { understandMission } from "../src/lib/consultantCopy";
import { knownEventWindow, proposedDefaultWindow, resolveTimeWindow } from "../src/lib/timeWindow";
import { videosCountAr } from "../src/lib/channelNames";
import { DEFAULT_COMMENTS_CAP, DEFAULT_RECORDS_CAP } from "../src/lib/planDefaults";

/**
 * Live QA of 87d710c0, after the template fix:
 *  D2  «كل تعليقات ٣ فيديوهات»: three videos and the comment cap are TWO quantities; the volume is shown in comments.
 *  D3  X, a skipped window or cap: never a silent «10 records» and never a silent window; the plan proposes one and says why.
 *  D4  the YouTube comments flow asks at most two things (the topic, then the cap); the period is proposed on the plan.
 * Everything runs through the real chat handler with the model stubbed to throw, so none of it can be the model's doing.
 */
const answer = (questionId: string, question: string, value?: string) =>
  formatStructuredClarificationAnswers({ type: "clarification_answers", answers: [value ? { questionId, question, value } : { questionId, question, skipped: true }] } as any);

const CAP_Q = "ما الحد الأقصى لعدد التعليقات الذي تريده؟";
const RECORDS_CAP_Q = "ما الحد الأقصى لعدد السجلات الذي تريده؟";
const TIME_Q = "ما الفترة الزمنية التي تهمّك؟";
const TARGET_Q = "ما موضوع الفيديوهات أو اسم القناة التي تريد تعليقاتها؟ ويمكنك لصق رابط فيديو بدل ذلك.";
const DEFAULT_WINDOW_REASON = "لم تحدد فترة، فاقترحت آخر شهر وتقدر تعدّلها في الخطة.";

async function conversation(messages: string[]) {
  const db = createChatDb();
  const handler = new ChatHandler(db as any);
  const model = vi.fn(async () => { throw new Error("the model must not be called"); });
  (handler as any).llm.executeTurn = model;
  const conversationId = "conv_quantities";
  await db.createRow({ tableId: "conversations", rowId: conversationId, data: { userId: "user_quantities", title: "محادثة جديدة", status: "active", totalTokens: 0 } });
  const responses: any[] = [];
  for (const message of messages) {
    responses.push(await handler.handleUserMessage({ userId: "user_quantities", conversationId, message, userBalance: 5000 }));
  }
  return { responses, model };
}

const ids = (r: any) => (r.clarificationItems || []).map((q: any) => q.id);
const BANNED = /undefined|null|NaN|USD|treg|tikhub|لا أستطيع|لم يحدد المستخدم/i;
const monthsBetween = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 86400000 / 30);

describe("D2: «كل تعليقات ٣ فيديوهات على يوتيوب»: videos and comments are separate quantities", () => {
  it("the understanding reads videos: 3, and never a volume of 3", () => {
    const u = understandMission("عايز كل تعليقات ٣ فيديوهات على يوتيوب عن منتخب مصر");
    expect(u.videos).toBe(3);
    expect(u.volume).toBeNull();
    expect(u.allComments).toBe(true);
    expect(u.missing).toEqual(["cap"]);
    const withCap = understandMission("عايز كل تعليقات ٣ فيديوهات على يوتيوب عن منتخب مصر الحد الأقصى المطلوب: ٢٠٠٠ تعليق");
    expect(withCap).toMatchObject({ videos: 3, volume: 2000 });
    expect(understandMission("٥٠ تعليق لكل فيديو من ٤ فيديوهات على يوتيوب عن القهوة")).toMatchObject({ videos: 4, commentsPerVideo: 50, volume: null });
    // a posts request keeps its number as the volume: the number is not a container there
    expect(understandMission("عايز ١٠٠ تغريدة عن الغلاء على إكس").videos).toBeNull();
  });

  it("the cap question is asked once; the plan holds three videos and the customer's comment cap", async () => {
    const { responses, model } = await conversation([
      "عايز كل تعليقات ٣ فيديوهات على يوتيوب عن منتخب مصر",
      answer("volume_cap_required", CAP_Q, "٢٠٠٠ تعليق"),
    ]);
    expect(model).not.toHaveBeenCalled();
    expect(ids(responses[0])).toEqual(["volume_cap_required"]);
    const plan = responses[1];
    expect(plan.outputType).toBe("propose_plan");
    const params = plan.planQuote.items[0].params;
    expect(params.videoCount).toBe(3);
    expect(plan.planQuote.askedVolumeMax).toBe(2000);
    expect(plan.planQuote.summaryAr).toContain("٣ فيديوهات");
    expect(plan.planQuote.summaryAr).toContain("تعليقاً إجمالاً");
    expect(plan.contentAr).toContain("- الفيديوهات: ٣ فيديوهات، والتعليقات: حتى");
    expect(plan.contentAr).toMatch(/- الحد الأقصى: حتى [٠-٩]+ تعليق\n/);
    expect(plan.contentAr).not.toMatch(/حتى ٣ سجل|حتى ٣ تعليق\b/);
    expect(plan.contentAr).not.toContain("قيمة افتراضية");
    expect(plan.contentAr).not.toMatch(/[A-Za-z0-9]/);
  });

  it("the comments per video spread the cap over the three videos, never above the per-video ceiling", async () => {
    const { responses } = await conversation([
      "عايز كل تعليقات ٣ فيديوهات على يوتيوب عن منتخب مصر",
      answer("volume_cap_required", CAP_Q, "٣٠٠ تعليق"),
    ]);
    expect(responses[1].planQuote.items[0].params).toMatchObject({ videoCount: 3, perVideo: 100 });
  });

  it("the cap skipped: an explicit default count is shown on the plan (not three, not ten), and says what one job holds", async () => {
    const { responses } = await conversation([
      "عايز كل تعليقات ٣ فيديوهات على يوتيوب عن منتخب مصر",
      answer("volume_cap_required", CAP_Q),
    ]);
    const plan = responses[1];
    expect(plan.outputType).toBe("propose_plan");
    expect(plan.planQuote.items[0].params.videoCount).toBe(3);
    // the default (500 comments, 138 points of charge) fits one job whole: the plan holds it all and says no cut
    expect(plan.planQuote.targetVolumeMax).toBe(DEFAULT_COMMENTS_CAP);
    expect(plan.planQuote.askedVolumeMax).toBeUndefined();
    expect(plan.contentAr).toContain("العدد المطلوب: ٥٠٠ تعليق (قيمة افتراضية لأنك لم تحدد عددًا)، وتقدر تعدّله من الخطة.");
    expect(plan.contentAr).not.toContain("لكن الطلب الواحد يتسع الآن لـ");
    expect(plan.contentAr).not.toContain("طلبت ٥٠٠");
    expect(plan.contentAr).not.toMatch(BANNED);
  });

  it("the customer's own words win: «٥٠ تعليق لكل فيديو» of 4 videos asks for 200 comments, with no question", async () => {
    const { responses } = await conversation(["عايز ٥٠ تعليق لكل فيديو من ٤ فيديوهات على يوتيوب عن القهوة"]);
    expect(responses[0].outputType).toBe("propose_plan");
    expect(responses[0].planQuote.items[0].params).toMatchObject({ videoCount: 4, perVideo: 50 });
    // 200 asked (4 videos x 50): the whole request fits one job, so the plan holds 200 and says no cut
    expect(responses[0].planQuote.targetVolumeMax).toBe(200);
    expect(responses[0].planQuote.askedVolumeMax).toBeUndefined();
    expect(responses[0].contentAr).not.toContain("طلبت ٢٠٠ سجل");
    expect(responses[0].contentAr).not.toContain("قيمة افتراضية");
  });

  it("videos in correct Arabic", () => {
    expect([1, 2, 3, 10, 11].map((n) => videosCountAr(n))).toEqual(["فيديو واحد", "فيديوهين", "٣ فيديوهات", "١٠ فيديوهات", "١١ فيديو"]);
    expect(videosCountAr(3, "posts")).toBe("٣ منشورات");
  });
});

describe("D3: X, a skipped window or cap is never silent", () => {
  it("a known event gets its dates with the reason, no window question, and a skipped cap shows an explicit default", async () => {
    const { responses, model } = await conversation([
      "كل تغريدات مباراة مصر والمغرب في كأس العالم وردودها",
      answer("volume_cap_required", RECORDS_CAP_Q),
    ]);
    expect(model).not.toHaveBeenCalled();
    expect(ids(responses[0])).toEqual(["volume_cap_required"]);
    const plan = responses[1];
    expect(plan.outputType).toBe("propose_plan");
    const params = plan.planQuote.items[0].params;
    expect(params).toMatchObject({ dateFrom: "2026-06-11", dateTo: "2026-07-19" });
    expect(plan.contentAr).toContain("الفترة الزمنية: من ١١ يونيو ٢٠٢٦ إلى ١٩ يوليو ٢٠٢٦ — كأس العالم (أحدث نسخة، ٢٠٢٦) جرت من ١١ يونيو ٢٠٢٦ إلى ١٩ يوليو ٢٠٢٦، فاقترحت هذه الفترة وتقدر تعدّلها في الخطة.");
    expect(plan.planQuote.window).toMatchObject({ source: "event" });
    expect(plan.contentAr).toContain("العدد المطلوب: ٥٠٠ سجل (قيمة افتراضية لأنك لم تحدد عددًا)، وتقدر تعدّله من الخطة.");
    expect(plan.contentAr).not.toMatch(/حتى ١٠ (?:سجل|منشور)\n/);
    expect(plan.planQuote.targetVolumeMax).toBeGreaterThan(10);
    expect(plan.contentAr).not.toMatch(BANNED);
  });

  it("a topic with no event: the window question is asked once; skipped, the plan proposes the last month and says so; a skipped cap is explicit", async () => {
    const { responses } = await conversation([
      "كل تغريدات عن الغلاء على إكس وردودها",
      answer("social_time_required", TIME_Q),
      answer("volume_cap_required", RECORDS_CAP_Q),
    ]);
    expect(ids(responses[0])).toEqual(["social_time_required"]);
    expect(ids(responses[1])).toEqual(["volume_cap_required"]);
    const plan = responses[2];
    expect(plan.outputType).toBe("propose_plan");
    const params = plan.planQuote.items[0].params;
    expect(monthsBetween(params.dateFrom, params.dateTo)).toBe(1);
    expect(plan.contentAr).toContain(`الفترة الزمنية: آخر شهر`);
    expect(plan.contentAr).toContain(DEFAULT_WINDOW_REASON);
    expect(plan.planQuote.window).toMatchObject({ source: "default", reasonAr: DEFAULT_WINDOW_REASON });
    expect(plan.contentAr).toContain(`العدد المطلوب: ${"٥٠٠"} سجل (قيمة افتراضية`);
    expect(plan.planQuote.targetVolumeMax).toBe(DEFAULT_RECORDS_CAP);
    expect(plan.planQuote.askedVolumeMax).toBeUndefined();
  });

  it("a count the customer gave is used as given, with no default line", async () => {
    const { responses } = await conversation(["عايز ١٠٠ منشور على إكس عن الغلاء آخر شهر"]);
    expect(responses[0].planQuote.targetVolumeMax).toBe(100);
    expect(responses[0].contentAr).not.toContain("قيمة افتراضية");
    expect(responses[0].contentAr).not.toContain("لم تحدد فترة");
  });

  it("the known-event table: the latest World Cup without a year, never a different tournament, never a different year", () => {
    const today = new Date(Date.UTC(2026, 9, 20));
    expect(knownEventWindow("مباراة مصر والمغرب في كأس العالم", today)).toMatchObject({ from: "2026-06-11", to: "2026-07-19" });
    expect(knownEventWindow("مباراة في مونديال", today)?.reasonAr).toContain("أحدث نسخة");
    expect(knownEventWindow("تغريدات عن كأس العالم للأندية", today)).toBeNull();
    expect(knownEventWindow("تغريدات عن كأس العالم لكرة اليد", today)).toBeNull();
    expect(knownEventWindow("تغريدات عن كأس العالم ٢٠٢٢", today)).toBeNull();
    expect(knownEventWindow("تغريدات عن كأس العالم ٢٠٢٦", today)).toMatchObject({ from: "2026-06-11" });
  });

  it("the proposed default window is the last month, with the one-line reason and a source the plan shows", () => {
    const today = new Date(Date.UTC(2026, 9, 20));
    expect(proposedDefaultWindow(today)).toMatchObject({ status: "resolved", source: "default", dateFrom: "2026-09-20", dateTo: "2026-10-20", reasonAr: DEFAULT_WINDOW_REASON });
    // a request that states its own window never gets the default
    expect(resolveTimeWindow("تغريدات عن الغلاء آخر ٣ شهور", { needsWindow: true, today })).toMatchObject({ source: "relative" });
  });
});

describe("D4: the YouTube comments flow asks at most two things", () => {
  it("topic given: ONE question (the cap), and the plan appears after the first answer; the intro already names the period the plan will propose", async () => {
    const { responses } = await conversation([
      "عايز كل تعليقات ٣ فيديوهات على يوتيوب عن منتخب مصر",
      answer("volume_cap_required", CAP_Q, "٥٠٠ تعليق"),
    ]);
    expect(ids(responses[0])).toEqual(["volume_cap_required"]);
    expect(responses[0].contentAr).toContain("وسأقترح في الخطة آخر شهر كفترة، وتقدر تعدّلها.");
    expect(responses[1].outputType).toBe("propose_plan");
  });

  it("no topic: the topic, then the cap, then the plan: two answers, and the period is never asked", async () => {
    const { responses } = await conversation([
      "عايز كل تعليقات ٣ فيديوهات على يوتيوب",
      "منتخب مصر",
      answer("volume_cap_required", CAP_Q, "٥٠٠ تعليق"),
    ]);
    expect(responses[0].clarificationItems[0].text).toBe(TARGET_Q);
    expect(ids(responses[1])).toEqual(["volume_cap_required"]);
    expect(responses[2].outputType).toBe("propose_plan");
    const askedIds = responses.flatMap(ids);
    expect(askedIds).toHaveLength(2);
    expect(askedIds).not.toContain("social_time_required");
    expect(responses[2].contentAr).toContain(DEFAULT_WINDOW_REASON);
  });

  it("a cap stated in the request: the plan comes straight away, no question at all", async () => {
    const { responses } = await conversation(["عايز كل تعليقات ٣ فيديوهات على يوتيوب عن منتخب مصر حتى ٥٠٠ تعليق"]);
    expect(responses[0].outputType).toBe("propose_plan");
    expect(responses[0].planQuote.items[0].params.videoCount).toBe(3);
  });

  it("answering the topic and skipping the cap still ends in a plan within two steps", async () => {
    const { responses } = await conversation([
      "عايز كل تعليقات ٣ فيديوهات على يوتيوب",
      "منتخب مصر",
      answer("volume_cap_required", CAP_Q),
    ]);
    expect(responses[2].outputType).toBe("propose_plan");
    expect(responses[2].contentAr).toContain("قيمة افتراضية");
  });

  it("an explicit period the customer wrote is used, not the proposed default", async () => {
    const { responses } = await conversation(["عايز كل تعليقات ٣ فيديوهات على يوتيوب عن منتخب مصر آخر ٣ شهور حتى ٥٠٠ تعليق"]);
    const params = responses[0].planQuote.items[0].params;
    expect(monthsBetween(params.dateFrom, params.dateTo)).toBe(3);
    expect(responses[0].contentAr).not.toContain("لم تحدد فترة");
  });

  it("customer text of every turn is Arabic only, with Arabic digits", async () => {
    const { responses } = await conversation([
      "عايز كل تعليقات ٣ فيديوهات على يوتيوب",
      "منتخب مصر",
      answer("volume_cap_required", CAP_Q, "٥٠٠ تعليق"),
    ]);
    for (const r of responses) {
      expect(String(r.contentAr)).not.toMatch(/[A-Za-z0-9]/);
      expect(String(r.contentAr)).not.toMatch(BANNED);
    }
  });
});
