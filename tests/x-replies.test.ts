import { describe, expect, it, vi } from "vitest";
import { detectSocialIntent, getMissingSocialTaskInputs, socialSubjectText, wantsReplies } from "../src/lib/socialTasks";
import { consultantIntroAr } from "../src/lib/consultantCopy";
import { ChatHandler } from "../src/functions/shared/chatHandler";
import { createChatDb } from "./helpers/chatSession";

/**
 * «Posts and their replies» on X is one posts collection. The word «ردود» used to make it a comments request, and X has no
 * comments service, so the customer was asked which platform they meant even though they had said it.
 */
const M3 = "عايز ٣٧٥٠٠ بوست وردود على إكس عن ماتش مصر والمغرب آخر شهر";

describe("replies on X", () => {
  it.each([
    M3,
    "عايز كل تغريدات وردودها عن مباراة مصر والمغرب على إكس",
    "هات ١٠٠ تغريدة وردودها على إكس عن الأهلي",
    "عايز منشورات على إكس ومعاها ردودها عن كأس العالم",
  ])("is the X posts task, not comments: %s", (text) => {
    const intent = detectSocialIntent(text);
    expect(intent.platform).toBe("x");
    expect(intent.wantsComments).toBe(false);
    expect(intent.task).toBe("x_posts");
    expect(intent.discover).toBe("keyword");
    expect(getMissingSocialTaskInputs(text)).toEqual([]);
  });

  it("the reply words are detected, and never become part of the search subject", () => {
    expect(wantsReplies("بوست وردود على إكس")).toBe(true);
    expect(wantsReplies("تغريدات وردودها")).toBe(true);
    expect(wantsReplies("posts and replies")).toBe(true);
    expect(wantsReplies("عايز بوستات عن الردود الذكية")).toBe(false);
    expect(socialSubjectText(M3)).not.toMatch(/ردود/);
    expect(socialSubjectText("هات ١٠٠ تغريدة وردودها على إكس عن ماتش الأهلي")).toBe("ماتش الأهلي");
  });

  it("other comment words on X still mean comments (X has none), and replies elsewhere are unchanged", () => {
    expect(detectSocialIntent("عايز ١٠٠ تعليق على إكس عن ماتش الأهلي")).toMatchObject({ platform: "x", wantsComments: true, task: "comments" });
    expect(detectSocialIntent("عايز ردود الناس على فيديو على يوتيوب عن الأهلي")).toMatchObject({ platform: "youtube", wantsComments: true, task: "comments" });
  });

  it("the cap question for «all posts and replies» says posts, not comments", () => {
    const intro = consultantIntroAr("عايز كل تغريدات وردودها عن مباراة مصر والمغرب على إكس آخر شهر", "volume_cap_required", { today: new Date(Date.UTC(2026, 9, 20)) });
    expect(intro).toContain("كل المنشورات");
    expect(intro).not.toContain("التعليقات");
  });
});

describe("through the chat handler (model stubbed to throw)", () => {
  const run = async (message: string) => {
    const handler = new ChatHandler(createChatDb() as any);
    (handler as any).llm.executeTurn = vi.fn(async () => { throw new Error("the model must not be called"); });
    return handler.handleUserMessage({ userId: "u_x_replies", message, userBalance: 100000 }) as Promise<any>;
  };

  it("M3 phrasing goes straight to a plan: no platform question, X posts, the replies are named honestly", async () => {
    const reply = await run(M3);
    expect(reply.outputType).toBe("propose_plan");
    expect((reply.clarificationItems ?? []).map((q: any) => q.id)).not.toContain("social_platform_required");
    expect(reply.planQuote.items[0].capabilitySlug).toBe("social-x-posts");
    expect(reply.contentAr).toContain("مع ردودها إن أعادها المصدر");
    expect(JSON.stringify(reply.planQuote.items[0].params)).not.toMatch(/ردود/);
  });

  it("a comments request on X still asks the platform question (X has no comments)", async () => {
    const reply = await run("عايز ١٠٠ تعليق على إكس عن ماتش الأهلي آخر شهر");
    expect(reply.outputType).toBe("ask_clarification");
    expect(reply.clarificationItems.map((q: any) => q.id)).toEqual(["social_platform_required"]);
  });
});
