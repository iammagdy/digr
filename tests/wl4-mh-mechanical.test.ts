import { describe, expect, it } from "vitest";
import {
  blankListPunctuation,
  isArabicLettersMarksAndBlanks,
  isArabicNumericLine,
  isArabicScriptWord,
  removeZeroWidthAndBidi,
  replaceArabicNumberRuns,
} from "../src/lib/arabicNormalize";
import { numbersWritten } from "../agent/src/llmPlanner/planner";
import { isArabicName, isArabicText } from "../agent/src/namesAr";
import { repliesShortfallAr } from "../agent/src/repliesShortfall";
import { arabicDisplayName } from "../src/lib/greetingName";
import { notificationDisplay } from "../src/lib/notificationText";
import { isCustomerSafeArabic } from "../src/lib/customerError";
import { industryLabelAr } from "../src/lib/industryLabels";
import { activityArabic, bilingualTitle, titleArabic } from "../src/lib/agentMission/titleLexicon";
import { titleNamesParent } from "../src/lib/agentMission/childItems";
import { visualLine } from "../src/lib/agentMission/methodology/pdf";
import { askEditFromDraft } from "../src/components/mission/AskCard";

const nums = (s: string) => [...numbersWritten(s)].sort();
const FIELD = { key: "count", input: { kind: "number", min: 1, max: 500 } } as any;
const NAMES = ["محمد علي", "محمد  علي", "محمد-علي", "محمد’ علي", "محمد", "a محمد", "محمد ١", "محمد3", "", "م", " محمد علي ", "محمد علي أحمد حسن علي محمد خالد", "محمد علي أحمد حسن علي محمد", "محمد -علي", "محمد،علي", 12, null];
const TEXTS = ["أ، ب", "أ,ب", "أ/ب", "أ،،ب", "أ ب ج د ه و ز ح", "أ ب ج د ه و ز ح ط", "ab", "أ ب ١", "أ\nب", "كلمة"];
const GREET = ["أحمد", "Ahmed", "أَحْمَد", "أحمد 1", "  ", "محمد  علي", "١٢٣", "ـ"];
const SAFE = ["نص عربي", "text", "١٢٣", "نص with latin", "", "نص undefined"];
const INDUSTRY = ["مطاعم", "Restaurants", "", "Real estate"];

/** MH (D-0232): every expected value below was produced by the code of 59dd75c8 + PH0 + M1 (frozen); the new code must give the same value. */
describe("MH mechanical orthography swaps in customer-text / LLM-layer files: same outputs", () => {
  it("exported behaviours are unchanged (numbers written, name checks, shortfall sentence, greeting name, notification split, customer-safe check, industry labels, title lexicon, child title, PDF number runs, ask-card number)", () => {
    expect(nums("١٬٢٣٤ و ٥٫٦ و 7,890 و ٣٬٤٥ و ۱۲")).toEqual(["1234", "3", "45", "5", "6", "7890"]); // n1
    expect(nums("no numbers")).toEqual([]); // n2
    expect(nums("1,2345 and 12,34")).toEqual(["12", "12345", "34"]); // n3
    expect(NAMES.map((x) => isArabicName(x as any))).toEqual([true, false, true, false, true, false, false, false, false, false, true, false, true, false, true, false, false]); // nameA
    expect(TEXTS.map((x) => isArabicText(x as any))).toEqual([true, true, true, true, true, false, false, false, false, true]); // textA
    expect(repliesShortfallAr({ planned: 10, delivered: 5, stop: null, review: { pending: 0, stop: null } })).toEqual("الردود التي سُلّمت أقل مما قدّرناه في الخطة لأن الخطة قدّرت الردود من عيّنة من التعليقات، والمصدر لم يعطِ على التعليقات المقروءة أكثر مما سُلّم."); // rs1
    expect(repliesShortfallAr({ planned: 10, delivered: 5, stop: "budget" as any, review: { pending: 0, stop: null }, withMoney: true })).toEqual("الردود التي سُلّمت أقل مما قدّرناه في الخطة لأن ميزانية القراءة من المصادر المخصصة لهذه المهمة اكتملت، ولم يُخصم إلا مقابل ما سُلّم."); // rs2
    expect(repliesShortfallAr({ planned: 5, delivered: 5, stop: null, review: { pending: 0, stop: null } })).toEqual(""); // rs3
    expect(GREET.map((x) => arabicDisplayName(x))).toEqual(["أحمد", null, "أَحْمَد", null, null, "محمد علي", null, "ـ"]); // gn
    expect([notificationDisplay("عنوان:", "عنوان: النص"), notificationDisplay("عنوان — ", "عنوان — – النص"), notificationDisplay("عنوان", "نص مختلف"), notificationDisplay("A - ", "A - . body")]).toEqual([{"title": "عنوان:", "body": "النص"}, {"title": "عنوان —", "body": "النص"}, {"title": "عنوان", "body": "نص مختلف"}, {"title": "A -", "body": "body"}]); // nd
    expect(SAFE.map((x) => isCustomerSafeArabic(x))).toEqual([true, false, true, false, false, false]); // cs
    expect(INDUSTRY.map((x) => industryLabelAr(x))).toEqual(["مطاعم", "المطاعم", null, "العقارات"]); // il
    expect([titleArabic("CEO"), titleArabic("المدير\u200f العام"), bilingualTitle("Manager"), activityArabic("Software\u200b development"), activityArabic("")]).toEqual(["الرئيس التنفيذي", null, "مدير (Manager)", "تطوير البرمجيات", null]); // tl
    expect([titleNamesParent("تعليقات على المنشورات", "منشورات"), titleNamesParent("جمع، تعليقات.", "منشورات"), titleNamesParent("شركات", "منشورات")]).toEqual([true, false, false]); // tp
    expect([visualLine("١٢٣٬٤٥٦ شركة"), visualLine("١٢٫٥٪"), visualLine("نص ١٠:٣٠ أخر"), visualLine("٥٠٪ ٣٠٪"), visualLine("plain text"), visualLine("١٬٢٣٤ - ٥٫٦")]).toEqual(["شركة ٦٥٤٬٣٢١", "٪٥٫٢١", "أخر ٠٣:٠١ نص", "٪٠٣ ٪٠٥", "plain text", "٦٫٥ - ٤٣٢٬١"]); // vl
    expect([askEditFromDraft(FIELD, { text: "١٬٥٠" }), askEditFromDraft(FIELD, { text: "12" }), askEditFromDraft(FIELD, { text: "١٢٫٥" }), askEditFromDraft(FIELD, { text: "1 2" }), askEditFromDraft(FIELD, { text: "۳۰" }), askEditFromDraft(FIELD, { text: "600" }), askEditFromDraft(FIELD, { text: "0" })]).toEqual([{"field": "count", "value": 150}, {"field": "count", "value": 12}, null, {"field": "count", "value": 12}, {"field": "count", "value": 30}, null, null]); // ask
  });
});

describe("MH module additions: exact oracles, nothing else", () => {
  const corpus: string[] = [];
  for (const [a, b] of [[0x0000, 0x00ff], [0x0600, 0x06ff], [0x2000, 0x206f], [0xfe70, 0xfeff]] as Array<[number, number]>) for (let c = a; c <= b; c++) { const ch = String.fromCodePoint(c); corpus.push(ch, `x${ch}y`, `${ch}${ch}`); }
  corpus.push("١٬٢٣٤ ٥٫٦ ٣:٣٠ ٥٠٪", "١٢٣", " ١ ", "١-٢", "١٬٢٬", "plain", "");

  it("each function equals its frozen regex oracle on every code point of the touched blocks and on number strings", () => {
    for (const s of corpus) {
      const id = JSON.stringify(s);
      expect(isArabicScriptWord(s), id).toBe(/^[\u0600-\u06FF]+$/.test(s));
      expect(isArabicLettersMarksAndBlanks(s), id).toBe(/^[\u0621-\u064A\u064B-\u0652\s]+$/.test(s));
      expect(replaceArabicNumberRuns(s, (r) => `[${r}]`), id).toBe(s.replace(/[\u0660-\u0669]+(?:[\u066C\u066B:/.\-][\u0660-\u0669]+)*\u066A?/gu, (r) => `[${r}]`));
      expect(isArabicNumericLine(s), id).toBe(/^[\u0660-\u0669\u066C\u066B\u066A .:-]+$/u.test(s));
      expect(blankListPunctuation(s), id).toBe(s.replace(/[\u00AB\u00BB"\u060C,.:\u061B]/g, " "));
      expect(removeZeroWidthAndBidi(s), id).toBe(s.replace(/[\u200B-\u200F\u202A-\u202E\uFEFF]/g, ""));
    }
  });

  it("counter-cases: a comma is a word character of the Arabic block; the word joiner U+2060 is not removed; a blank-only string is not a word", () => {
    expect(isArabicScriptWord("،")).toBe(true);
    expect(isArabicScriptWord("")).toBe(false);
    expect(removeZeroWidthAndBidi("a\u2060b")).toBe("a\u2060b");
    expect(blankListPunctuation("أ،ب.ج")).toBe("أ ب ج");
    expect(isArabicNumericLine("")).toBe(false);
    // Persian digits are letters of the Arabic block for the name checks (and stay accepted)
    expect([isArabicName("محمد۱"), isArabicText("أ ۱"), isArabicName("محمد ۱ علي")]).toEqual([true, true, true]);
  });
});

import { loadTregCatalog } from "../src/lib/treg/catalog";
import { PEOPLE_OF_COMPANY_CAPABILITIES } from "../src/lib/agentMission/childSources";
import { capabilitiesOf } from "../agent/src/llmPlanner/catalogView";
import { assemblePlan, planWithLlm } from "../agent/src/llmPlanner/planner";
import { UNDERSTAND_TOOL } from "../agent/src/llmPlanner/prompts";

describe("MH AM1: numbersWritten and understanding trims match base 0af2f673", () => {
  it("numbersWritten keeps exact sets on ١٢٫٥, ١٬٢٠٠, 1٫500, and ٣٠٠ ألف و١٥٠", () => {
    expect(nums("١٢٫٥")).toEqual(["12", "5"]);
    expect(nums("١٬٢٠٠")).toEqual(["1200"]);
    expect(nums("1٫500")).toEqual(["1", "500"]);
    expect(nums("٣٠٠ ألف و١٥٠")).toEqual(["150", "300"]);
  });

  it("planWithLlm and assemblePlan trims strip trailing «.،  » and keep middle «،»", async () => {
    const NOT_ADMIN = { isAdmin: false, verifiedBusiness: false } as const;
    const catalog = loadTregCatalog();
    const CAP = [...capabilitiesOf(catalog, NOT_ADMIN, "companies")].sort().find((c) => !PEOPLE_OF_COMPANY_CAPABILITIES.has(c))!;
    const step = { key: "companies", title_ar: "شركات المقاولات", platform: "companies", capability: CAP, parent: "", deliver: true, count: { total: 2, all: false }, search_terms: ["مقاولات"] };
    const built = [{
      step: { ...step, parent: null, source: null },
      option: { endpoint: { id: "anyapi.dummy", inputs: [], pagination: [] } as any, params: {}, cursor: "cursor", parent: null, more: [], notCarried: [] },
      mapCode: "return []", columns: [{ key: "id", title_ar: "ID" }], carryKeys: [], sampleRows: [], rowsPerPage: 2, callIds: [], hasMore: true,
    }];

    for (const uAr of ["شركتان مقاولات، في الرياض.،  ", "شركتان مقاولات، في الرياض"]) {
      const progress: string[] = [];
      await planWithLlm(
        { words: ["هات شركتين مقاولات في الرياض"], request: "" },
        {
          model: async ({ tool }) => {
            if (tool.name !== UNDERSTAND_TOOL) return null;
            return { input: { decision: "plan", understanding_ar: uAr, accepts_available: false, missing: [], steps: [step], people_of_companies: { asked: false, title_ar: "", per_company: 0, per_company_text: "", companies_text: "", contact_kinds: [] } }, costUsd: 0 };
          },
          catalog, access: NOT_ADMIN, today: "2026-11-27",
          probe: async () => { throw new Error("no paid call"); },
          readPage: async () => null,
          accept: () => true,
          onProgress: async (line) => { progress.push(line); },
        },
      );
      expect(progress[0]).toBe("فهمنا طلبك: شركتان مقاولات، في الرياض.");
      const plan = assemblePlan({ decision: "plan", understanding_ar: uAr, steps: [{ ...step, parent: null, source: null }] } as any, built as any, []);
      expect(plan.summary_ar).toBe("شركتان مقاولات، في الرياض. العدد المخطط: شركات المقاولات: ٢.");
    }
  });
});
