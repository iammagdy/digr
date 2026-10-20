import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MISSION_TEMPLATES } from "../src/lib/missionTemplates";
import { findUnresolvedResearchPlaceholder } from "../src/lib/researchPlaceholders";
import { understandMission, nextStep } from "../src/lib/consultantCopy";
import EmptyChat from "../src/app/dashboard/chat/components/EmptyChat";

const TODAY = new Date(Date.UTC(2026, 9, 20));
const byId = (id: string) => MISSION_TEMPLATES.find((t) => t.id === id)!;

describe("big-mission templates", () => {
  it("there are four: channels to top videos to comments, event monitoring on X, Facebook topic and dates, companies to decision makers", () => {
    expect(MISSION_TEMPLATES.map((t) => t.id)).toEqual(["channels_top_videos_comments", "event_monitoring_x", "facebook_topic_dates", "companies_decision_makers"]);
  });

  it("every text is Arabic only, with Arabic digits, no emoji, no price, no provider or technical word", () => {
    for (const t of MISSION_TEMPLATES) {
      for (const text of [t.titleAr, t.flowAr, t.outputAr]) {
        expect(text).not.toMatch(/[A-Za-z0-9]|\p{Extended_Pictographic}|undefined|null|NaN|USD|\$|نقطة|جنيه|ج\.م/u);
      }
      // the prompt may carry a Latin handle only inside its editable brackets (a sample), never outside them
      expect(t.promptAr.replace(/\[[^\]]*\]/g, "")).not.toMatch(/[A-Za-z0-9]|\p{Extended_Pictographic}/u);
      expect(t.promptAr).not.toMatch(/apify|icypeas|tikhub|openai|anthropic|claude|endpoint/i);
    }
  });

  it("an unedited template is not a request: the unresolved placeholder is caught, so it cannot be sent as it is", () => {
    for (const t of MISSION_TEMPLATES) expect(findUnresolvedResearchPlaceholder(t.promptAr), t.id).not.toBeNull();
  });

  it("each template, once its brackets are filled, is understood as the mission it names", () => {
    const channels = understandMission(byId("channels_top_videos_comments").promptAr.replace("[@القناة_الأولى و@القناة_الثانية]", "@AlArabiya و@SkyNewsArabia"), { today: TODAY });
    // the template carries its own comment cap, so the filled template goes straight to the plan
    expect(channels).toMatchObject({ kind: "social_ranked_comments", platform: "youtube", topPerChannel: 10, volume: 2000 });
    expect(channels.channels.named).toEqual(["@AlArabiya", "@SkyNewsArabia"]);
    expect(nextStep(channels)).toEqual({ type: "plan" });

    const x = understandMission(byId("event_monitoring_x").promptAr.replace("[اسم الحدث أو الموضوع]", "ماتش مصر والمغرب").replace("[الفترة: من تاريخ إلى تاريخ]", "من ١ يونيو ٢٠٢٦ إلى ٣٠ يونيو ٢٠٢٦"), { today: TODAY });
    expect(x).toMatchObject({ kind: "social_feed", platform: "x", volume: 1000, includeReplies: true });
    expect(x.window).toMatchObject({ status: "resolved", source: "stated", dateFrom: "2026-06-01", dateTo: "2026-06-30" });
    expect(nextStep(x)).toEqual({ type: "plan" });

    const fb = understandMission(byId("facebook_topic_dates").promptAr.replace("[الموضوع]", "الجواز والطلاق"), { today: TODAY });
    expect(fb).toMatchObject({ kind: "social_feed", platform: "facebook" });
    expect(fb.window).toMatchObject({ status: "resolved", dateFrom: "2026-01-01", dateTo: "2026-09-30" });
    expect(nextStep(fb)).toEqual({ type: "plan" });

    const b2b = understandMission(byId("companies_decision_makers").promptAr.replace("[نوع النشاط]", "مقاولات").replace("[الدولة]", "مصر"), { today: TODAY });
    expect(b2b).toMatchObject({ kind: "people", volume: 50 });
  });
});

describe("a template only fills the input", () => {
  const empty = readFileSync("src/app/dashboard/chat/components/EmptyChat.tsx", "utf8");
  const page = readFileSync("src/app/dashboard/chat/page.tsx", "utf8");
  const hero = readFileSync("src/components/landing/HeroLens.tsx", "utf8");

  it("the empty chat shows the four templates", () => {
    const html = renderToStaticMarkup(createElement(EmptyChat, { firstName: "سلمى", zeroBalance: false, onStart: () => {} }));
    for (const t of MISSION_TEMPLATES) {
      expect(html).toContain(t.titleAr);
      expect(html).toContain(`data-testid="mission-template-${t.id}"`);
    }
  });

  it("clicking one calls onStart(prompt), which in the chat page only sets the input text", () => {
    expect(empty).toContain("onClick={() => onStart(t.promptAr)}");
    const handler = page.slice(page.indexOf("<EmptyChat"), page.indexOf("{!chatEmpty && !conversationLoading"));
    expect(handler).toContain("setInputText(prompt);");
    expect(handler).not.toMatch(/handleSendMessage|fetch\(|handleStartExecution/);
  });

  it("on the landing page a template fills the box and sends nothing; sending goes to sign-up", () => {
    const fill = hero.slice(hero.indexOf("const useTemplate"), hero.indexOf("const useExample"));
    expect(fill).toContain("el.value = prompt;");
    expect(fill).not.toMatch(/submit|router\.push|savePendingQuestion/);
    expect(hero).toContain('router.push(user ? "/dashboard/chat" : "/register")');
    expect(hero).toContain('data-testid="landing-mission-templates"');
  });
});
