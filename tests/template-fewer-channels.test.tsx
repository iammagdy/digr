import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { runConversation } from "./helpers/chatSession";
import { formatStructuredClarificationAnswers } from "../src/functions/shared/clarification";
import { MISSION_TEMPLATES } from "../src/lib/missionTemplates";
import { isChannelPlaceholder, missionCoverageLinesAr, understandMission } from "../src/lib/consultantCopy";
import PlanQuoteCard from "../src/app/dashboard/chat/components/PlanQuoteCard";

/**
 * Live QA of 72d0a07: fewer channels than the template said (one of three) were planned without a word about it. The template now
 * says how many channels it is for, an unedited placeholder is never a channel, and the plan says in one plain sentence what it did,
 * in the message and on the plan card (the live tester looked at the card).
 */
const SENTENCE_ONE_OF_THREE = "ذكرت قناة واحدة من ٣ قنوات، فخططت على ما ذكرته.";
const TEMPLATE = MISSION_TEMPLATES.find((t) => t.id === "channels_top_videos_comments")!.promptAr;
const PLACEHOLDERS = "[@القناة_الأولى و@القناة_الثانية و@القناة_الثالثة]";
const withChannels = (channels: string) => TEMPLATE.replace(PLACEHOLDERS, channels);
const answer = (questionId: string, question: string, value?: string) =>
  formatStructuredClarificationAnswers({ type: "clarification_answers", answers: [value ? { questionId, question, value } : { questionId, question, skipped: true }] } as any);
const CAP_Q = "ما الحد الأقصى لعدد التعليقات الذي تريده؟";
const planOf = (responses: any[]) => responses.find((r) => r.outputType === "propose_plan");
const card = (quote: any) => renderToStaticMarkup(createElement(PlanQuoteCard, { quote, onStart: () => {}, onSaveEdit: async () => {}, isStarting: false, available: 5000, creditValue: 0.1, onTopupShort: () => {}, onRefresh: async () => {} } as any));

describe("the template says how many channels it is for", () => {
  it("«[٣] قنوات» and three placeholders, all of them editable", () => {
    expect(TEMPLATE).toContain("من [٣] قنوات");
    expect(TEMPLATE).toContain(PLACEHOLDERS);
    expect(understandMission(withChannels("@aa و@bb و@cc")).channels).toEqual({ count: 3, named: ["@aa", "@bb", "@cc"] });
  });

  it("a placeholder is a sample: never a channel", () => {
    for (const name of ["@القناة_الأولى", "القناة_الثانية", "@القناة_الثالثة"]) expect(isChannelPlaceholder(name)).toBe(true);
    for (const name of ["@aljazeera", "الجزيرة", "@القناة_المفضلة"]) expect(isChannelPlaceholder(name)).toBe(false);
    expect(understandMission(TEMPLATE).channels.named).toEqual([]);
    expect(understandMission(TEMPLATE).missing).toContain("channels");
    // one real channel with the other two samples left in place: the real one counts, the samples do not
    expect(understandMission(withChannels("[@aljazeera و@القناة_الثانية و@القناة_الثالثة]")).channels).toEqual({ count: 3, named: ["@aljazeera"] });
  });
});

describe("the sentence", () => {
  const u = (named: string[], count: number | null) => ({ ...understandMission(withChannels("@a")), channels: { count, named } });
  it("one of three, two of three: one plain sentence each, the exact words", () => {
    expect(missionCoverageLinesAr(u(["@a"], 3), { channels: ["@a"], maxChannels: 10 })).toEqual([SENTENCE_ONE_OF_THREE]);
    expect(missionCoverageLinesAr(u(["@a", "@b"], 3), { channels: ["@a", "@b"], maxChannels: 10 })).toEqual(["ذكرت قناتين من ٣ قنوات، فخططت على ما ذكرته."]);
    expect(missionCoverageLinesAr(u(["@a"], 5), { channels: ["@a"], maxChannels: 10 })).toEqual(["ذكرت قناة واحدة من ٥ قنوات، فخططت على ما ذكرته."]);
  });
  it("all the channels given, or no count in the request: no sentence", () => {
    expect(missionCoverageLinesAr(u(["@a", "@b", "@c"], 3), { channels: ["@a", "@b", "@c"], maxChannels: 10 })).toEqual([]);
    expect(missionCoverageLinesAr(u(["@a"], null), { channels: ["@a"], maxChannels: 10 })).toEqual([]);
  });
  it("it is plain Arabic: no Latin letters, no digits outside Arabic-Indic, no id", () => {
    expect(SENTENCE_ONE_OF_THREE).not.toMatch(/[A-Za-z0-9]|undefined|null|NaN/);
  });
});

describe("through the chat handler and the plan card", () => {
  it("the template with ONE channel in place of the three: the plan is built on it and says so, in the message and on the card", async () => {
    const { responses } = await runConversation([withChannels("@aljazeera"), answer("volume_cap_required", CAP_Q, "٥٠٠ تعليق")]);
    const plan = planOf(responses);
    expect(plan).toBeTruthy();
    expect(plan.planQuote.items[0].params.channels).toEqual(["@aljazeera"]);
    expect(plan.contentAr).toContain(SENTENCE_ONE_OF_THREE);
    expect(plan.planQuote.coverageLinesAr).toEqual([SENTENCE_ONE_OF_THREE]);
    const html = card(plan.planQuote);
    expect(html).toContain('data-testid="plan-coverage"');
    expect(html).toContain(SENTENCE_ONE_OF_THREE);
  });

  it("two of three: the same, with «قناتين»", async () => {
    const { responses } = await runConversation([withChannels("@aljazeera و@alarabiya"), answer("volume_cap_required", CAP_Q, "٥٠٠ تعليق")]);
    const plan = planOf(responses);
    expect(plan.planQuote.items[0].params.channels).toEqual(["@aljazeera", "@alarabiya"]);
    expect(plan.planQuote.coverageLinesAr).toEqual(["ذكرت قناتين من ٣ قنوات، فخططت على ما ذكرته."]);
    expect(card(plan.planQuote)).toContain("ذكرت قناتين من ٣ قنوات، فخططت على ما ذكرته.");
  });

  it("all three: no sentence on the message or the card", async () => {
    const { responses } = await runConversation([withChannels("@aljazeera و@alarabiya و@skynews"), answer("volume_cap_required", CAP_Q, "٥٠٠ تعليق")]);
    const plan = planOf(responses);
    expect(plan.planQuote.items[0].params.channels).toHaveLength(3);
    expect(plan.planQuote.coverageLinesAr).toBeUndefined();
    expect(plan.contentAr).not.toContain("فخططت على ما ذكرته");
    expect(card(plan.planQuote)).not.toContain('data-testid="plan-coverage"');
  });

  it("the template sent with its placeholders left in: no plan on «@القناة_الأولى», the channels are asked for", async () => {
    const { responses } = await runConversation([TEMPLATE]);
    expect(planOf(responses)).toBeUndefined();
    const ids = (responses[0].clarificationItems || []).map((q: any) => q.id);
    expect(ids).toEqual(["social_channel_required"]);
    for (const r of responses) expect(JSON.stringify(r)).not.toContain("القناة_الأولى");
  });

  it("a channel typed in the old way (a plain message after the template wording) still says it", async () => {
    const { responses } = await runConversation(["أريد أعلى ١٠ فيديوهات مشاهدة من ٣ قنوات يوتيوب مع كل التعليقات", "@aljazeera", answer("volume_cap_required", CAP_Q, "٥٠٠ تعليق")]);
    expect(planOf(responses).planQuote.coverageLinesAr).toEqual([SENTENCE_ONE_OF_THREE]);
  });
});
