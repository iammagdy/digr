import { readFileSync } from "node:fs";
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { countAr, deliveredOfAr, GENERIC_ITEM_NOUN, ITEM_NOUNS, itemNounOf, itemNounOfPlan, knownItemNoun } from "../src/lib/agentMission/itemNoun";
import { heldPointsOf, moneyLineAr } from "../src/lib/agentMission/moneyText";
import { buildMissionNotice } from "../src/lib/agentMission/notices";
import { missionFileTitleAr, missionTitleAr, nounOfStageTitle } from "../src/lib/agentMission/fileNames";
import { customerMissionView } from "../src/lib/agentMission/customerView";
import { checkCustomerText } from "../src/lib/agentMission/text";
import { HAS_NUMBER, shortfallReasonAr } from "../agent/src/runMission";
import { buildMissionFiles } from "../agent/src/workbook";
import { renderEmailTemplate } from "../supabase/functions/send-email/templates";
import type { PricedPlan, PricedStage } from "../src/lib/agentMission/plan";
import { replay } from "./helpers/agentReplay";
import { callIds, lastOutputId, tregResult, type Results } from "./helpers/agentFakeWorld";
import { firstOutputId } from "./helpers/agentRelevance";

/**
 * CUSTOMER WORDING AND MONEY WORDING, one source of truth. The same rules are proved on five mission types (X posts, Facebook posts and comments, TikTok comments, companies and employees, Google Maps reviews):
 * the noun of the request with correct Arabic number agreement, never «صف» or «سجل»; correct titles; the delivered count said once and the same everywhere; the money exactly as the wallet shows it.
 */
const TYPES = [
  { name: "X posts", stage: "التغريدات التي تذكر محمد صلاح", noun: "تغريدة", plural: "تغريدات", subject: "محمد صلاح", title: "تغريدات عن محمد صلاح", fem: true },
  { name: "Facebook posts", stage: "المنشورات", noun: "منشور", plural: "منشورات", subject: "حملة مصر الخير", title: "منشورات عن حملة مصر الخير", fem: false },
  { name: "TikTok comments", stage: "تعليقات كل فيديو", noun: "تعليق", plural: "تعليقات", subject: "رحلات الأقصر", title: "تعليقات عن رحلات الأقصر", fem: false },
  { name: "companies", stage: "الشركات", noun: "شركة", plural: "شركات", subject: "الكهروميكانيكا", title: "شركات عن الكهروميكانيكا", fem: true },
  { name: "Maps reviews", stage: "تقييمات المكان", noun: "تقييم", plural: "تقييمات", subject: "كشري التحرير", title: "تقييمات عن كشري التحرير", fem: false },
] as const;

const planOf = (stageTitle: string, subject: string): any => ({ stages: [{ deliver: true, title_ar: stageTitle, relevance: { terms: [subject], subject_ar: subject } }] });

describe("C. the noun of the request, with the right form for every count", () => {
  it.each(TYPES)("$name: «$noun» is found from the stage title «$stage»", ({ stage, noun, plural }) => {
    const n = itemNounOf(stage);
    expect(n.singular).toBe(noun);
    expect(n.plural).toBe(plural);
  });

  it("the table counts correctly: one, two, three to ten, eleven and more (feminine and masculine nouns)", () => {
    const tweet = knownItemNoun("تغريدة")!;
    expect([0, 1, 2, 3, 10, 11, 250, 300].map((n) => countAr(n, tweet))).toEqual(["٠ تغريدة", "تغريدة واحدة", "تغريدتين", "٣ تغريدات", "١٠ تغريدات", "١١ تغريدة", "٢٥٠ تغريدة", "٣٠٠ تغريدة"]);
    expect(countAr(2, tweet, { subject: true })).toBe("تغريدتان");
    const comment = knownItemNoun("تعليق")!;
    expect([1, 2, 5, 12, 300].map((n) => countAr(n, comment))).toEqual(["تعليق واحد", "تعليقين", "٥ تعليقات", "١٢ تعليقًا", "٣٠٠ تعليقًا"]);
    const post = knownItemNoun("منشور")!;
    expect([1, 2, 5, 12].map((n) => countAr(n, post))).toEqual(["منشور واحد", "منشورين", "٥ منشورات", "١٢ منشورًا"]);
    const video = knownItemNoun("فيديو")!;
    expect([1, 2, 5, 12].map((n) => countAr(n, video))).toEqual(["فيديو واحد", "فيديوهين", "٥ فيديوهات", "١٢ فيديو"]);
    const company = knownItemNoun("شركة")!;
    expect([1, 2, 5, 12].map((n) => countAr(n, company))).toEqual(["شركة واحدة", "شركتين", "٥ شركات", "١٢ شركة"]);
    const person = knownItemNoun("موظف")!;
    expect([1, 2, 5, 12].map((n) => countAr(n, person))).toEqual(["موظف واحد", "موظفين", "٥ موظفين", "١٢ موظفًا"]);
    const review = knownItemNoun("تقييم")!;
    expect([1, 2, 5, 12].map((n) => countAr(n, review))).toEqual(["تقييم واحد", "تقييمين", "٥ تقييمات", "١٢ تقييمًا"]);
  });

  it("every noun of the table is complete, and no form is «صف» or «سجل»", () => {
    for (const n of [...ITEM_NOUNS, GENERIC_ITEM_NOUN]) {
      for (const form of [n.singular, n.dual, n.dualGen, n.plural, n.tamyiz]) expect(form.length).toBeGreaterThan(1);
      expect(n.dual).not.toBe(n.dualGen);
      expect(checkCustomerText(`${countAr(1, n)} ${countAr(2, n)} ${countAr(5, n)} ${countAr(12, n)}`).issues).toEqual([]);
    }
    expect(itemNounOf("أشياء غريبة").singular).toBe("عنصر");
  });

  it("delivered of requested is one wording: «٢٥٠ من ٣٠٠ تغريدة»; up to ten the noun is said twice in its own forms", () => {
    const tweet = knownItemNoun("تغريدة")!;
    expect(deliveredOfAr(250, 300, tweet)).toBe("٢٥٠ من ٣٠٠ تغريدة");
    expect(deliveredOfAr(300, 300, tweet)).toBe("٣٠٠ من ٣٠٠ تغريدة");
    expect(deliveredOfAr(3, 300, tweet)).toBe("٣ تغريدات من ٣٠٠ تغريدة");
    expect(deliveredOfAr(1, 300, tweet)).toBe("تغريدة واحدة من ٣٠٠ تغريدة");
    expect(deliveredOfAr(2, 5, tweet)).toBe("تغريدتين من ٥ تغريدات");
    expect(deliveredOfAr(0, 300, tweet)).toBe("٠ من ٣٠٠ تغريدة");
  });

  it("a plan whose delivered stages name one noun gives it; posts together with their comments are «عناصر»", () => {
    expect(itemNounOfPlan({ stages: [{ title_ar: "التغريدات", deliver: true }] }).singular).toBe("تغريدة");
    expect(itemNounOfPlan({ stages: [{ title_ar: "المنشورات", deliver: true }, { title_ar: "تعليقات كل منشور", deliver: true }] }).singular).toBe("عنصر");
    expect(itemNounOfPlan({ stages: [{ title_ar: "المكان", deliver: false }, { title_ar: "التقييمات", deliver: true }] }).singular).toBe("تقييم");
  });
});

describe("C. titles and file names are correct Arabic phrases", () => {
  it.each(TYPES)("$name: the mission title is «$title», the stage noun alone (never «تغريدات التي»)", ({ stage, subject, title }) => {
    expect(missionTitleAr({ plan: planOf(stage, subject), requestText: "" })).toBe(title);
    const date = new Date("2026-10-28T10:00:00Z");
    expect(missionFileTitleAr({ plan: planOf(stage, subject), requestText: "", delivered: 250, date })).toBe(`${title} - ٢٥٠ - ٢٨ أكتوبر ٢٠٢٦`);
  });

  it("the broken phrase of the live run is fixed", () => {
    expect(nounOfStageTitle("التغريدات التي تذكر محمد صلاح")).toBe("تغريدات");
    expect(nounOfStageTitle("تعليقات كل منشور")).toBe("تعليقات");
    expect(nounOfStageTitle("الموظفون")).toBe("موظفون");
    expect(missionTitleAr({ plan: planOf("التغريدات التي تذكر محمد صلاح", "محمد صلاح"), requestText: "" })).not.toContain("التي");
  });
});

describe("C. «صف» and «سجل» are not customer words (the agent's text is refused when it says them)", () => {
  it("rows and records are refused in any form; the verbs and descriptions that merely contain the letters are fine", () => {
    for (const bad of ["سُلّم ٢٥٠ من ٣٠٠ صفًا", "٣٠٠ سجل", "السجلات المسلّمة", "الصفوف المحفوظة", "في الصف الأول"]) expect(checkCustomerText(bad).issues.join(" "), bad).toContain("صف");
    for (const ok of ["سجّل حسابك أولًا لتعتمد المهمة", "وصف الفيديو", "تسجيل الدخول", "صفحة المنشور", "٣٠٠ تغريدة"]) expect(checkCustomerText(ok).issues, ok).toEqual([]);
  });

  it("the customer-facing surfaces of an agent mission do not contain the words", () => {
    const sources = ["src/lib/agentMission/notices.ts", "src/lib/agentMission/customerView.ts", "src/lib/agentMission/moneyText.ts", "src/lib/agentMission/itemNoun.ts"].map((f) => readFileSync(f, "utf8")).join("\n");
    // the code comments may name them; the strings a customer reads may not
    const strings = [...sources.matchAll(/(["`])((?:\\.|(?!\1).)*)\1/g)].map((m) => m[2]).filter((t) => /[؀-ۿ]/.test(t));
    for (const t of strings) expect(checkCustomerText(t.replace(/\$\{[^}]*\}/g, "٣")).issues.filter((i) => i.includes("صف")), t).toEqual([]);
  });
});

describe("D. the money is said exactly as the wallet shows it (hold, charge, the whole hold released)", () => {
  it("the live mission: reserve -279, charge -202, release +279", () => {
    expect(moneyLineAr({ reservedPoints: 279, chargedPoints: 202 })).toBe("حُجز مؤقتًا ٢٧٩ نقطة، وخُصم ٢٠٢ نقطة مقابل ما سُلّم، وحجز مؤقت مُحرَّر ٢٧٩ نقطة.");
    expect(moneyLineAr({ reservedPoints: 279, chargedPoints: 0 })).toBe("حُجز مؤقتًا ٢٧٩ نقطة، ولم يُخصم شيء، وحجز مؤقت مُحرَّر ٢٧٩ نقطة.");
    expect(moneyLineAr({ reservedPoints: 0, chargedPoints: 0 })).toBe("لم يُحجز أي رصيد ولم يُخصم شيء.");
    expect(heldPointsOf({ reservedPoints: 279, chargedPoints: 202, releasedPoints: 77 })).toBe(279);
    // the older shape of the facts (no hold given): the hold is the charge plus what came back
    expect(heldPointsOf({ chargedPoints: 202, releasedPoints: 77 })).toBe(279);
  });

  it.each(TYPES)("$name: the notification and the e-mail state 279 / 202 / 279 and never the net 77", ({ stage, subject, noun }) => {
    const title = missionTitleAr({ plan: planOf(stage, subject), requestText: "" });
    const n = buildMissionNotice("partial", { delivered: 250, planned: 300, chargedPoints: 202, releasedPoints: 77, reservedPoints: 279, noun, hasJob: true }, title);
    const e = n.email!;
    const all = [n.title, n.body, e.subject, e.preheader, e.heading, e.lead, e.detail1, e.detail2].join(" | ");
    expect(n.body).toContain("حُجز مؤقتًا ٢٧٩ نقطة، وخُصم ٢٠٢ نقطة مقابل ما سُلّم، وحجز مؤقت مُحرَّر ٢٧٩ نقطة.");
    expect(e.detail1).toBe("حُجز مؤقتًا ٢٧٩ نقطة، وخُصم ٢٠٢ نقطة مقابل ما سُلّم، وحجز مؤقت مُحرَّر ٢٧٩ نقطة.");
    expect(all).not.toContain("٧٧");
    expect(all).not.toMatch(/[0-9]/);
    expect(checkCustomerText(all, { maxChars: 2000 }).issues).toEqual([]);
  });

  it("a mission that delivered nothing, and a failure with no hold", () => {
    const failed = buildMissionNotice("failed", { delivered: 0, planned: 300, chargedPoints: 0, releasedPoints: 279, reservedPoints: 279, hasJob: true }, "تغريدات عن محمد صلاح");
    expect(failed.body).toContain("حُجز مؤقتًا ٢٧٩ نقطة، ولم يُخصم شيء، وحجز مؤقت مُحرَّر ٢٧٩ نقطة.");
    const none = buildMissionNotice("unserved", { delivered: 0, planned: 0, chargedPoints: 0, releasedPoints: 0, hasJob: false }, "تغريدات عن محمد صلاح");
    expect(none.body).toContain("لم يُحجز أي رصيد ولم يُخصم شيء.");
  });
});

// ------------------------------------------------------------------------------------ one count everywhere
const stageOf = (over: Record<string, unknown>): PricedStage => ({ key: "s", title_ar: "التغريدات", endpoint_id: "e", expected_rows: 300, planned_rows: 300, parent_key: null, deliver: true, columns: [{ key: "text", title_ar: "النص" }], sample_rows: [], measured_by: [], measured_from_calls: [], measured_cost_per_row_usd: 0.0001, ...over }) as PricedStage;

describe("C + D. ONE delivered count everywhere: no text says a number that differs from the delivered count (the live run: 250 of 300, hold 279, charge 202)", () => {
  const load = async (xlsx: Buffer) => { const wb = new ExcelJS.Workbook(); await wb.xlsx.load(xlsx as unknown as ArrayBuffer); return wb; };

  it.each(TYPES)("$name: the panel, the notification, the e-mail, the file name and the summary sheet agree", async ({ stage, noun, subject }) => {
    const planPublic = { summary_ar: "ملخص", stages: [{ key: "s", title_ar: stage, expected_rows: 300, deliver: true, columns: [{ key: "text", title_ar: "النص" }], sample_rows: [] }], price: { max_charge_points: 243, reserve_points: 279 } };
    const view = customerMissionView({
      mission: { id: "msn_1", status: "completed", question_ar: null, plan_public: planPublic, reserved_points: 279, unit_price_points: 0.8, delivered_units: 250, charged_points: 202, summary_ar: "سلّمت ٣٠٠ تغريدة عن الموضوع كلها", files: [{ name: "result.xlsx", kind: "xlsx" }], created_at: "2026-10-28T20:00:00Z" },
      events: [],
    });
    // the stored summary of an older mission carries a number (٣٠٠) that disagrees with the delivered count: it is not shown
    expect(view.resultSummaryAr).toBeNull();
    expect(view.resultLinesAr[0]).toBe(`تم تسليم ${deliveredOfAr(250, 300, knownItemNoun(noun)!)}.`);
    expect(view.resultLinesAr[1]).toBe("حُجز مؤقتًا ٢٧٩ نقطة، وخُصم ٢٠٢ نقطة مقابل ما سُلّم، وحجز مؤقت مُحرَّر ٢٧٩ نقطة.");

    const title = missionTitleAr({ plan: planOf(stage, subject), requestText: "" });
    const notice = buildMissionNotice("partial", { delivered: 250, planned: 300, chargedPoints: 202, releasedPoints: 77, reservedPoints: 279, noun, hasJob: true }, title);
    const fileTitle = missionFileTitleAr({ plan: planOf(stage, subject), requestText: "", delivered: 250, date: new Date("2026-10-28T10:00:00Z") });
    const plan = { summary_ar: "ستحصل على نحو ٣٠٠ من الأشياء", stages: [stageOf({ title_ar: stage })], price: {} } as unknown as PricedPlan;
    const built = await buildMissionFiles(plan, { s: Array.from({ length: 250 }, (_, i) => ({ id: `r${i}`, text: `ن${i}` })) });
    const wb = await load(built.xlsx);
    const intro = String(wb.getWorksheet("ملخص المهمة")!.getRow(4).getCell(1).value);
    expect(intro).toBe(`تم تسليم ${deliveredOfAr(250, 300, knownItemNoun(noun)!)}.`);

    const texts = [...view.resultLinesAr, notice.title, notice.body, notice.email!.subject, notice.email!.lead, notice.email!.detail1, fileTitle, intro];
    const allowed = new Set(["٢٥٠", "٣٠٠", "٢٧٩", "٢٠٢", "٢٨", "٢٠٢٦"]);
    for (const t of texts) for (const num of t.match(/[٠-٩٬]+/g) ?? []) expect(allowed.has(num), `${num} in «${t}»`).toBe(true);
    for (const t of texts) expect(t, t).not.toMatch(/صفًا|صف |صفوف|سجل/);
    // the model's own sentence with a number is recognised so the site can leave it out
    expect(HAS_NUMBER.test("سلّمت ٣٠٠ تغريدة")).toBe(true);
    expect(HAS_NUMBER.test("سُلّمت التغريدات التي تخص الموضوع")).toBe(false);
  });

  it("a stored summary with no number (the new kind) is shown, after the counts", () => {
    const planPublic = { summary_ar: "ملخص", stages: [{ key: "s", title_ar: "التغريدات", expected_rows: 300, deliver: true, columns: [{ key: "text", title_ar: "النص" }], sample_rows: [] }], price: {} };
    const view = customerMissionView({ mission: { id: "msn_1", status: "completed", question_ar: null, plan_public: planPublic, reserved_points: 279, unit_price_points: 0.8, delivered_units: 250, charged_points: 202, summary_ar: "لم يكتمل العدد المطلوب لأن هذا كل ما وُجد مطابقًا لطلبك.", files: null, created_at: "2026-10-28T20:00:00Z" }, events: [] });
    expect(view.resultSummaryAr).toBe("لم يكتمل العدد المطلوب لأن هذا كل ما وُجد مطابقًا لطلبك.");
    expect(view.phase).toBe("partial");
  });

  it("the shortfall reason says WHY, in plain words with no number: the sources gave no more, the review's limit, or a review that could not be reached", () => {
    expect(shortfallReasonAr({ pending: 0, stop: null })).toContain("هذا كل ما وُجد مطابقًا لطلبك");
    expect(shortfallReasonAr({ pending: 12, stop: "budget" })).toContain("بلغت حدّها المسموح");
    expect(shortfallReasonAr({ pending: 12, stop: "failed" })).toContain("تعذّر الوصول إليها");
    for (const r of [shortfallReasonAr({ pending: 0, stop: null }), shortfallReasonAr({ pending: 3, stop: "budget" }), shortfallReasonAr({ pending: 3, stop: "failed" })]) {
      expect(HAS_NUMBER.test(r)).toBe(false);
      expect(checkCustomerText(r, { maxChars: 600 }).issues).toEqual([]);
    }
  });
});

describe("C. the requests page names an agent mission's items by their noun", () => {
  it("the page reads the plan's stages, counts with the noun and never says «السجلات» for an agent mission", () => {
    const page = readFileSync("src/app/dashboard/requests/page.tsx", "utf8");
    expect(page).toContain('stages:plan_public->stages');
    expect(page).toContain("itemNounOfPlan({ stages: m.stages })");
    expect(page).toContain('agentNoun ? agentNoun.plural : "السجلات"');
    expect(page).toContain("deliveredOfAr(rows, requested || rows, agentNoun)");
  });
});

describe("F. the e-mail template draws no empty paragraph when the app has nothing to add (prepared, not deployed)", () => {
  it("DetailTwo empty: no empty paragraph; the money line is in the body; Arabic only", () => {
    const n = buildMissionNotice("completed", { delivered: 300, planned: 300, chargedPoints: 200, releasedPoints: 0, reservedPoints: 200, noun: "تغريدة", hasJob: true }, "تغريدات عن محمد صلاح");
    const e = n.email!;
    const { html, subject } = renderEmailTemplate("job-update", { Name: "منى", Subject: e.subject, Preheader: e.preheader, Heading: e.heading, Lead: e.lead, DetailOne: e.detail1, DetailTwo: e.detail2, ButtonLabel: e.buttonLabel, JobURL: "https://diger.tech/dashboard/chat?c=1" });
    expect(subject).toBe(e.subject);
    expect(html).toContain("حُجز مؤقتًا ٢٠٠ نقطة، وخُصم ٢٠٠ نقطة مقابل ما سُلّم، وحجز مؤقت مُحرَّر ٢٠٠ نقطة.");
    expect(html).not.toMatch(/<p\b[^>]*>\s*<\/p>/);
  });
});

describe("C + D. end to end: a model summary that names a number is never shown (the counts come from the data)", () => {
  it("the model says «سُلّمت ٥٠٠ تغريدة»: the stored summary has no number, the panel says what was really delivered, the money lines match the settlement", async () => {
    const SPEC = { subject_ar: "محمد صلاح لاعب كرة القدم", terms: ["محمد صلاح"], context_terms: ["هدف"], text_columns: ["text"] };
    const items = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `t${i}`, text: `محمد صلاح يسجل هدفًا جديدًا رقم ${i}`, url: `https://x.example/s/t${i}`, author: "fan", created: "2026-10-20T10:00:00Z" }));
    const r = await replay({
      request: "هات ٥ تغريدات عن محمد صلاح",
      planning: [
        { tool: "catalog_search", args: { words: ["tweets", "search"], platform: "x", limit: 5 } },
        { tool: "treg_call", args: { endpoint_id: "anyapi.x.search.posts", params: { query: "محمد صلاح", limit: 20 }, why: "the cheaper sources return no author or link fields in their catalog description" } },
        { tool: "run_code", args: { code: "return inputs.call_0001.output.data.items.map(t => ({ id: t.id, text: t.text, url: t.url, author: t.author, created: t.created }))", files: ["call_0001"] } },
        { tool: "propose_plan", args: (res: Results) => ({
          summary_ar: "ستحصل على تغريدات عن محمد صلاح.",
          stages: [{ key: "tweets", title_ar: "التغريدات", endpoint_id: "anyapi.x.search.posts", expected_rows: 5, parent_key: null, deliver: true,
            columns: [{ key: "text", title_ar: "نص التغريدة" }, { key: "url", title_ar: "رابط التغريدة" }, { key: "author", title_ar: "الحساب" }, { key: "created", title_ar: "التاريخ والوقت" }],
            sample_rows: (res.filter((x) => x.tool === "run_code")[0].result.result as unknown[]).slice(0, 1), measured_by: [callIds(res)[0], firstOutputId(res)], relevance: SPEC, yield_from: firstOutputId(res) }],
        }) },
      ],
      execution: () => [
        { tool: "treg_call", args: { endpoint_id: "anyapi.x.search.posts", params: { query: "محمد صلاح", limit: 20 } } },
        { tool: "run_code", args: (res: Results) => ({ code: "return inputs[Object.keys(inputs)[0]].output.data.items.map(t => ({ id: t.id, text: t.text, url: t.url, author: t.author, created: t.created }))", files: callIds(res) }) },
        { tool: "save_rows", args: (res: Results) => ({ stage_key: "tweets", from_output: lastOutputId(res) }) },
        { tool: "finish", args: { outcome: "delivered", summary_ar: "سُلّمت ٥٠٠ تغريدة كاملة عن محمد صلاح." } },
      ],
      answers: [tregResult({ output: { data: { items: items(12) } } }, 0.00075), tregResult({ output: { data: { items: items(12) } } }, 0.00075)],
    });
    expect(r.mission.delivered_units).toBe(5);
    expect(r.mission.summary_ar ?? "").not.toMatch(/[0-9٠-٩]/);
    expect(r.finalView.resultSummaryAr).toBeNull();
    expect(r.finalView.resultLinesAr[0]).toBe("تم تسليم ٥ تغريدات من ٥ تغريدات.");
    const reserved = Number(r.mission.reserved_points);
    const charged = Number(r.mission.charged_points);
    expect(r.finalView.resultLinesAr[1]).toBe(moneyLineAr({ reservedPoints: reserved, chargedPoints: charged }));
    const notice = r.notices[r.notices.length - 1];
    expect(notice.facts).toMatchObject({ delivered: 5, planned: 5, reservedPoints: reserved, releasedPoints: reserved, chargedPoints: charged, noun: "تغريدة" });
  });
});
