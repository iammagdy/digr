import { describe, expect, it, vi } from "vitest";
import {
  consultantIntroAr,
  GENERIC_ASK_ONE_INTRO_AR,
  isFormStyleIntro,
  nextStep,
  understandMission,
  understoodLineAr,
} from "../src/lib/consultantCopy";
import { ChatHandler } from "../src/functions/shared/chatHandler";
import { buildSystemPrompt } from "../src/functions/shared/systemPrompt";
import { APPROVED_CAPABILITY_CATALOG, sanitizeCapabilitiesForLlm } from "../src/functions/shared/capabilityRegistry";
import { createChatDb } from "./helpers/chatSession";

/**
 * Golden examples: the owner's four real missions, the company request, and a bare request. They assert the STRUCTURED
 * understanding and the reply TYPE (ask one question / go to the plan), never the exact prose.
 */
const TODAY = new Date(Date.UTC(2026, 9, 20));

const M1 = "عايز أجيب أكتر ١٠ فيديوهات مشاهدة من ٥ قنوات أخبار على يوتيوب مع كل التعليقات ورابط الفيديو";
const M1_NAMED = "عايز أكتر ١٠ فيديوهات مشاهدة من قناة @AlArabiya وقناة @SkyNewsArabia على يوتيوب مع كل التعليقات";
const M1_NAMED_WITH_CAP = "عايز أكتر ١٠ فيديوهات مشاهدة من قناة @AlArabiya وقناة @SkyNewsArabia على يوتيوب مع كل التعليقات حتى ٢٠٠٠ تعليق";
const M2 = "عايز كل فيديوهات قناة الفيفا الرسمية على يوتيوب عن منتخب مصر في كأس العالم ٢٠٢٦ مع كل التعليقات";
const M2_WITH_CAP = "عايز كل فيديوهات قناة الفيفا الرسمية على يوتيوب عن منتخب مصر في كأس العالم ٢٠٢٦ مع كل التعليقات حتى ٣٠٠٠ تعليق";
const M3 = "عايز ٣٧٥٠٠ بوست وردود على إكس عن ماتش مصر والمغرب";
const M3_WITH_WINDOW = "عايز 37,500 بوست وردود على إكس عن ماتش مصر والمغرب آخر شهر";
const M4 = "عايز فيديوهات وبوستات فيسبوك عن الجواز وقايمة المنقولات والطلاق في مصر من ١ يناير ٢٠٢٦ إلى ٣١ سبتمبر ٢٠٢٦";
const B2B = "عايز ٥٠ شركة مقاولات في مصر ومديريها مع الإيميلات والتليفونات";
const COMPANY = "عايز شركتين كهرباء في مصر";

const understand = (text: string) => understandMission(text, { today: TODAY });

describe("M1: five channels, top 10 by views, all comments with the video link", () => {
  it("is understood as ranked comments and asks ONE thing at a time: the channels first, then the comment cap", () => {
    const u = understand(M1);
    expect(u).toMatchObject({ kind: "social_ranked_comments", platform: "youtube", topPerChannel: 10, rankedBy: "views", allComments: true, needsCap: true });
    expect(u.channels).toEqual({ count: 5, named: [] });
    expect(u.window).toMatchObject({ status: "resolved", source: "open_scope" });
    expect(u.missing).toEqual(["channels", "cap"]);
    expect(nextStep(u)).toMatchObject({ type: "ask_one", id: "social_channel_required" });
  });

  it("with the channels named but «all comments» uncapped, asks only for the cap", () => {
    const u = understand(M1_NAMED);
    expect(u.channels.named).toEqual(["@AlArabiya", "@SkyNewsArabia"]);
    expect(u.missing).toEqual(["cap"]);
    expect(nextStep(u)).toMatchObject({ type: "ask_one", id: "volume_cap_required" });
  });

  it("with the channels and a cap, goes straight to the plan; the cap is the 2000, never the top 10", () => {
    const u = understand(M1_NAMED_WITH_CAP);
    expect(u.volume).toBe(2000);
    expect(u.topPerChannel).toBe(10);
    expect(u.missing).toEqual([]);
    expect(nextStep(u)).toEqual({ type: "plan" });
  });
});

describe("M2: the official FIFA channel, Egypt's national team, the 2026 World Cup, all comments", () => {
  it("proposes the tournament window from the event, names the channel, and goes to the plan", () => {
    const u = understand(M2);
    expect(u).toMatchObject({ kind: "social_channel_topic", platform: "youtube", allComments: true });
    expect(u.channels.named[0]).toContain("الفيفا");
    expect(u.subject).toContain("منتخب مصر");
    expect(u.window).toMatchObject({ status: "resolved", source: "event", dateFrom: "2026-06-11", dateTo: "2026-07-19" });
    // «all comments» always carries a cap: asked once, then the plan
    expect(nextStep(u)).toMatchObject({ type: "ask_one", id: "volume_cap_required" });
    expect(nextStep(understand(M2_WITH_CAP))).toEqual({ type: "plan" });
  });
});

describe("M3: about 37,500 X posts and replies about one match", () => {
  it("reads the volume and the replies, and asks ONE question: the period", () => {
    const u = understand(M3);
    expect(u).toMatchObject({ kind: "social_feed", platform: "x", volume: 37500, includeReplies: true });
    expect(u.subject).toContain("ماتش مصر والمغرب");
    expect(u.missing).toEqual(["window"]);
    const step = nextStep(u);
    expect(step).toMatchObject({ type: "ask_one", id: "social_time_required" });
    expect((step as any).options).toEqual(["آخر شهر", "آخر ٣ شهور", "آخر ٦ شهور", "آخر سنة"]);
  });

  it("reads «37,500» with a separator as the same number and goes to the plan once a period is given", () => {
    const u = understand(M3_WITH_WINDOW);
    expect(u.volume).toBe(37500);
    expect(u.window).toMatchObject({ status: "resolved", source: "relative" });
    expect(nextStep(u)).toEqual({ type: "plan" });
  });
});

describe("M4: Facebook posts and videos about marriage, dowry and divorce, 1 Jan to the end of September", () => {
  it("uses the dates, corrects 31/9 to 30/9 with a plain note, and goes to the plan", () => {
    const u = understand(M4);
    expect(u).toMatchObject({ kind: "social_feed", platform: "facebook" });
    expect(u.window).toMatchObject({ status: "resolved", source: "stated", dateFrom: "2026-01-01", dateTo: "2026-09-30" });
    expect((u.window as any).noteAr).toContain("٣٠ سبتمبر");
    expect(nextStep(u)).toEqual({ type: "plan" });
  });
});

describe("companies and decision makers", () => {
  it("a company request with country, sector and count goes to the plan and needs no period", () => {
    const u = understand(COMPANY);
    expect(u).toMatchObject({ kind: "companies", volume: 2, needsCap: false });
    expect(u.window.status).toBe("not_needed");
    expect(nextStep(u)).toEqual({ type: "plan" });
  });

  it("companies to decision makers with work e-mails and phones is the people capability", () => {
    const u = understand(B2B);
    expect(u).toMatchObject({ kind: "people", volume: 50 });
    expect(u.window.status).toBe("not_needed");
  });
});

describe("a request with no goal", () => {
  it("asks ONE question, with three plain options", () => {
    const u = understand("عايز بيانات");
    expect(u.missing).toEqual(["goal"]);
    expect(nextStep(u)).toMatchObject({ type: "ask_one", id: "goal_required", options: ["بيانات منصات اجتماعية", "شركات", "صناع قرار"] });
  });
});

describe("the voice: what was understood, then at most one question", () => {
  const requests = [M1, M1_NAMED, M1_NAMED_WITH_CAP, M2, M2_WITH_CAP, M3, M3_WITH_WINDOW, M4, B2B, COMPANY];

  it.each(requests)("the understanding line is one Arabic sentence with Arabic digits: %s", (text) => {
    const line = understoodLineAr(understand(text))!;
    expect(line).toMatch(/^فهمت أنك تريد/);
    expect(line.split(/[.؟!]\s*/).filter(Boolean)).toHaveLength(1);
    expect(line).not.toMatch(/[0-9]|undefined|null|NaN|JSON|endpoint|API/);
  });

  it.each(["social_time_required", "social_platform_required", "social_channel_required", undefined])("the intro to the question «%s» is at most two sentences and never a form", (id) => {
    for (const text of [M1, M3, M4]) {
      const intro = consultantIntroAr(text, id as string | undefined, { today: TODAY });
      expect(intro.split(/[.؟!]\s*/).filter(Boolean).length).toBeLessThanOrEqual(2);
      expect(isFormStyleIntro(intro)).toBe(false);
      expect(intro).not.toMatch(/[A-Za-z0-9]|محتاج أعرف|جاوبني|:/);
    }
  });

  it("the period question's intro carries the plain warning and the cap suggestion", () => {
    const intro = consultantIntroAr(M3, "social_time_required", { today: TODAY });
    expect(intro).toContain("لم تذكر فترة زمنية");
    expect(intro).toContain("أعداد كبيرة جدًا");
    expect(intro).toContain("سقف");
  });

  it("form-style intros are recognised and generic text is not", () => {
    for (const bad of ["عشان أجهز لك خطة دقيقة، محتاج أعرف:", "قبل ما أجهز الخطة، جاوبني على الأسئلة دي:", "أحتاج أعدّل الخطة، لحظة.", "", "محتاج أعرف:"]) {
      expect(isFormStyleIntro(bad), bad).toBe(true);
    }
    expect(isFormStyleIntro(GENERIC_ASK_ONE_INTRO_AR)).toBe(false);
    expect(isFormStyleIntro("فهمت أنك تريد ١٠ تغريدات عن كرة السلة على منصة إكس.")).toBe(false);
  });
});

describe("through the chat handler (model stubbed to throw)", () => {
  function run(message: string) {
    const db = createChatDb();
    const handler = new ChatHandler(db as any);
    const model = vi.fn(async () => { throw new Error("the model must not be called"); });
    (handler as any).llm.executeTurn = model;
    return { model, send: () => handler.handleUserMessage({ userId: "u_golden", message, userBalance: 5000 }) as Promise<any> };
  }

  it("M3 without a period: reply type ask_clarification, exactly one question, the intro says what was understood", async () => {
    const { model, send } = run("عايز ٣٠٠ بوست على إكس عن ماتش مصر والمغرب");
    const r = await send();
    expect(model).not.toHaveBeenCalled();
    expect(r.outputType).toBe("ask_clarification");
    expect(r.clarificationItems).toHaveLength(1);
    expect(r.clarificationItems[0].id).toBe("social_time_required");
    expect(r.contentAr).toMatch(/^فهمت أنك تريد/);
    expect(r.contentAr).toContain("ماتش مصر والمغرب");
    expect(r.contentAr).not.toMatch(/محتاج أعرف|جاوبني/);
  });

  it("the company request: reply type propose_plan, no question", async () => {
    const { model, send } = run(COMPANY);
    const r = await send();
    expect(model).not.toHaveBeenCalled();
    expect(r.outputType).toBe("propose_plan");
    expect(r.clarificationItems ?? []).toHaveLength(0);
  });

  it("a stated period and a stated count: reply type propose_plan, no question", async () => {
    const { send } = run("هات ١٠ تغريدات عن كرة السلة في ٢٠٢٥");
    const r = await send();
    expect(r.outputType).toBe("propose_plan");
    expect(r.clarificationItems ?? []).toHaveLength(0);
  });
});

describe("the assistant prompt", () => {
  it("carries the consultant contract: one question, no form, no assumed period, plan on the right", () => {
    const prompt = buildSystemPrompt({ sanitizedCapabilities: sanitizeCapabilitiesForLlm(APPROVED_CAPABILITY_CATALOG) as any[] });
    for (const needle of ["CONSULTANT REPLY CONTRACT", "ONE specific question", "Never ask for what the customer already stated", "point to the plan on the right", "آخر ٦ شهور"]) {
      expect(prompt).toContain(needle);
    }
    expect(prompt).not.toContain("Default Time Window");
  });
});
