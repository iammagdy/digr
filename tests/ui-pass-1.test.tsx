import { readFileSync, existsSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import { fakeSupabase } from "./helpers/fakeSupabase";

const state = vi.hoisted(() => ({ user: null as any, admin: null as any }));
vi.mock("../src/lib/supabase/server", () => ({
  createServerSideClient: vi.fn(async () => ({ auth: { getUser: vi.fn(async () => ({ data: { user: state.user }, error: null })) } })),
  createAdminClient: vi.fn(() => state.admin),
}));
vi.mock("../src/lib/server/liveDailyCap", () => ({ liveDailyCapPoints: async () => undefined }));

import { GET as walletHistory } from "../src/app/api/wallet/history/route";
import { POST as estimatePost } from "../src/app/api/calculator/estimate/route";
import { customerMissionView, minutesAr } from "../src/lib/agentMission/customerView";
import { expectedTimeOf } from "../src/lib/agentMission/expectedTime";
import { estimateMissionMinutes } from "../src/lib/agentMission/price";
import { AGENT_CLOSE_NOTICE_AR } from "../src/lib/agentMission/constants";
import { AgentMissionCardBody } from "../src/components/mission/AgentMissionCard";
import { MissionStepRow } from "../src/components/mission/MissionPlanPanel";
import { PLANNING_STEP_TITLES, PLANNING_USUAL_TIME_AR } from "../src/lib/missionView";
import { formatIsoForCustomer, formatSampleCell, isIsoDateText } from "../src/lib/customerDates";
import { dedupeNearIdentical } from "../src/lib/dedupeLines";
import EmptyChat from "../src/app/dashboard/chat/components/EmptyChat";
import TemplateFormCard from "../src/app/dashboard/chat/components/TemplateFormCard";
import Composer from "../src/app/dashboard/chat/components/Composer";
import { TEMPLATE_FORMS, buildTemplateRequest, initialTemplateValues, templateFormById, templateProblems, wholeNumber } from "../src/lib/templateForms";
import HelpPage from "../src/app/help/page";
import { HELP_SECTIONS } from "../src/lib/helpContent";
import { HELP_CENTER_URL, SUPPORT_URL } from "../src/lib/constants";
import { isPublicPath } from "../src/lib/publicPaths";
import { PRICING_FAQ_AR } from "../src/lib/pricingPage";
import { requestsShownCounts } from "../src/lib/requests/tabs";
import { isSafeRequestId, readRequestFacts, saveRequestFacts } from "../src/lib/requests/facts";
import { groupMissionRows } from "../src/lib/walletView";
import { jobWalletLineAr } from "../src/lib/agentMission/walletLine";
import { actionableUnreadCount } from "../src/lib/notificationBadge";
import { PLATFORM_REQUEST_GROUPS, startRequestHref } from "../src/lib/servicesRequestExamples";
import ServicesCatalogPage from "../src/app/services/page";
import PublicCalculatorPage from "../src/app/calculator/page";
import { PROVIDER_NAME_PATTERN } from "../src/lib/publicCapabilityIds";

const src = (file: string) => readFileSync(file, "utf8");
const html = (node: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(node);
const text = (markup: string) => markup.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");

// ------------------------------------------------------------------------------------------------------------------------------- fixtures
const T0 = Date.parse("2026-10-30T10:00:00Z");
const plan = {
  summary_ar: "ستستلم ملف إكسل بـ ٥٠ تغريدة عن «القهوة» خلال آخر ٣ أشهر.",
  assumptions_ar: ["المقصود: تغريدات عامة عن القهوة بالعربية خلال آخر ٣ أشهر.", "المقصود تغريدات عامة عن القهوة بالعربية خلال آخر ٣ أشهر", "الردود لا تُحتسب ضمن العدد المطلوب."],
  notes_ar: [],
  stages: [{
    key: "tweets", title_ar: "التغريدات", endpoint_id: "x.search", expected_rows: 50, planned_rows: 50, parent_key: null, deliver: true,
    filters: [{ kind: "period", enabled: true, days: 90, field: "createdAt" }],
    columns: [{ key: "createdAt", title_ar: "التاريخ والوقت" }, { key: "text", title_ar: "نص التغريدة" }],
    sample_rows: [{ createdAt: "2026-01-15T10:30:00.000Z", text: "أحلى فنجان قهوة في الصباح مع أصحابي في وسط البلد وهذه جملة طويلة لا يجوز قطعها من منتصفها أبدًا لأنها بيانات الملف" }, { createdAt: "2026-01-14", text: "ثانية" }],
  }],
  price: { max_charge_points: 200, reserve_points: 230 },
  expected_minutes: estimateMissionMinutes([{ rows: 50 }]),
};
const row = (over: Record<string, unknown> = {}) => ({ id: "m1", status: "plan_ready", question_ar: null, plan_public: plan, reserved_points: 230, unit_price_points: 4, delivered_units: null, charged_points: null, summary_ar: null, files: null, created_at: "2026-10-30T09:59:00Z", ...over }) as any;
const ev = (id: number, over: Record<string, unknown> = {}) => ({ id, kind: "progress", message_ar: "جارٍ", counts: null, created_at: "2026-10-30T10:00:00Z", ...over }) as any;
const planView = () => customerMissionView({ mission: row(), events: [], queue: { ahead: 0, running: 0, workerAlive: true }, now: T0 });
const runningView = () => customerMissionView({ mission: row({ status: "executing" }), events: [ev(1, { counts: { stage: 1, saved: 12 } })], queue: { ahead: 0, running: 1, workerAlive: true }, now: T0 + 5000 });

// ============================================================================================================== 1. the help menu
describe("1. «مركز المساعدة» and «تواصل مع الدعم» go somewhere", () => {
  it("both links have a target that is a page of the site (not a mailto that does nothing without a mail app)", () => {
    expect(HELP_CENTER_URL).toBe("/help");
    expect(SUPPORT_URL).toBe("/contact");
    const shell = src("src/components/app/AppShell.tsx");
    expect(shell).toContain('{ label: "مركز المساعدة", icon: SIDEBAR_ICONS.help, href: HELP_CENTER_URL }');
    expect(shell).toContain('{ label: "تواصل مع الدعم", icon: SIDEBAR_ICONS.support, href: SUPPORT_URL }');
    expect(existsSync("src/app/help/page.tsx")).toBe(true);
    expect(existsSync("src/app/contact/page.tsx")).toBe(true);
    expect(isPublicPath("/help")).toBe(true);
  });
  it("the help page answers how to ask, how points work, approval, files and refunds, in the site's own sentences, and links to the contact form", () => {
    const page = html(createElement(HelpPage));
    for (const section of HELP_SECTIONS) expect(page).toContain(section.titleAr);
    expect(HELP_SECTIONS.map((s) => s.id)).toEqual(["ask", "points", "approval", "files", "refunds"]);
    expect(page).toContain(PRICING_FAQ_AR[0][1]);
    expect(page).toContain(PRICING_FAQ_AR[1][1]);
    expect(page).toContain('href="/contact"');
    expect(page).toContain("mailto:");
    // the page is Arabic: no Latin word in what is read (the support address itself is the one Latin text)
    expect(text(page).replace(/support@diger\.tech/g, "")).not.toMatch(/[A-Za-z]{2,}/);
  });
});

// ======================================================================================================== 2. the status after «اعتمد»
describe("2. after «اعتمد» the card says what started, how far it is, the time and that the page can be closed", () => {
  it("the view carries the expected time (the plan's own number), the count so far and the line «وصلنا …»", () => {
    const v = runningView();
    expect(v.expectedAr).toBe(minutesAr(plan.expected_minutes));
    expect(v.savedSoFar).toBe(12);
    expect(v.progressLineAr).toBe("١٢ من ٥٠ تغريدة");
    expect(v.periodAr).toBe("آخر ٩٠ يومًا");
  });
  it("a running mission shows the started line, the progress, the estimate and the close-page sentence ON THE PAGE", () => {
    const markup = html(createElement(AgentMissionCardBody, { view: runningView(), isGuest: false }));
    expect(markup).toContain('data-testid="agent-started"');
    expect(text(markup)).toContain("بدأنا جمع ٥٠ تغريدة، نحو دقيقتين.");
    expect(markup).toContain('data-testid="agent-progress-line"');
    expect(text(markup)).toContain("وصلنا ١٢ من ٥٠ تغريدة");
    expect(markup).toMatch(/role="progressbar"[^>]*aria-valuenow="12"/);
    expect(AGENT_CLOSE_NOTICE_AR).toBe("تقدر تقفل الصفحة وهنبعتلك إشعار لما يخلص.");
    expect(markup).toContain(AGENT_CLOSE_NOTICE_AR);
  });
  it("the moment the approval is accepted the plan card turns into that status at once (before the next read), and the buttons are gone", () => {
    const markup = html(createElement(AgentMissionCardBody, { view: planView(), isGuest: false, approved: true }));
    expect(markup).toContain('data-testid="agent-started"');
    expect(markup).toContain(AGENT_CLOSE_NOTICE_AR);
    expect(markup).not.toContain('data-testid="agent-approve"');
  });
  it("while the approval is on its way the button says so and a status line is shown (no silent frozen page)", () => {
    const markup = html(createElement(AgentMissionCardBody, { view: planView(), isGuest: false, busy: true, pendingAction: "approve" }));
    expect(markup).toContain("جاري الاعتماد…");
    expect(markup).toContain('data-testid="agent-approving"');
    expect(markup).toContain("disabled");
  });
});

// ========================================================================================================== 3. the start page
describe("3. the start page is one large input and a few chips", () => {
  it("the composer is placed in the middle in its hero form, the bottom bar is not drawn while the chat is empty, and nothing else but the chips and the zero-balance line is on the page", () => {
    const composer = html(createElement(Composer, { value: "", onChange: () => {}, onSend: () => {}, hero: true }));
    expect(composer).toContain('data-testid="composer-hero"');
    expect(composer).toContain("min-h-[56px]");
    expect(composer).not.toContain("يدعم إرفاق ملفات الاستبعاد");
    const markup = html(createElement(EmptyChat, { firstName: "منى", zeroBalance: false, composer: createElement("div", { "data-testid": "the-composer" }), onSend: () => {} }));
    expect(markup).toContain('data-testid="the-composer"');
    const chips = markup.match(/data-testid="example-chip-/g) ?? [];
    expect(chips.length).toBeGreaterThanOrEqual(4);
    expect(chips.length).toBeLessThanOrEqual(6);
    expect(markup).not.toContain("mission-template-");
    expect(markup).not.toContain("welcome-balance");
    expect(src("src/app/dashboard/chat/page.tsx")).toContain("{!chatEmpty && <Composer ");
  });
});

// ================================================================================================ 4. templates open a form, send nothing
describe("4. an example opens a small form; the request is built from its fields and sent only by «أرسل»", () => {
  it("every form starts with sensible defaults and an empty required field (no placeholder account), so nothing can be built before the customer fills it", () => {
    for (const form of TEMPLATE_FORMS) {
      const values = initialTemplateValues(form);
      expect(buildTemplateRequest(form, values), form.id).toBeNull();
      for (const field of form.fields.filter((f) => f.required)) expect(values[field.id], `${form.id}.${field.id}`).toBe("");
      for (const field of form.fields.filter((f) => !f.required && f.kind !== "textarea")) expect(values[field.id] !== undefined, `${form.id}.${field.id}`).toBe(true);
      expect(Object.keys(templateProblems(form, values)).length).toBeGreaterThan(0);
    }
    expect(JSON.stringify(TEMPLATE_FORMS.map((f) => f.fields.map((x) => x.defaultValue)))).not.toContain("@tiktok");
    // Arabic-Indic digits in every default, so the inputs never show «30» (UI pass 1, item 14)
    for (const form of TEMPLATE_FORMS) for (const field of form.fields) expect(field.defaultValue, `${form.id}.${field.id}`).not.toMatch(/[0-9]/);
    expect(initialTemplateValues(templateFormById("account_posts")!).count).toBe("٣٠");
  });
  it("the account form builds the request from platform, account, count and period", () => {
    const form = templateFormById("account_posts")!;
    const values = { ...initialTemplateValues(form), platform: "tiktok", account: "alahly", count: "٢٥", period: "آخر شهر" };
    expect(buildTemplateRequest(form, values)).toBe("أريد أحدث ٢٥ منشور من حساب @alahly على تيك توك خلال آخر شهر.");
    expect(buildTemplateRequest(form, { ...values, platform: "facebook", account: "صفحة الأهلي", period: "" })).toBe("أريد أحدث ٢٥ منشور من صفحة صفحة الأهلي على فيسبوك.");
  });
  it("a link field must look like a link, a count is read in Arabic or Latin digits and kept inside the limits", () => {
    const form = templateFormById("video_comments")!;
    expect(templateProblems(form, { ...initialTemplateValues(form), link: "مش رابط" }).link).toBeTruthy();
    expect(buildTemplateRequest(form, { ...initialTemplateValues(form), link: "https://youtu.be/abc123", count: "٧٥" })).toContain("حتى ٧٥ تعليق");
    expect(wholeNumber("١٢٣", 50)).toBe(123);
    expect(wholeNumber("abc", 50)).toBe(50);
    expect(wholeNumber("999999", 50, 1, 5000)).toBe(5000);
  });
  it("the card renders every field with its label, marks the required ones, has one «أرسل» and sends nothing when only rendered", () => {
    for (const form of TEMPLATE_FORMS) {
      const onSend = vi.fn();
      const markup = html(createElement(TemplateFormCard, { form, onSend, onClose: () => {} }));
      for (const field of form.fields) expect(markup, `${form.id}.${field.id}`).toContain(field.labelAr);
      expect((markup.match(/data-testid="template-form-send"/g) ?? []).length).toBe(1);
      expect(markup).toContain("(مطلوب)");
      expect(markup).toContain("min-h-12");
      expect(onSend).not.toHaveBeenCalled();
    }
  });
});

// =================================================================================================================== 5. planning steps
describe("5. the planning steps read plainly and a finished step is not struck through", () => {
  it("the four steps and the usual-time line are the owner's words", () => {
    expect([...PLANNING_STEP_TITLES]).toEqual(["فهمنا طلبك", "لقينا المصادر", "بنجرب عينة صغيرة للتأكد من الجودة", "بنجهز السعر"]);
    expect(PLANNING_USUAL_TIME_AR).toBe("عادةً دقيقة أو اتنين، ولن يُخصم شيء قبل موافقتك.");
    const planning = customerMissionView({ mission: row({ status: "planning", plan_public: null }), events: [ev(1, { counts: { samples: 2 } })], callsMade: 2, now: T0 });
    const markup = html(createElement(AgentMissionCardBody, { view: planning, isGuest: false }));
    expect(markup).toContain('data-testid="agent-planning-usual"');
    expect(text(markup)).toContain(PLANNING_USUAL_TIME_AR);
  });
  it("no technical label of the old wording is left anywhere a customer reads", () => {
    for (const file of ["src/lib/missionView.ts", "src/lib/agentMission/customerView.ts", "src/components/mission/MissionPlanPanel.tsx", "src/components/mission/AgentMissionCard.tsx"]) {
      const code = src(file).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      for (const old of ["تجربة عينة من كل مرحلة", "جُرّبت", "بعض المصادر أبطأ من المعتاد", "المصدر أبطأ من المعتاد"]) expect(code, `${file}: ${old}`).not.toContain(old);
    }
  });
  it("a done step has the green check mark and its name with no strike-through; no step of any state is struck through", () => {
    for (const state of ["done", "running", "waiting", "stopped"] as const) {
      const markup = html(createElement(MissionStepRow, { step: { id: "s", titleAr: "جمع التغريدات", state, reasonAr: "سبب" } }));
      expect(markup, state).not.toContain("line-through");
    }
    const done = html(createElement(MissionStepRow, { step: { id: "s", titleAr: "جمع التغريدات", state: "done" } }));
    expect(done).toContain('data-testid="step-icon-done"');
    expect(done).toContain("var(--ok)");
  });
});

// ======================================================================================================================== 6. the plan card
describe("6. the plan card", () => {
  it("leads with «هتستلم إيه», then the count, the period, the price and the hold; «اعتمد» comes before the details, which are folded", () => {
    const markup = html(createElement(AgentMissionCardBody, { view: planView(), isGuest: false }));
    const at = (needle: string) => markup.indexOf(needle);
    expect(at("هتستلم إيه")).toBeGreaterThan(-1);
    expect(at("هتستلم إيه")).toBeLessThan(at('data-testid="agent-facts"'));
    expect(at('data-testid="agent-facts"')).toBeLessThan(at('data-testid="agent-approve"'));
    expect(at('data-testid="agent-approve"')).toBeLessThan(at('data-testid="agent-details"'));
    const facts = text(markup.slice(at('data-testid="agent-facts"'), at('data-testid="agent-approve"')));
    for (const label of ["هتستلم", "الفترة", "السعر حتى", "حجز مؤقت", "الوقت المتوقع"]) expect(facts).toContain(label);
    expect(facts).toContain("آخر ٩٠ يومًا");
    // the details element is closed by default
    expect(markup).toMatch(/<details[^>]*data-testid="agent-details"/);
    expect(markup).not.toMatch(/<details[^>]*open[^>]*data-testid="agent-details"/);
    for (const inside of ["agent-assumptions", "agent-stages", "agent-samples", "agent-file-contents"]) expect(at(`data-testid="${inside}"`)).toBeGreaterThan(at('data-testid="agent-details"'));
    expect(markup).toContain("min-h-12");
  });
  it("the sample table shows no ISO date: dates are written in Arabic on the Cairo clock, and a date with no time stays a date", () => {
    expect(isIsoDateText("2026-10-30T21:59:00.000Z")).toBe(true);
    const winter = formatIsoForCustomer("2026-01-15T10:30:00.000Z");
    expect(winter).toBe("١٥ يناير ٢٠٢٦ في ١٢:٣٠ م");
    expect(formatIsoForCustomer("2026-01-14")).toBe("١٤ يناير ٢٠٢٦");
    expect(formatSampleCell("نص عادي لا يتغير 2026-01-14 داخله")).toBe("نص عادي لا يتغير 2026-01-14 داخله");
    const markup = html(createElement(AgentMissionCardBody, { view: planView(), isGuest: false }));
    expect(markup).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(markup).not.toMatch(/T\d{2}:\d{2}/);
    expect(text(markup)).toContain("١٥ يناير ٢٠٢٦ في ١٢:٣٠ م");
  });
  it("the sample table scrolls inside its own box and wraps its cells; a long cell is not cut", () => {
    const markup = html(createElement(AgentMissionCardBody, { view: planView(), isGuest: false }));
    const table = markup.slice(markup.indexOf('data-testid="agent-samples"'), markup.indexOf('data-testid="agent-file-contents"'));
    expect(table).toContain("overflow-x-auto");
    expect(table).toContain("whitespace-normal");
    expect(table).toContain("break-words");
    expect(table).not.toContain("truncate");
    expect(table).toContain("لا يجوز قطعها من منتصفها أبدًا لأنها بيانات الملف");
  });
  it("money and file sentences are never cut: the price note and the file contents appear whole, with no truncation class around them", () => {
    const markup = html(createElement(AgentMissionCardBody, { view: planView(), isGuest: false }));
    expect(text(markup)).toContain("السعر المعروض هو سعر التسليم الكامل؛ لو سُلّم أقل يُخصم بنسبة ما سُلّم فقط، ولو لم يُسلَّم شيء لا يُخصم شيء.");
    expect(text(markup)).toContain("يضم الملف: التاريخ والوقت، نص التغريدة.");
    for (const testId of ["agent-price", "agent-price-note", "agent-file-contents"]) {
      const at = markup.indexOf(`data-testid="${testId}"`);
      const open = markup.lastIndexOf("<", at);
      expect(markup.slice(open, markup.indexOf(">", at)), testId).not.toMatch(/truncate|line-clamp|text-ellipsis/);
    }
  });
  it("«كيف فهمنا طلبك» does not list two near-identical points; points that differ by a number are both kept", () => {
    expect(planView().assumptionsAr).toEqual(["المقصود: تغريدات عامة عن القهوة بالعربية خلال آخر ٣ أشهر.", "الردود لا تُحتسب ضمن العدد المطلوب."]);
    expect(dedupeNearIdentical(["آخر ٣ أشهر من التغريدات العامة", "آخر ٦ أشهر من التغريدات العامة"])).toHaveLength(2);
    expect(dedupeNearIdentical(["بدون ردود.", "بدون ردود"])).toEqual(["بدون ردود."]);
  });
});

// ============================================================================================================== 7. «طلباتي» and the details
describe("7. «طلباتي»: one number for the tab and the footer, and «التفاصيل» opens the request's own page at once", () => {
  const counts = { all: 225, running: 1, done: 200, ended: 20, refunded: 4 };
  it("the footer says how many of the tab's own number are on the page: «الكل ٢٢٥» goes with «٢٤ من ٢٢٥», never «٢٠ من ٢٢١»", () => {
    expect(requestsShownCounts({ tab: "all", counts, listed: 20, pending: 4 })).toEqual({ shown: 24, total: 225 });
    expect(requestsShownCounts({ tab: "done", counts, listed: 20, pending: 4 })).toEqual({ shown: 20, total: 200 });
    const page = src("src/app/dashboard/requests/page.tsx");
    expect(page).toContain("requestsShownCounts(");
    expect(page).toContain("{index ? formatAr(counts[id]) : \"…\"}");
    expect(page).not.toContain("counts.all - (");
  });
  it("«التفاصيل» (and the title, and «متابعة التقدم») open the request's page with the row's facts; only the retry button goes to the chat", () => {
    const page = src("src/app/dashboard/requests/page.tsx");
    expect(page).toContain("router.push(`/dashboard/requests/${encodeURIComponent(facts.id)}`)");
    expect(page).toContain("saveRequestFacts(facts)");
    // a mission row (a request that never became a job) no longer links straight to the chat
    expect(page).not.toContain("href={`/dashboard/chat?c=${encodeURIComponent(r.conversationId)}`}");
    expect(page).toContain('if (k === "refunded" && !isDeterministicFailureAr(j.errorAr)) return void openFile(j, true);');
  });
  it("the details page paints the facts first (from the row, else a skeleton), reads the job and the mission in ONE parallel round, and mounts the heavy card only after that", () => {
    const page = src("src/app/dashboard/requests/[id]/page.tsx");
    expect(page).toContain("readRequestFacts(id)");
    expect(page).toContain('data-testid="details-skeleton"');
    expect(page).toContain("await Promise.all([");
    expect(page.indexOf('{read === "done" && missionId ? <AgentMissionCard')).toBeGreaterThan(page.indexOf("await Promise.all(["));
    // the chat is its own button, and the link to the conversation is resolved last
    expect(page).toContain('data-testid="details-open-chat"');
    expect(page.indexOf("/conversation")).toBeGreaterThan(page.indexOf("await Promise.all(["));
    expect(isSafeRequestId("job_quote_0a25ec81")).toBe(true);
    expect(isSafeRequestId("a,b)")).toBe(false);
  });
  it("the facts a row hands over are read back by the page, and a missing or foreign entry is ignored", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("sessionStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) });
    saveRequestFacts({ id: "job_abc123", title: "٥٠ تغريدة", stateAr: "مكتمل", createdAt: "2026-10-30T10:00:00Z", nounPlural: "تغريدات", delivered: 50, requested: 50, pointsAr: "٢٠٠ نقطة" });
    expect(readRequestFacts("job_abc123")?.title).toBe("٥٠ تغريدة");
    expect(readRequestFacts("job_zzz999")).toBeNull();
    store.set("diger_request_facts_job_bad111", "{not json");
    expect(readRequestFacts("job_bad111")).toBeNull();
    vi.unstubAllGlobals();
  });
});

// ================================================================================================================ 8. the wallet
describe("8. the wallet: one line per mission by default", () => {
  it("a job with no mission row (an older request) gets its one line from the job's own numbers; an open job gets none", () => {
    expect(jobWalletLineAr({ id: "j1", status: "completed", delivered_units: 50, charged_credits: 200, reserved_credits: 230 })).toBe("خُصم ٢٠٠ نقطة مقابل ٥٠ عنصرًا");
    expect(jobWalletLineAr({ id: "j2", status: "failed", delivered_units: 0, charged_credits: 0, reserved_credits: 230 })).toBe("لم يُخصم شيء؛ حجز مؤقت مُحرَّر ٢٣٠ نقطة");
    expect(jobWalletLineAr({ id: "j3", status: "running", delivered_units: 0, charged_credits: null, reserved_credits: 230 })).toBeNull();
    expect(src("src/lib/agentMission/walletLine.ts")).not.toMatch(/سجل|صف/);
  });
  it("the history answer carries the line of EVERY finished job (mission or older), so the wallet shows one line per job and folds the hold, the charge and the release under «تفاصيل الحركات»", async () => {
    const USER = "11111111-1111-1111-1111-111111111111";
    state.user = { id: USER, email: "c@x.test", app_metadata: {}, user_metadata: {} };
    const rows = (jobId: string, at: string) => [
      { id: `res_${jobId}`, user_id: USER, delta: -230, type: "reserve", job_id: jobId, created_at: at },
      { id: `chg_${jobId}`, user_id: USER, delta: -200, type: "charge", job_id: jobId, created_at: at },
      { id: `rel_${jobId}`, user_id: USER, delta: 230, type: "release", job_id: jobId, created_at: at },
    ];
    state.admin = fakeSupabase({
      missing: ["credit_ledger_typed"],
      tables: {
        credit_ledger: [...rows("job_m", "2026-10-29T00:52:00Z"), ...rows("job_old", "2026-10-28T00:52:00Z"), { id: "res_run", user_id: USER, delta: -230, type: "reserve", job_id: "job_run", created_at: "2026-10-30T00:00:00Z" }],
        missions: [{ id: "msn_1", user_id: USER, job_id: "job_m", status: "completed", delivered_units: 50, charged_points: 200, reserved_points: 230, plan_public: { stages: [{ title_ar: "التغريدات", deliver: true }] } }],
        jobs: [
          { id: "job_old", user_id: USER, status: "completed", delivered_units: 50, charged_credits: 200, reserved_credits: 230 },
          { id: "job_run", user_id: USER, status: "running", delivered_units: 0, charged_credits: null, reserved_credits: 230 },
        ],
      },
    }) as any;
    const response = await walletHistory(new NextRequest("http://localhost/api/wallet/history"));
    const body = await response.json();
    const lines = new Set(body.rows.map((r: any) => r.missionLineAr).filter(Boolean));
    expect([...lines].sort()).toEqual(["خُصم ٢٠٠ نقطة مقابل ٥٠ تغريدة", "خُصم ٢٠٠ نقطة مقابل ٥٠ عنصرًا"].sort());
    const entries = groupMissionRows(body.rows.map((r: any) => ({ ...r, $id: r.id })));
    // two folded groups (3 rows each) and the open job's hold as a single row: 3 entries, not 7
    expect(entries.map((e) => e.kind)).toEqual(expect.arrayContaining(["mission", "mission", "row"]));
    expect(entries).toHaveLength(3);
    expect(entries.flatMap((e) => (e.kind === "row" ? [e.row] : e.rows))).toHaveLength(7);
    // where the time goes is visible in the network panel
    expect(response.headers.get("Server-Timing")).toMatch(/auth;dur=\d+.*ledger;dur=\d+.*missions;dur=\d+.*jobs;dur=\d+.*total;dur=\d+/);
  });
  it("the wallet page does not say «جاري تحميل الأرقام» while it loads, shows the balance first, and cuts no note or explanation", () => {
    const page = src("src/app/dashboard/topup/page.tsx");
    expect(page).not.toContain("جاري تحميل الأرقام");
    expect(page.indexOf('{balance.status === "failed" ? "غير متاح" : balanceText(balance)}')).toBeLessThan(page.indexOf('data-testid="wallet-released-month"'));
    expect(page).not.toContain("truncate");
    expect(page).toContain("تفاصيل الحركات");
    expect(page).toContain('data-testid="wallet-released-explainer"');
  });
});

// ================================================================================================================ 9. chips are readable
describe("9. the suggestion buttons are readable at 380px", () => {
  it("the chips wrap, are short, never truncate and never carry the arrows of the old template titles", () => {
    const markup = html(createElement(EmptyChat, { firstName: "", zeroBalance: false, composer: null, onSend: () => {} }));
    const at = markup.indexOf('data-testid="example-chips"');
    const group = markup.slice(markup.lastIndexOf("<div", at), markup.indexOf("</div>", at));
    expect(group).toContain("flex-wrap");
    expect(group).not.toContain("truncate");
    expect(group).not.toContain("←");
    for (const form of TEMPLATE_FORMS) expect(form.chipAr.length, form.id).toBeLessThanOrEqual(32);
  });
});

// ======================================================================================================== 10. the calculator
describe("10. the calculator: three choices, one result, and the plan card's own time", () => {
  it("the same mission reads the same time in the calculator and on the card", async () => {
    for (const rows of [5, 50, 300, 1000]) {
      const view = customerMissionView({ mission: row({ plan_public: { ...plan, stages: [{ ...plan.stages[0], expected_rows: rows, planned_rows: rows }], expected_minutes: estimateMissionMinutes([{ rows }]) } }), events: [], now: T0 });
      expect(view.expectedAr, String(rows)).toBe(expectedTimeOf([{ rows }]).textAr);
    }
    const body = await (await estimatePost({ headers: new Headers(), json: async () => ({ kind: "posts", platform: "x", volume: 50 }) } as any)).json();
    expect(body.expectedAr).toBe(expectedTimeOf([{ rows: 50 }]).textAr);
    expect(body.expectedAr).not.toContain("أقل من دقيقة");
    expect(src("src/app/api/calculator/estimate/route.ts")).toContain("expectedTimeOf(");
  });
  it("the page is the three choices, one result and the rules; no second calculator, no free-text box, no audit table", () => {
    const page = html(createElement(PublicCalculatorPage));
    for (const id of ["estimate-platform", "estimate-kind", "estimate-volume"]) expect(page).toContain(`id="${id}"`);
    expect(page).not.toMatch(/<textarea|capability-select|جدول التدقيق|الكمية المسلَّمة/);
    expect(src("src/components/calculator/MissionEstimator.tsx")).toContain('data-testid="estimate-duration"');
  });
});

// =========================================================================================================== 11. the catalog
describe("11. the catalog groups by platform with plain «تقدر تطلب…» examples", () => {
  it("each platform has examples that all start «تقدر تطلب», lead to an example form that exists, and carry no provider or technical name", () => {
    expect(PLATFORM_REQUEST_GROUPS.map((g) => g.id)).toEqual(["facebook", "tiktok", "youtube", "x", "companies"]);
    for (const group of PLATFORM_REQUEST_GROUPS) {
      expect(group.examplesAr.length).toBeGreaterThanOrEqual(2);
      for (const line of group.examplesAr) { expect(line.startsWith("تقدر تطلب")).toBe(true); expect(line).not.toMatch(/[A-Za-z]|API|endpoint/); expect(line.match(PROVIDER_NAME_PATTERN)).toBeNull(); }
      expect(templateFormById(group.templateId), group.id).toBeDefined();
      expect(startRequestHref(group.templateId)).toBe(`/dashboard/chat?template=${group.templateId}`);
    }
  });
  it("the page opens with those groups and keeps the full list of platforms and services behind one fold", () => {
    const page = html(createElement(ServicesCatalogPage));
    expect(page.indexOf('data-testid="request-groups"')).toBeGreaterThan(-1);
    expect(page.indexOf('data-testid="request-groups"')).toBeLessThan(page.indexOf('data-testid="catalog-all"'));
    expect(page.indexOf('data-testid="catalog-all"')).toBeLessThan(page.indexOf('data-testid="services-counts"'));
    expect(page).toMatch(/<details[^>]*data-testid="catalog-all"/);
    expect(page).not.toMatch(/<details[^>]*open[^>]*data-testid="catalog-all"/);
    expect(page).toContain("ابدأ طلبًا");
    expect(page.match(PROVIDER_NAME_PATTERN)).toBeNull();
  });
  it("the start page opens the form named in the address (`?template=`)", () => {
    const markup = html(createElement(EmptyChat, { firstName: "", zeroBalance: false, composer: null, onSend: () => {}, initialTemplateId: "facebook_topic" }));
    expect(markup).toContain('data-template="facebook_topic"');
    expect(html(createElement(EmptyChat, { firstName: "", zeroBalance: false, composer: null, onSend: () => {}, initialTemplateId: "no_such_form" }))).not.toContain('data-testid="template-form"');
  });
});

// ======================================================================================================== 12. one layout everywhere
describe("12. every customer page has the same header, logo and side menu", () => {
  const AFFECTED = ["calculator", "services", "pricing", "contact", "legal", "help", "for"];
  it("the pages that had no header (calculator, catalog and its platform pages, prices, contact, terms and privacy, the pages for each kind of customer) are wrapped in the one frame; the dashboard already was", () => {
    for (const dir of AFFECTED) expect(src(`src/app/${dir}/layout.tsx`), dir).toContain("<SiteFrame>");
    expect(src("src/components/app/SiteFrame.tsx")).toContain("<AppShell allowGuest>");
    expect(src("src/app/dashboard/layout.tsx")).toContain("<AppShell>");
  });
  it("none of those pages has its own «ديجر — العودة للصفحة الرئيسية» text link or its own logo bar any more", () => {
    for (const file of ["src/app/calculator/page.tsx", "src/app/services/page.tsx", "src/app/pricing/page.tsx", "src/app/for/[segment]/page.tsx", "src/app/contact/ContactForm.tsx", "src/components/LegalPage.tsx", "src/app/help/page.tsx"]) {
      expect(src(file), file).not.toMatch(/الصفحة الرئيسية|→ الرئيسية/);
      expect(src(file), file).not.toContain("<Logo");
    }
  });
  it("the shell has the logo (in the side menu, and in the header on a phone), the side menu with the help links, and a header for a visitor too", () => {
    const shell = src("src/components/app/AppShell.tsx");
    expect(shell).toContain('<Link href="/" aria-label="ديجر"><Logo height={26} /></Link>');
    expect(shell).toContain('data-testid="header-logo"');
    expect(shell).toContain("if (!user && !isChat && !allowGuest) return null;");
    for (const label of ["مركز المساعدة", "تواصل مع الدعم", "الشروط والخصوصية", "حاسبة التكلفة", "كتالوج الخدمات"]) expect(shell).toContain(label);
  });
});

// ===================================================================================================================== 13. the bell
describe("13. the bell counts only what truly needs the customer", () => {
  it("thirty finished requests are not «٣٠+ تحتاج انتباهك»; a turned-down top-up is", () => {
    const routine = Array.from({ length: 30 }, () => ({ kind: "job_done", read: false }));
    expect(actionableUnreadCount(routine)).toBe(0);
    expect(actionableUnreadCount([...routine, { kind: "topup_rejected", read: false }, { kind: "topup_rejected", read: true }])).toBe(1);
    const shell = src("src/components/app/AppShell.tsx");
    // a routine unread update shows a plain dot, never a number or the words «تحتاج انتباهك»
    expect(shell).toContain('data-testid="bell-dot"');
    expect(shell).toContain('notifs.unread > 0 ? "الإشعارات، فيها جديد"');
  });
});

// ============================================================================================================== 14. digits and messages
describe("14. Arabic-Indic digits and whole messages", () => {
  it("no customer text in the touched sources carries a Latin number next to a word (8 خانات, 30 يومًا)", () => {
    const files = ["src/app/login/page.tsx", "src/app/register/page.tsx", "src/app/reset/page.tsx", "src/app/dashboard/settings/page.tsx", "src/components/AuthLayout.tsx", "src/app/api/account/delete/route.ts", "src/app/dashboard/topup/page.tsx", "src/app/dashboard/requests/page.tsx", "src/components/app/AppShell.tsx"];
    for (const file of files) {
      const code = src(file).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      expect(code, file).not.toMatch(/\d+ (?:خانات|ميجابايت|دقيقة|دقائق|ثانية|يوم|يوماً|يومًا|ساعة|نقطة)/);
    }
    expect(src("src/app/dashboard/settings/page.tsx")).toContain("٨ خانات");
  });
  it("a failure or state sentence is shown whole: no line clamp or truncation on the notes of «طلباتي», the pending block or the top-up list", () => {
    const requests = src("src/app/dashboard/requests/page.tsx");
    expect(requests.slice(requests.indexOf('data-testid="request-note"') - 120, requests.indexOf('data-testid="request-note"'))).not.toMatch(/line-clamp|truncate/);
    expect(requests).not.toContain("line-clamp-2");
    expect(src("src/components/mission/OpenMissionsList.tsx")).not.toContain("truncate");
  });
});
