import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import PlanQuoteCard, { type PlanQuoteData } from "../src/app/dashboard/chat/components/PlanQuoteCard";
import { ChatHandler } from "../src/functions/shared/chatHandler";
import { missionSteps, missionStepsAr, validateDependentSteps, MAX_DEPENDENT_STEPS, type DependentStep } from "../src/lib/dependentSteps";
import { getSocialCapability } from "../src/lib/socialSources";
import { createChatDb } from "./helpers/chatSession";

const step = (over: Partial<DependentStep> & { stepId: string }): DependentStep => ({ capabilitySlug: "social-youtube-videos", params: {}, targetVolumeMin: 1, targetVolumeMax: 10, ...over });

describe("dependent steps: the sound core of the unmerged dependent-plans work, ported", () => {
  it("a channels -> videos -> comments mission is one valid dependent plan", () => {
    const steps = missionSteps("youtube", { channels: ["@a", "@b", "@c", "@d", "@e"], topPerChannel: 10, rankBy: "views" }, 2000);
    expect(steps.map((s) => s.stepId)).toEqual(["videos", "comments"]);
    expect(steps[0].targetVolumeMax).toBe(50);
    expect(steps[1]).toMatchObject({ dependsOn: ["videos"], fanOutCap: 50, targetVolumeMax: 2000, inputFrom: { stepId: "videos", field: "id", paramKey: "video" } });
    expect(validateDependentSteps(steps)).toEqual({ valid: true, errors: [] });
    for (const s of steps) expect(getSocialCapability(s.capabilitySlug), s.capabilitySlug).toBeTruthy();
  });

  it("the kept videos are capped (ten channels x twenty is a hundred, not two hundred)", () => {
    const steps = missionSteps("youtube", { channels: Array.from({ length: 10 }, (_, i) => `@c${i}`), topPerChannel: 20 }, 1000);
    expect(steps[0].targetVolumeMax).toBe(100);
    expect(steps[1].fanOutCap).toBe(100);
    expect(validateDependentSteps(steps).valid).toBe(true);
  });

  it("refuses a dependency that points forward or nowhere, a repeated id, a source outside dependsOn, a missing fan-out cap, an open-ended step, and too many steps", () => {
    const a = step({ stepId: "a" });
    expect(validateDependentSteps([step({ stepId: "b", dependsOn: ["c"] }), step({ stepId: "c" })]).valid).toBe(false);
    expect(validateDependentSteps([a, step({ stepId: "b", dependsOn: ["zzz"] })]).valid).toBe(false);
    expect(validateDependentSteps([a, step({ stepId: "a" })]).valid).toBe(false);
    expect(validateDependentSteps([a, step({ stepId: "b", dependsOn: [], inputFrom: { stepId: "a", field: "id", paramKey: "video" }, fanOutCap: 5 })]).valid).toBe(false);
    expect(validateDependentSteps([a, step({ stepId: "b", dependsOn: ["a"], inputFrom: { stepId: "a", field: "id", paramKey: "video" } })]).valid).toBe(false);
    expect(validateDependentSteps([a, step({ stepId: "b", volumeMode: "open_ended" })]).valid).toBe(false);
    expect(validateDependentSteps([step({ stepId: "a", targetVolumeMin: 10, targetVolumeMax: 5 })]).valid).toBe(false);
    expect(validateDependentSteps(Array.from({ length: MAX_DEPENDENT_STEPS + 1 }, (_, i) => step({ stepId: `s${i}` }))).valid).toBe(false);
    expect(validateDependentSteps([]).valid).toBe(false);
  });

  it("every error is plain Arabic with Arabic digits", () => {
    const { errors } = validateDependentSteps([step({ stepId: "a", targetVolumeMin: 10, targetVolumeMax: 5 }), step({ stepId: "a", dependsOn: ["x"] })]);
    expect(errors.length).toBeGreaterThan(0);
    for (const error of errors) expect(error).not.toMatch(/[A-Za-z0-9]|undefined|null/);
  });

  it("the plan states each stage in plain Arabic, including how far the channel stage reaches", () => {
    const lines = missionStepsAr({ channels: ["@a", "@b"], topPerChannel: 10, rankBy: "views", topic: "منتخب مصر" }, 2000);
    expect(lines).toHaveLength(4);
    expect(lines[1]).toContain("أحدث ٣٠ فيديو متاحًا");
    expect(lines[1]).toContain("أعلى ١٠ فيديوهات");
    expect(lines[1]).toContain("«منتخب مصر»");
    expect(lines[2]).toContain("٢٠٠٠ تعليقًا");
    for (const line of lines) expect(line).not.toMatch(/[A-Za-z0-9]|undefined|null/);
  });
});

describe("a channel mission through the chat (model stubbed to throw)", () => {
  function run(message: string) {
    const db = createChatDb();
    const handler = new ChatHandler(db as any);
    const model = vi.fn(async () => { throw new Error("the model must not be called"); });
    (handler as any).llm.executeTurn = model;
    return { model, send: () => handler.handleUserMessage({ userId: "u_mission", message, userBalance: 5000 }) as Promise<any> };
  }

  it("without the channels: ONE question for them, nothing priced", async () => {
    const { model, send } = run("عايز أكتر ١٠ فيديوهات مشاهدة من ٥ قنوات أخبار على يوتيوب مع كل التعليقات");
    const r = await send();
    expect(model).not.toHaveBeenCalled();
    expect(r.outputType).toBe("ask_clarification");
    expect(r.planQuote).toBeUndefined();
    expect(r.clarificationItems.map((q: any) => q.id)).toEqual(["social_channel_required"]);
    expect(r.contentAr).toMatch(/^فهمت أنك تريد/);
  });

  it("«كل التعليقات» without a cap: ONE question for the cap, with numeric choices", async () => {
    const { send } = run("عايز أكتر ١٠ فيديوهات مشاهدة من قناة @AlArabiya وقناة @SkyNewsArabia على يوتيوب مع كل التعليقات");
    const r = await send();
    expect(r.outputType).toBe("ask_clarification");
    expect(r.clarificationItems.map((q: any) => q.id)).toEqual(["volume_cap_required"]);
    expect(r.clarificationItems[0].options).toEqual(["٥٠٠ تعليق", "١٠٠٠ تعليق", "٢٠٠٠ تعليق", "٥٠٠٠ تعليق"]);
    expect(r.contentAr).toContain("حدًا أقصى");
  });

  it("with channels and a cap: ONE plan item carrying the channels, top-N and ranking; the number is the comment cap, never the top-N", async () => {
    const { send } = run("عايز أكتر ١٠ فيديوهات مشاهدة من قناة @AlArabiya وقناة @SkyNewsArabia على يوتيوب مع ٢٠٠٠ تعليق");
    const r = await send();
    expect(r.outputType).toBe("propose_plan");
    expect(r.planQuote.items).toHaveLength(1);
    const item = r.planQuote.items[0];
    expect(item.capabilitySlug).toBe("social-youtube-comments");
    expect(item.params).toMatchObject({ channels: ["@AlArabiya", "@SkyNewsArabia"], topPerChannel: 10, rankBy: "views" });
    expect(item.params).not.toHaveProperty("channel");
    expect(item.params).not.toHaveProperty("videoCount");
    // the number the customer wrote (2000) is the comment cap; the comments service's own limit is now 2,000, so it is held whole up to what the 600-point cap holds
    expect(r.planQuote.requestedVolumeMax).toBe(2000);
    expect(r.planQuote.targetVolumeMax).toBe(1897);
    expect(r.planQuote.understoodAr).toContain("أعلى ١٠ فيديوهات مشاهدة");
  });

  it("a channel with a topic inside a known event: the event window and the topic reach the plan", async () => {
    const { send } = run("عايز كل فيديوهات قناة @fifa على يوتيوب عن منتخب مصر في كأس العالم ٢٠٢٦ مع ٣٠٠٠ تعليق");
    const r = await send();
    expect(r.outputType).toBe("propose_plan");
    expect(r.planQuote.items[0].params).toMatchObject({ channels: ["@fifa"], topic: "منتخب مصر", dateFrom: "2026-06-11", dateTo: "2026-07-19" });
    expect(r.planQuote.window).toMatchObject({ source: "event" });
    expect(r.planQuote.window.reasonAr).toContain("تقدر تعدّلها");
  });
});

describe("the plan card shows a mission's own steps and can be approved when complete", () => {
  const quote: PlanQuoteData = {
    quoteId: "q_m1",
    summaryAr: "سحب تعليقات أعلى ١٠ فيديوهات مشاهدة لكل قناة",
    items: [{ capabilitySlug: "social-youtube-comments", params: { channels: ["@AlArabiya", "@SkyNewsArabia"], topPerChannel: 10, rankBy: "views" }, targetVolumeMin: 1, targetVolumeMax: 57 }],
    targetVolumeMax: 57, unitPricePoints: 9, expectedPoints: 513, quotedPoints: 590, isAffordable: true, userBalance: 5000,
    outputFormats: ["xlsx"], expiresAt: new Date(Date.now() + 3600_000).toISOString(), status: "quoted",
  };
  const render = () => renderToStaticMarkup(createElement(PlanQuoteCard, { quote, onStart: () => {}, onSaveEdit: async () => {}, isStarting: false, available: 5000, creditValue: 0.1, onTopupShort: () => {}, onRefresh: async () => {} } as any));

  it("renders the mission steps, not the generic ones, and offers approval", () => {
    const html = render();
    expect(html).toContain('data-testid="mission-steps"');
    expect(html).toContain("أحدث ٣٠ فيديو متاحًا");
    expect(html).not.toContain("خطوات التنفيذ المنهجية");
    expect(html).toContain("أوافق وابدأ البحث");
  });
});
