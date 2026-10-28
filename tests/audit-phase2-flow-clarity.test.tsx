import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import nextConfig from "../next.config.mjs";
import DetailsBlanks from "../src/app/dashboard/chat/components/DetailsBlanks";
import EmptyChat, { STARTER_EXAMPLES } from "../src/app/dashboard/chat/components/EmptyChat";
import Composer, { ATTACH_WAIT_AR } from "../src/app/dashboard/chat/components/Composer";
import MissionEstimator from "../src/components/calculator/MissionEstimator";
import { proseDigitsAr } from "../src/lib/arabicDigits";
import { COMPANY_COLUMNS, companyColumnTitleAr } from "../src/lib/companyColumns";
import { emptyPromisedFieldTitles, orderPreviewColumns, splitEmptyColumns } from "../src/lib/customerResultColumns";
import { isUntitledConversation, titleFromFirstRequest } from "../src/lib/conversationTitleFromRequest";
import { closePageLineAr } from "../src/lib/driverMode";
import { REQUEST_STATUS_LABEL_AR, PARTIAL_SENTENCE_AR, PARTIAL_STATUS_AR, deliveredOfRequestedAr } from "../src/lib/jobs/requestStatus";
import { phraseDuration } from "../src/lib/missionDuration";
import { calculatorSlugForEstimate, estimateFormProblemAr, estimateMission } from "../src/lib/missionEstimate";
import { actionableUnreadCount } from "../src/lib/notificationBadge";
import { formatPhoneDisplay } from "../src/lib/phoneDisplay";
import { planCountLineAr } from "../src/lib/planCounts";
import { buildPriceRows, homePriceStrip } from "../src/lib/pricingPage";
import { topupReviewSentenceAr } from "../src/lib/topupConfig";

const src = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const html = (node: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(node);

describe("audit phase 2: short addresses (point 24)", () => {
  it("/terms and /privacy redirect permanently to the legal pages", async () => {
    const redirects = await nextConfig.redirects!();
    expect(redirects).toContainEqual({ source: "/terms", destination: "/legal/terms", permanent: true });
    expect(redirects).toContainEqual({ source: "/privacy", destination: "/legal/privacy", permanent: true });
  });
});

describe("audit phase 2: one navigation, honest titles (point 21)", () => {
  const shell = src("src/components/app/AppShell.tsx");
  it("the account menu lists only the theme, the admin entry and logout (settings and legal links live in the sidebar)", () => {
    const menuBlock = shell.slice(shell.indexOf("const menu:"), shell.indexOf("const helpLinks"));
    expect(menuBlock).not.toContain("الشروط والخصوصية");
    expect(menuBlock).not.toContain("الإعدادات");
    expect(menuBlock).toContain("تسجيل الخروج");
    expect(shell).toContain("PAGE_TITLES");
  });
  it("legal page tabs are short labels", () => {
    const legal = src("src/components/LegalPage.tsx");
    expect(legal).toContain("الشروط");
    expect(legal).toContain("الخصوصية");
    expect(legal).not.toContain("الشروط والأحكام والخصوصية");
  });
});

describe("audit phase 2: the bell counts only what needs the customer (point 25)", () => {
  it("counts an unread result and an unread rejected top-up, nothing else", () => {
    const items = [
      { kind: "job_done", read: false },
      { kind: "topup_rejected", read: false },
      { kind: "welcome", read: false },
      { kind: "topup_approved", read: false },
      { kind: "job_released", read: false },
      { kind: "job_done", read: true },
    ];
    expect(actionableUnreadCount(items)).toBe(2);
  });
  it("is zero (so no badge) when only notes remain", () => {
    expect(actionableUnreadCount([{ kind: "welcome", read: false }])).toBe(0);
    expect(actionableUnreadCount([])).toBe(0);
  });
  it("the shell renders the badge from the actionable count", () => {
    const shell = src("src/components/app/AppShell.tsx");
    expect(shell).toContain("notifs.actionableUnread");
    expect(shell).toContain('data-testid="bell-badge"');
  });
});

describe("audit phase 2: top-up texts promise nothing the code cannot keep (point 26)", () => {
  it("without a configured time the sentence is the owner-approved one, in Arabic-Indic digits only", () => {
    const sentence = topupReviewSentenceAr(null);
    expect(sentence).toBe("غالبًا يتم الاعتماد خلال ١٥ دقيقة، وبحد أقصى ٢٤ ساعة، وتصلك رسالة عند إضافة النقاط.");
    expect(sentence).not.toMatch(/\d/);
  });
  it("with a configured time the sentence states exactly that time", () => {
    expect(topupReviewSentenceAr("خلال ساعة في أيام العمل")).toContain("ومدة المراجعة المتوقعة خلال ساعة في أيام العمل");
  });
});

describe("audit phase 2: one closing instruction per driver (point 27)", () => {
  it("in tab mode no sentence tells the customer they can close the page", () => {
    expect(closePageLineAr("tab")).toBe("أبقِ الصفحة مفتوحة حتى تكتمل المهمة.");
    expect(closePageLineAr("tab")).not.toContain("تقدر تقفل");
  });
  it("in cron mode the closing line is the only place that says it", () => {
    expect(closePageLineAr("cron")).toContain("تقدر تقفل الصفحة");
  });
  it("the long-mission note does not promise a message or a page the tab driver cannot keep", () => {
    const tab = phraseDuration({ optimisticSeconds: 30 * 3600, pessimisticSeconds: 40 * 3600, driver: "tab" } as never);
    expect(tab.longNoteAr).toBe("هذه مهمة طويلة قد تستغرق أكثر من يوم؛ تُنفَّذ على دفعات.");
    const cron = phraseDuration({ optimisticSeconds: 30 * 3600, pessimisticSeconds: 40 * 3600, driver: "cron" } as never);
    expect(cron.longNoteAr).toContain("من صفحة الطلبات");
  });
  it("the requests page uses the driver-honest line while running", () => {
    expect(src("src/app/dashboard/requests/page.tsx")).toContain("closePageLineAr(driverMode)");
  });
});

describe("audit phase 2: why the paperclip is off (point 30)", () => {
  const props = { value: "", onChange: () => {}, onSend: () => {}, onStop: () => {} } as never;
  it("while a reply is running the composer says when attaching returns", () => {
    const markup = html(createElement(Composer, { ...(props as object), disabled: true } as never));
    expect(markup).toContain(ATTACH_WAIT_AR);
    expect(markup).toContain('data-testid="attach-wait"');
    expect(markup).toContain('aria-describedby="chat-attach-wait"');
  });
  it("when idle there is no explanation to show", () => {
    expect(html(createElement(Composer, { ...(props as object), disabled: false } as never))).not.toContain('data-testid="attach-wait"');
  });
});

describe("audit phase 2: starter examples are complete requests (point 20)", () => {
  it("none has a bracket slot, each names a subject, and a click only fills", () => {
    expect(STARTER_EXAMPLES.length).toBeGreaterThanOrEqual(4);
    for (const example of STARTER_EXAMPLES) {
      expect(example.prompt).not.toMatch(/[\[\]()]/);
      expect(example.prompt.split(/\s+/).length).toBeGreaterThanOrEqual(4);
    }
    const markup = html(createElement(EmptyChat, { firstName: "", zeroBalance: false, onStart: () => {} }));
    for (const example of STARTER_EXAMPLES) expect(markup).toContain(example.label);
  });
  it("the company example states a count, a sector and a country", () => {
    expect(STARTER_EXAMPLES[0].prompt).toBe("ابحث لي عن ٥ شركات مقاولات في مصر في ملف إكسل");
  });
});

describe("audit phase 2: an old conversation gets a title from its first real request (point 17)", () => {
  it("skips a greeting, a card answer and a button, then takes the first real request", () => {
    const title = titleFromFirstRequest([
      { role: "user", content: "مرحبا" },
      { role: "user", content: '{"type":"clarification_answers","answers":[]}' },
      { role: "user", content: "عايز ٥٠ شركة مقاولات في مصر" },
    ]);
    expect(title).toContain("شركة مقاولات");
  });
  it("returns null when there is no real request, and only placeholders count as untitled", () => {
    expect(titleFromFirstRequest([{ role: "user", content: "مرحبا" }])).toBeNull();
    expect(isUntitledConversation("محادثة جديدة")).toBe(true);
    expect(isUntitledConversation("")).toBe(true);
    expect(isUntitledConversation("شركات مقاولات في مصر")).toBe(false);
  });
});

describe("audit phase 2: a plan waiting for approval is not hidden on reopen (point 19)", () => {
  it("the chat page opens the canvas for a restored plan only while it can be approved", () => {
    const page = src("src/app/dashboard/chat/page.tsx");
    expect(page).toContain("getQuoteApprovalState");
    expect(page).toMatch(/canApprove[\s\S]{0,400}shouldShowPlanPanel|shouldShowPlanPanel[\s\S]{0,400}canApprove/);
  });
});

describe("audit phase 2: the question card has one primary action (point 16)", () => {
  const questions = [
    { id: "q1", text: "ما القطاع؟", type: "single", options: ["مقاولات", "أخرى"], allowOther: true },
    { id: "q2", text: "ما الدولة؟", type: "single", options: ["مصر", "السعودية"], allowOther: false },
  ];
  const markup = html(createElement(DetailsBlanks, { questions, onComplete: () => {} }));
  it("shows the progress as «سؤال ١ من ٢» and one «إجابة ومتابعة» button", () => {
    expect(markup).toContain("سؤال ١ من ٢");
    expect(markup).toContain('data-testid="clarification-progress"');
    expect(markup.match(/إجابة ومتابعة/g)?.length).toBe(1);
  });
  it("«السابق» is disabled on the first question and the skip is always offered", () => {
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>السابق<\/button>/);
    expect(markup).toContain("تخطّي السؤال");
  });
  it("a panel with ONE question shows no counter and no previous button (the next question is a new panel, so «سؤال ١ من ١» would repeat three times)", () => {
    const single = html(createElement(DetailsBlanks, { questions: [questions[0]], onComplete: () => {} }));
    expect(single).not.toContain("سؤال ١ من ١");
    expect(single).not.toContain('data-testid="clarification-progress"');
    expect(single).not.toContain("السابق");
    expect(single.match(/إجابة ومتابعة/g)?.length).toBe(1);
  });
  it("answers already given come back as a list with an edit button", () => {
    const source = src("src/app/dashboard/chat/components/DetailsBlanks.tsx");
    expect(source).toContain('data-testid="clarification-answers"');
    expect(source).toContain("تعديل");
    expect(source).toContain("السابق");
  });
  it("question and option text show Arabic-Indic digits while the sent value is unchanged", () => {
    const withNumbers = html(createElement(DetailsBlanks, {
      questions: [{ id: "q1", text: "كم عدد النتائج، 10 أو 25؟", type: "single", options: ["حتى 10 نتائج", "حتى 25 نتيجة"], allowOther: false }],
      onComplete: () => {},
    }));
    expect(withNumbers).toContain("حتى ١٠ نتائج");
    expect(withNumbers).toContain("١٠ أو ٢٥");
    expect(src("src/app/dashboard/chat/components/DetailsBlanks.tsx")).toContain("onClick={() => choose(option)}");
  });
});

describe("audit phase 2: counts read as words and one money sentence (point 15)", () => {
  const item = (slug: string, volume: number) => [{ capabilitySlug: slug, targetVolumeMax: volume, params: {} }] as never;
  it("small counts are spelled the Arabic way, larger counts keep the digit", () => {
    expect(planCountLineAr(item("icypeas-companies-search", 5))).toContain("حتى ٥ ");
    expect(planCountLineAr(item("icypeas-companies-search", 1))).toContain("واحد");
    expect(planCountLineAr(item("icypeas-companies-search", 2))).toContain("سجلين");
    expect(planCountLineAr(item("icypeas-companies-search", 50))).toContain("٥٠");
  });
  it("the card no longer prints the cap and hold lines as separate sentences", () => {
    const card = src("src/app/dashboard/chat/components/PlanQuoteCard.tsx");
    expect(card).not.toContain('data-testid="plan-cap-line"');
    expect(card).not.toContain('data-testid="plan-hold-line"');
    expect(card).toContain('data-testid="plan-price-vs-hold"');
    expect(card).toContain('data-testid="plan-edit-hint"');
  });
});

describe("audit phase 2: one status vocabulary (point 9)", () => {
  it("partial delivery has ONE label and ONE sentence everywhere", () => {
    expect(PARTIAL_STATUS_AR).toBe("مكتمل جزئيًا");
    expect(REQUEST_STATUS_LABEL_AR.partial).toBe(PARTIAL_STATUS_AR);
    expect(PARTIAL_SENTENCE_AR).toBe("اكتمل طلبك جزئيًا");
    expect(deliveredOfRequestedAr(40, 100)).toBe("تم تسليم ٤٠ من ١٠٠ سجل");
  });
  it("the old forms are gone from the customer text sources", () => {
    for (const file of ["src/lib/jobs/requestStatus.ts", "src/lib/server/jobNotices.ts", "src/lib/honestDisplay.ts"]) {
      const code = src(file).split("\n").filter((line) => !/^\s*(?:\/\/|\*|\/\*)/.test(line)).join("\n");
      expect(code).not.toContain("مكتمل جزئياً");
    }
  });
  it("the run files section and the status line use the shared sentence", () => {
    expect(src("src/app/dashboard/chat/components/RunSections.tsx")).toContain("PARTIAL_SENTENCE_AR");
    expect(src("src/app/dashboard/chat/page.tsx")).toContain("PARTIAL_SENTENCE_AR");
  });
});

describe("audit phase 2: results table (points 8 and 23)", () => {
  it("company columns have one shared list with Arabic titles and no duplicates", () => {
    const keys = COMPANY_COLUMNS.map((column) => column.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(companyColumnTitleAr("company_name")).toBe("اسم الشركة");
    expect(companyColumnTitleAr("industry")).toBe("مجال النشاط");
    expect(companyColumnTitleAr("nope")).toBeUndefined();
    for (const column of COMPANY_COLUMNS) expect(column.titleAr).not.toMatch(/[A-Za-z]/);
  });
  it("the workbook headers and widths come from the same list", () => {
    const generator = src("src/functions/shared/fileGenerators.ts");
    expect(generator).toContain("workbookCompanyColumns");
    expect(generator).toContain("formatPhoneDisplay");
  });
  it("availability columns go last and useful columns first", () => {
    const ordered = orderPreviewColumns(["phone_verification_status", "city", "company_name", "work_email_verification_status", "website"]);
    expect(ordered.slice(0, 3)).toEqual(["company_name", "website", "city"]);
    expect(ordered.slice(3).sort()).toEqual(["phone_verification_status", "work_email_verification_status"]);
  });
  it("a column empty in every row is reported, not dropped silently", () => {
    const rows = [{ company_name: "أ", city: "" }, { company_name: "ب", city: null }];
    expect(splitEmptyColumns(rows, ["company_name", "city"])).toEqual({ shown: ["company_name"], empty: ["city"] });
  });
  it("a promised field that came back empty everywhere is named in Arabic", () => {
    const rows = [{ company_name: "أ", work_email: "", phone: "+201001234567" }];
    expect(emptyPromisedFieldTitles(rows, ["work_email", "phone"])).toEqual(["البريد المهني"]);
    expect(emptyPromisedFieldTitles([], ["work_email"])).toEqual([]);
  });
  it("phones are written one way: Latin digits, plus sign, no separators", () => {
    expect(formatPhoneDisplay("'٠١٠٠١٢٣٤٥٦٧")).toMatch(/^\+?\d+$/);
    expect(formatPhoneDisplay("+20 (0) 22 123 4567")).not.toMatch(/[\s()]/);
    expect(formatPhoneDisplay("")).toBe("");
  });
  it("the screen hides empty columns behind a toggle and scrolls wide tables", () => {
    const canvas = src("src/app/dashboard/chat/components/ResultsCanvas.tsx");
    expect(canvas).toContain('data-testid="empty-columns-line"');
    expect(canvas).toContain('data-testid="table-scroll-hint"');
    expect(canvas).toContain('data-testid="promised-empty-notice"');
    expect(canvas).toContain('role="region"');
  });
});

describe("audit phase 2: the cost form always answers (point 1)", () => {
  it("a social kind without a platform asks for the platform in words", () => {
    expect(estimateFormProblemAr({ kind: "posts", platform: "", volume: 100, budget: 0 })).toBe("اختر المنصة لنحسب لك التكلفة.");
  });
  it("companies need no platform and a plain volume is calculable", () => {
    expect(estimateFormProblemAr({ kind: "companies", platform: null, volume: 100, budget: 0 })).toBeNull();
  });
  it("neither a volume nor a budget says what to write, and a volume the route refuses is said before sending", () => {
    expect(estimateFormProblemAr({ kind: "companies", volume: 0, budget: 0 })).toContain("اكتب العدد المطلوب");
    expect(estimateFormProblemAr({ kind: "companies", volume: 5_000_000, budget: 0 })).toContain("الحد الأقصى");
  });
  it("every calculable input gets a price or a clear note, never nothing", () => {
    for (const volume of [1, 5, 50, 100, 1000, 100000]) {
      const result = estimateMission({ kind: "companies", volume });
      expect(["ok", "needs_cap", "needs_platform", "unsupported"]).toContain(result.status);
      if (result.status === "ok") expect(result.expectedPoints).toBeGreaterThan(0);
    }
  });
  it("the platform field stays on the form (resting) for companies instead of disappearing", () => {
    const markup = html(createElement(MissionEstimator));
    expect(markup).toContain('data-testid="estimate-platform-field"');
    expect(markup).toContain("disabled");
  });
  it("the detailed calculator follows the kind chosen in the estimate form", () => {
    expect(calculatorSlugForEstimate("companies")).toBe("icypeas-companies-search");
    expect(calculatorSlugForEstimate("posts", "x")).toBeTruthy();
    expect(src("src/app/calculator/page.tsx")).toContain("onSelectionChange");
  });
});

describe("audit phase 2: numbers and words (point 22)", () => {
  it("customer-facing digits are Arabic-Indic, handles and files are untouched", () => {
    expect(proseDigitsAr("حتى 10 نتائج")).toBe("حتى ١٠ نتائج");
    expect(proseDigitsAr("من 1 يناير إلى 30 سبتمبر 2026")).toBe("من ١ يناير إلى ٣٠ سبتمبر ٢٠٢٦");
    expect(proseDigitsAr("حساب @user123 ووسم #tag2")).toBe("حساب @user123 ووسم #tag2");
    expect(proseDigitsAr("ملف report2026.xlsx")).toBe("ملف report2026.xlsx");
  });
  it("no customer-facing source glues an Arabic word to a digit without the conjunction letter", () => {
    const glued = /[ء-غف-ي][٠-٩0-9]/;
    for (const file of ["src/lib/jobs/requestStatus.ts", "src/lib/server/jobNotices.ts", "src/lib/planCounts.ts", "src/lib/topupConfig.ts"]) {
      for (const line of src(file).split("\n")) {
        if (line.trim().startsWith("//") || line.trim().startsWith("*")) continue;
        for (const match of line.matchAll(/[ء-ي]+[٠-٩0-9]/g)) {
          // only the single conjunction «و» (and the «ب»/«ل»/«ك» prefixes) may touch a number
          expect(/^[وبلك]$/.test(match[0].slice(0, -1)) || !glued.test(match[0])).toBe(true);
        }
      }
    }
  });
});

describe("audit phase 2/3: the home page price example is computed by the shared estimate (point 29)", () => {
  it("each strip item equals the public estimate for the same request", () => {
    const strip = homePriceStrip();
    expect(strip.map((item) => item.id)).toEqual(["companies", "x-posts"]);
    const companies = estimateMission({ kind: "companies", volume: 5 });
    const posts = estimateMission({ kind: "posts", platform: "x", volume: 100 });
    expect(companies.status === "ok" && strip[0].points === companies.expectedPoints).toBe(true);
    expect(posts.status === "ok" && strip[1].points === posts.expectedPoints).toBe(true);
  });
  it("the companies item agrees with the pricing page's unit price", () => {
    const unit = buildPriceRows().find((row) => row.id === "companies")!.unitPricePoints;
    // (the old line had no minimum) the one pricing rule: a mission is never charged less than 200 points
    expect(homePriceStrip()[0].points).toBe(Math.max(200, Math.ceil(5 * unit)));
  });
  it("the strip is rendered on the home page from the shared function, not typed by hand", () => {
    expect(src("src/app/page.tsx")).toContain("<PriceStrip />");
    expect(src("src/components/landing/Overview.tsx")).toContain("homePriceStrip()");
    expect(src("src/components/landing/Sections.tsx")).not.toContain("computePublicCalculatorQuote");
    expect(src("src/components/landing/Sections.tsx")).not.toContain("pts * 0.1");
  });
});

describe("audit phase 2: every starter example goes through the chat as a real request (point 20)", () => {
  it("none of them comes back asking for a bracket slot or an empty field", async () => {
    const { clearBriefCacheForTesting } = await import("../src/functions/shared/briefManager");
    const { runConversation } = await import("./helpers/chatSession");
    for (const example of STARTER_EXAMPLES) {
      clearBriefCacheForTesting();
      const { responses } = await runConversation([example.prompt]);
      const text = responses.map((response: any) => `${response.contentAr ?? ""} ${response.clarificationIntro ?? ""} ${JSON.stringify(response.clarificationQuestions ?? "")}`).join(" ");
      expect(responses.length).toBeGreaterThan(0);
      // the customer gets either a plan or a real question: never an empty reply
      expect(text.trim().length).toBeGreaterThan(10);
      expect(text).not.toMatch(/\[[\u0621-\u064A][^\]]*\]/);
      expect(text).not.toContain("المطلوب مطلوب");
    }
  });
});
