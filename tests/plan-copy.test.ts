import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runConversation } from "./helpers/chatSession";
import { formatStructuredClarificationAnswers } from "../src/functions/shared/clarification";
import { PLAN_READY_DESKTOP_AR, PLAN_READY_MOBILE_AR, REPLIES_HEDGE_AR } from "../src/lib/consultantCopy";
import { socialSubjectText } from "../src/lib/socialTasks";

const answer = (questionId: string, question: string, value: string) =>
  formatStructuredClarificationAnswers({ type: "clarification_answers", answers: [{ questionId, question, value }] } as any);

const X_REQUEST = "كل تغريدات مباراة مصر والمغرب في كأس العالم وردودها";

describe("X posts with their replies, through the real chat path", () => {
  it("every sentence that mentions the replies says «إن أعادها المصدر»: the understanding line and the plan", async () => {
    const { responses } = await runConversation([
      X_REQUEST,
      answer("social_time_required", "ما الفترة الزمنية التي تهمّك؟", "آخر شهر"),
      answer("volume_cap_required", "ما الحد الأقصى لعدد السجلات الذي تريده؟", "٥٠٠ سجل"),
    ]);
    expect(responses[0].contentAr).toContain(`مع ردودها ${REPLIES_HEDGE_AR}`);
    expect(responses[1].contentAr).toContain(`مع ردودها ${REPLIES_HEDGE_AR}`);
    expect(responses[2].outputType).toBe("propose_plan");
    expect(responses[2].contentAr).toContain("مع ردودها إن أعادها المصدر");
    expect(responses[2].planQuote.summaryAr).toContain("مع ردودها إن أعادها المصدر");
    for (const response of responses) {
      for (const text of [response.contentAr, response.planQuote?.summaryAr].filter(Boolean)) {
        for (const match of String(text).matchAll(/مع ردودها(?! إن أعادها المصدر)/g)) throw new Error(`bare replies sentence: ${text.slice(Math.max(0, match.index - 40), match.index + 30)}`);
      }
    }
  });

  it("no stray word reaches the subject: not «إجابة», not the unit of the cap answer («سجل»)", async () => {
    const { responses } = await runConversation([
      X_REQUEST,
      answer("social_time_required", "ما الفترة الزمنية التي تهمّك؟", "آخر شهر"),
      answer("volume_cap_required", "ما الحد الأقصى لعدد السجلات الذي تريده؟", "٥٠٠ سجل"),
    ]);
    const plan = responses[2];
    expect(plan.planQuote.summaryAr).toContain("«مباراة مصر والمغرب كأس العالم»");
    expect(plan.planQuote.items[0].params.query).toBe("مباراة مصر والمغرب كأس العالم");
    for (const text of [plan.contentAr, plan.planQuote.summaryAr, plan.planQuote.items[0].params.query]) {
      expect(text).not.toMatch(/إجابة|الإجابة|كأس العالم سجل/);
    }
  });

  it("a stored answer text never adds its unit to the subject, and a subject that really has the word keeps it", () => {
    expect(socialSubjectText("كل تغريدات مباراة مصر والمغرب في كأس العالم وردودها\nالحد الأقصى المطلوب: ٥٠٠ سجل")).toBe("مباراة مصر والمغرب كأس العالم");
    expect(socialSubjectText("منشورات عن السجل التجاري الجديد")).toContain("السجل");
    expect(socialSubjectText("الحد الأقصى المطلوب: ١٠٠٠ سجلات")).not.toContain("سجل");
  });
});

describe("«راجعها على …»: the sentence names the side the plan really opens on", () => {
  const page = readFileSync("src/app/dashboard/chat/page.tsx", "utf8");

  it("desktop says left, phone says the bottom sheet, and neither says right", () => {
    expect(PLAN_READY_DESKTOP_AR).toBe("جهزت لك الخطة، راجعها على اليسار.");
    expect(PLAN_READY_MOBILE_AR).toBe("جهزت لك الخطة، راجعها في النافذة التي ظهرت من الأسفل.");
    for (const text of [PLAN_READY_DESKTOP_AR, PLAN_READY_MOBILE_AR]) expect(text).not.toContain("اليمين");
  });

  it("matches the layout: the page is RTL, the chat is the first column (right) and the plan panel the second (left); a bottom sheet below the lg breakpoint", () => {
    const layout = readFileSync("src/app/layout.tsx", "utf8");
    expect(layout).toContain('dir="rtl"');
    const chatColumn = page.indexOf('data-screen-label="Chat"');
    const planPanel = page.indexOf('id="results-canvas"');
    expect(chatColumn).toBeGreaterThan(-1);
    expect(planPanel).toBeGreaterThan(chatColumn);
    expect(page).toContain("fixed inset-x-0 bottom-0 z-50");
    expect(page).toContain("lg:static");
  });

  it("the chat shows the desktop sentence only where the panel is a column, and the phone sentence only where it is a sheet", () => {
    expect(page).toContain('<span className="lg:hidden">{PLAN_READY_MOBILE_AR}</span><span className="hidden lg:inline">{PLAN_READY_DESKTOP_AR}</span>');
  });

  it("no customer-visible text anywhere still says the plan is on the right", () => {
    const files = ["src/lib/consultantCopy.ts", "src/app/dashboard/chat/page.tsx", "src/functions/shared/chatHandler.ts", "src/app/dashboard/chat/components/PlanQuoteCard.tsx", "src/app/dashboard/chat/components/ResultsCanvas.tsx"];
    for (const file of files) expect(readFileSync(file, "utf8")).not.toMatch(/راجعها على اليمين|الخطة على اليمين|على يمين الشاشة/);
  });
});
