import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MISSION_TEMPLATES } from "../src/lib/missionTemplates";
import { findUnresolvedResearchPlaceholder } from "../src/lib/researchPlaceholders";
import { understandMission, nextStep } from "../src/lib/consultantCopy";
import EmptyChat from "../src/app/dashboard/chat/components/EmptyChat";

const TODAY = new Date(Date.UTC(2026, 9, 20));
const byId = (id: string) => MISSION_TEMPLATES.find((t) => t.id === id)!;

describe("big-mission templates", () => {
  it("there are seven: the four original ones, then TikTok channels to top videos to comments, comments of named YouTube videos, posts of a named Facebook page", () => {
    expect(MISSION_TEMPLATES.map((t) => t.id)).toEqual(["channels_top_videos_comments", "event_monitoring_x", "facebook_topic_dates", "companies_decision_makers", "tiktok_channels_top_videos_comments", "youtube_named_videos_comments", "facebook_page_posts"]);
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
    const channels = understandMission(byId("channels_top_videos_comments").promptAr.replace("[@القناة_الأولى و@القناة_الثانية و@القناة_الثالثة]", "@AlArabiya و@SkyNewsArabia و@AlJazeera"), { today: TODAY });
    // the template carries its own comment cap, so the filled template goes straight to the plan
    expect(channels).toMatchObject({ kind: "social_ranked_comments", platform: "youtube", topPerChannel: 10, volume: 2000 });
    expect(channels.channels.named).toEqual(["@AlArabiya", "@SkyNewsArabia", "@AlJazeera"]);
    // the template says how many channels it is for, so fewer given later is noticed
    expect(channels.channels.count).toBe(3);
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

describe("a chip opens a form and sends nothing (UI pass 1, items 3, 4 and 9: the long template cards and the ready sentences are gone from the start page)", () => {
  const empty = readFileSync("src/app/dashboard/chat/components/EmptyChat.tsx", "utf8");
  const formCard = readFileSync("src/app/dashboard/chat/components/TemplateFormCard.tsx", "utf8");
  const page = readFileSync("src/app/dashboard/chat/page.tsx", "utf8");
  const hero = readFileSync("src/components/landing/HeroLens.tsx", "utf8");

  it("the start page shows short chips (one line each, wrapping), not the glued, cut template cards", () => {
    const html = renderToStaticMarkup(createElement(EmptyChat, { firstName: "سلمى", zeroBalance: false, composer: null, onSend: () => {} }));
    expect(html).toContain('data-testid="example-chips"');
    expect(html).toContain("flex-wrap");
    expect(html).not.toContain('data-testid="mission-templates"');
    for (const t of MISSION_TEMPLATES) expect(html).not.toContain(t.titleAr);
  });

  it("a chip only opens its form; it never calls onSend; an open form sends nothing until «أرسل» is pressed", () => {
    const onSend = vi.fn();
    const closed = renderToStaticMarkup(createElement(EmptyChat, { firstName: "", zeroBalance: false, composer: null, onSend }));
    expect(closed).not.toContain('data-testid="template-form"');
    const open = renderToStaticMarkup(createElement(EmptyChat, { firstName: "", zeroBalance: false, composer: null, onSend, initialTemplateId: "account_posts" }));
    expect(open).toContain('data-testid="template-form"');
    expect(open).toContain('data-testid="template-form-send"');
    // the request is built from the fields: an account is a required, empty field; the placeholder account of the old example is nowhere
    expect(open).not.toContain("@tiktok");
    expect(open).toContain("(مطلوب)");
    expect(onSend).not.toHaveBeenCalled();
    // the chip's handler changes the open form and nothing else; the form's own submit is the only sender, and only with a built text
    expect(empty).toContain("setOpenId(openId === t.id ? null : t.id)");
    expect(empty.slice(empty.indexOf("onClick={() => setOpenId"), empty.indexOf("{t.chipAr}"))).not.toContain("onSend");
    expect(formCard).toContain("const text = buildTemplateRequest(form, values);");
    expect(formCard).toContain("if (!text || sending || disabled) return;");
    expect(formCard.indexOf("onSend(text)")).toBeGreaterThan(formCard.indexOf("if (!text || sending || disabled) return;"));
    const handler = page.slice(page.indexOf("<EmptyChat"), page.indexOf("{!chatEmpty && !conversationLoading"));
    expect(handler).toContain("onSend={(text) => handleSendMessage(text)}");
    expect(handler).not.toContain("setInputText(prompt)");
  });

  it("the landing hero offers no templates (audit phase 3: one box, one action); sending goes to sign-up", () => {
    expect(hero).not.toContain("landing-mission-templates");
    expect(hero).not.toContain("useTemplate");
    expect(hero).toContain('router.push(user ? "/dashboard/chat" : "/register")');
  });
});
