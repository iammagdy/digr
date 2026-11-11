import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { explainNormalization, matchKey, NORMALIZATION_STEPS, normalizeArabic, semanticText } from "../src/lib/agentMission/semantic/normalizeArabic";
import { COMPILED_LEXICON, findTerms, LEXICON } from "../src/lib/agentMission/semantic/lexicon";
import { interpretRequest, type SemanticInterpretation } from "../src/lib/agentMission/semantic/interpret";
import { interpretIfEnabled, readSemanticNormalizationFlag, SEMANTIC_NORMALIZATION_FLAG_KEY } from "../src/lib/agentMission/semantic/flag";
import { preModelAnswer, privacyRefusalAr } from "../src/lib/agentMission/guardRules";
import { understand, type Understood } from "./helpers/semanticUnderstand";

/**
 * PR-1.1: the isolated semantic layer (normalizer, controlled vocabulary, reading, flag). Everything here is offline: no model, no provider, no network. The layer is NOT connected to the product; these tests prove what it does IN ISOLATION and that
 * the flag-OFF product is exactly the one PR #446 pinned. A pass here is NOT an improvement already available to customers.
 */
beforeAll(() => { vi.stubGlobal("fetch", () => { throw new Error("network is forbidden in the semantic normalization tests"); }); });
afterAll(() => { vi.unstubAllGlobals(); });

const plat = (r: SemanticInterpretation): string => (r.platform.status === "resolved" ? r.platform.id : r.platform.status);
const asked = (r: SemanticInterpretation): string[] => (Object.keys(r.content) as Array<keyof SemanticInterpretation["content"]>).filter((k) => r.content[k]).sort();

// ---- 1. normalization -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
describe("normalizeArabic: safe, explainable, idempotent", () => {
  it.each([
    // [what it tests, input, expected]
    ["diacritics are removed", "تَعْلِيقَات", "تعليقات"],
    ["tatweel is removed", "كــومنتــات", "كومنتات"],
    ["a stretched voice transcript is cut", "كومنتااااات", "كومنتات"],
    ["Arabic-Indic digits become Western", "٥٠ شركة", "50 شركة"],
    ["Persian digits become Western", "۱۰۰ تعليق", "100 تعليق"],
    ["a decimal separator between digits is kept", "٥٫٥ مليون", "5.5 مليون"],
    ["punctuation becomes one space", "هات... تعليقات!!! من «تيك توك»؟", "هات تعليقات من تيك توك"],
    ["extra spaces and tabs collapse", "  هات \t  تعليقات   ", "هات تعليقات"],
    ["Latin letters are lower case", "TikTok COMMENTS", "tiktok comments"],
    ["zero-width characters inside a word vanish", "تيك​توك", "تيكتوك"],
    ["a digit stuck to an Arabic word is separated", "٥٠شركة", "50 شركة"],
    ["a Latin word stuck to an Arabic clitic is separated", "بtiktok", "ب tiktok"],
    ["a link becomes one token", "شوف https://tiktok.com/@abc/video/1 دلوقتي", "شوف url دلوقتي"],
    ["presentation forms become ordinary letters", "ﻛﻮﻣﻨﺘﺎﺕ", "كومنتات"],
    ["full-width Latin letters become ordinary", "ＴｉｋＴｏｋ", "tiktok"],
  ])("%s", (_what, input, expected) => {
    expect(normalizeArabic(input)).toBe(expected);
  });

  it("keeps every Arabic LETTER as typed: ة ى أ ؤ ئ are not rewritten (the folds are for comparison only)", () => {
    for (const w of ["السياحة", "على", "أحمد", "مؤسسة", "رئيس", "إدارة"]) expect(normalizeArabic(w)).toBe(w);
    expect(matchKey("السياحة")).toBe("السياحه");
    expect(matchKey("على")).toBe("علي");
    expect(matchKey("أحمد")).toBe("احمد");
  });

  it("does not alter or replace the original: the reading keeps the input as received", () => {
    const input = "  هات  كومنتات!!! من تك توك  ";
    const r = interpretRequest(input);
    expect(r.original).toBe(input);
    expect(semanticText(input).original).toBe(input);
  });

  it("is idempotent on 600 deterministic pseudo-random texts (Arabic, Latin, digits, marks, symbols, presentation forms)", () => {
    const alphabet = ["ا", "أ", "ب", "ت", "ة", "ك", "و", "ي", "ى", "ء", "ـ", "َ", "ّ", "٥", "٠", "۳", "a", "T", "k", "x", "0", "9", " ", " ", ".", ",", "٫", "!", "؟", "«", "»", "-", "_", "@", "#", "​", "ﻛ", "ﺕ", "\n", "ﻻ", "😀", "https://a.b/c"];
    let seed = 20261111;
    const next = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed; };
    for (let n = 0; n < 600; n++) {
      let s = "";
      const len = next() % 40;
      for (let i = 0; i < len; i++) s += alphabet[next() % alphabet.length];
      const once = normalizeArabic(s);
      expect(normalizeArabic(once), JSON.stringify(s)).toBe(once);
    }
  });

  it("explains itself: which steps changed a text, in order", () => {
    expect(explainNormalization("كــومنتات")).toEqual(["tatweel"]);
    expect(explainNormalization("٥٠ TikTok")).toEqual(["digits", "case"]);
    expect(explainNormalization("هات تعليقات")).toEqual([]);
    expect(NORMALIZATION_STEPS.map((s) => s.id)).toContain("elongation");
    for (const s of NORMALIZATION_STEPS) expect(s.why.length, s.id).toBeGreaterThan(10);
  });

  it("reads at most 2,000 characters and never throws on odd input", () => {
    expect(normalizeArabic("ا".repeat(5000)).length).toBeLessThanOrEqual(2000);
    for (const odd of [null, undefined, 42, {}, [], "", "   "]) expect(() => normalizeArabic(odd as never)).not.toThrow();
    expect(normalizeArabic(null)).toBe("");
  });
});

// ---- 2. the controlled vocabulary ------------------------------------------------------------------------------------------------------------------------------------------------------------------------
describe("the vocabulary: the same intention, whatever the spelling", () => {
  const PLATFORM_SPELLINGS: Record<string, string[]> = {
    tiktok: ["تيك توك", "تك توك", "تيكتوك", "TikTok", "Tik Tok", "tik-tok", "التك توك", "فتيكتوك", "عالتيك توك", "ﺗﻴﻚ ﺗﻮﻙ"],
    instagram: ["انستجرام", "انستاجرام", "إنستغرام", "انستا", "Instagram", "insta"],
    facebook: ["فيسبوك", "فيس بوك", "الفيس", "فيسبك", "Facebook", "face book"],
    youtube: ["يوتيوب", "يوتوب", "اليوتيوب", "YouTube", "you tube"],
    x: ["تويتر", "Twitter", "تويتر", "x.com"],
  };
  for (const [id, spellings] of Object.entries(PLATFORM_SPELLINGS)) {
    it.each(spellings)(`${id}: «%s»`, (spelling) => {
      const r = interpretRequest(`هات تعليقات ${spelling}`);
      expect(plat(r), spelling).toBe(id);
    });
  }

  it.each([
    ["comments", ["تعليقات", "تعليق", "كومنتات", "كومنتس", "كومينتس", "الكومنتس", "comments", "Comments", "بالتعليقات", "تعليقاتهم", "كومنتاتهم"]],
    ["replies", ["ردود", "الردود", "ريبلاي", "ريبلايز", "replies", "reply"]],
    ["posts", ["منشورات", "بوستات", "البوستات", "posts", "post"]],
    ["videos", ["فيديوهات", "فيديو", "الفيديوهات", "videos", "video", "ريلز"]],
  ])("content «%s» in every spelling", (id, spellings) => {
    for (const s of spellings) expect(asked(interpretRequest(`هات ${s}`)), s).toContain(id);
  });

  it.each([
    ["عايز", "want"], ["عاوز", "want"], ["محتاج", "want"], ["هات", "get"], ["هاتلي", "get"], ["هات لي", "get"], ["اجمع", "collect"], ["اجمعلي", "collect"], ["طلعلي", "extract"], ["طلّعلي", "extract"], ["طلع لي", "extract"], ["اطلعلي", "extract"],
  ])("the ask «%s»", (word, id) => {
    const r = interpretRequest(`${word} تعليقات تيك توك`);
    expect(r.is_request).toBe(true);
    expect(r.asks).toContain(id);
  });

  it("no matching inside unrelated words (whole tokens only)", () => {
    for (const unrelated of ["postman", "tiktokify", "xerox", "express", "اكسسوار", "ردهة الفندق", "فيسبوكي"]) {
      const r = interpretRequest(`هات ${unrelated}`);
      expect(r.platform.status, unrelated).not.toBe("resolved");
    }
    expect(asked(interpretRequest("هات ردهة الفندق"))).toEqual([]);
    expect(asked(interpretRequest("the postman"))).toEqual([]);
  });

  it("the vocabulary is small and every compiled form is a whole token or phrase", () => {
    expect(LEXICON.length).toBeLessThan(40);
    expect(COMPILED_LEXICON.size).toBeGreaterThan(50);
    expect(findTerms(["تيك", "توك"]).map((m) => m.entry.id)).toEqual(["tiktok"]);
    expect(findTerms(["تيكتوكات"]).length).toBe(0);
  });
});

// ---- 3. equivalent phrases, distinct intentions -------------------------------------------------------------------------------------------------------------------------------------------
describe("equivalent phrases give the same meaning; different intentions stay different", () => {
  const key = (r: SemanticInterpretation) => JSON.stringify({ p: plat(r), c: asked(r), t: r.topic, k: r.parent_kind });

  it("the owner's example: «هات كومنتات من تك توك عن السياحة» = TikTok + comments + السياحة", () => {
    const r = interpretRequest("هات كومنتات من تك توك عن السياحة");
    expect(plat(r)).toBe("tiktok");
    expect(r.content.comments).toBe(true);
    expect(r.content.replies).toBe(false);
    expect(r.topic).toBe("السياحة");
  });

  it("eleven ways to ask for the same thing give one reading", () => {
    const same = [
      "هات كومنتات من تك توك عن السياحة",
      "عايز كومنتس تيكتوك عن السياحة",
      "عاوز التعليقات بتاعة TikTok عن السياحة",
      "محتاج comments من tik tok عن السياحة",
      "هات لي تعليقات تيك توك عن السياحة",
      "طلعلي الكومنتات من التك توك عن السياحة",
      "اجمع تعليقات تيك توك عن السياحة",
      "هات ... كومنتات!!! من تك توك، عن السياحة؟",
      "هاتلي كومنتاااات من تيكتوك عن السياحة",
      "get comments from TikTok about السياحة",
      "هات ﺗﻌﻠﻴﻘﺎﺕ تيك توك عن السياحة",
    ];
    const readings = new Set(same.map((t) => key(interpretRequest(t))));
    expect([...readings]).toEqual([key(interpretRequest(same[0]))]);
  });

  it("comments and replies stay two things", () => {
    expect(asked(interpretRequest("هات تعليقات تيك توك"))).toEqual(["comments"]);
    expect(asked(interpretRequest("هات ردود تيك توك"))).toEqual(["replies"]);
    expect(asked(interpretRequest("هات التعليقات والردود"))).toEqual(["comments", "replies"]);
    expect(asked(interpretRequest("هات كومنتس و ريبلايز"))).toEqual(["comments", "replies"]);
  });

  it("posts and videos stay two things, and asking for both leaves the parent kind undecided", () => {
    expect(interpretRequest("هات بوستات تيك توك").parent_kind).toBe("posts");
    expect(interpretRequest("هات فيديوهات تيك توك").parent_kind).toBe("videos");
    const both = interpretRequest("هات بوستات وفيديوهات من انستا");
    expect(both.parent_kind).toBeNull();
    expect(both.ambiguities).toContain("kind:posts_vs_videos");
    expect(asked(both)).toEqual(["posts", "videos"]);
  });

  it("a research TOPIC is not a requested output field, and an output field after the topic is not part of it", () => {
    const a = interpretRequest("هات تعليقات تيك توك عن السياحة والردود");
    expect(a.topic).toBe("السياحة");
    expect(asked(a)).toEqual(["comments", "replies"]);
    const b = interpretRequest("هات منشورات عن الكومنتات");
    expect(asked(b)).toEqual(["posts"]); // «comments» is what the posts are ABOUT
    expect(b.topic).toBe("الكومنتات");
    const c = interpretRequest("عايز التعليقات بتاعة تيك توك عن السياحة والردود عليها");
    expect(c.topic).toBe("السياحة");
    expect(c.content.replies).toBe(true);
    const d = interpretRequest("اعمل لي تعليقات تيك توك عن السياحة بس استبعد الحسابات اللي في الملف");
    expect(d.topic).toBe("السياحة");
  });

  it("the topic keeps the customer's own letters (ة and ى are not rewritten)", () => {
    expect(interpretRequest("هات تعليقات تيك توك عن السياحة").topic).toBe("السياحة");
    expect(interpretRequest("هات تعليقات تيك توك الخاصة بالسياحه").topic).toBe("السياحه");
    expect(interpretRequest("هات منشورات عن مصطفى").topic).toBe("مصطفى");
  });

  it("a platform introduced by a preposition ends the topic", () => {
    const r = interpretRequest("عايز تعليقات عن السياحة على تيك توك");
    expect(r.topic).toBe("السياحة");
    expect(plat(r)).toBe("tiktok");
  });

  it("Arabic digits and Western digits give the same reading", () => {
    expect(key(interpretRequest("هات ١٠٠ تعليق من تيك توك عن السياحة"))).toBe(key(interpretRequest("هات 100 تعليق من تيك توك عن السياحة")));
  });
});

// ---- 4. ambiguity is kept, never decided ---------------------------------------------------------------------------------------------------------------------------------------------------------
describe("ambiguity is retained", () => {
  it("«مطعم اسمه X» is NOT the X platform", () => {
    for (const t of ["مطعم اسمه X", "تقييمات مطعم X على جوجل ماب", "شركة X للمقاولات", "هات تعليقات عن شركة اسمها X"]) {
      const r = interpretRequest(t);
      expect(plat(r), t).not.toBe("x");
      expect(r.platform.status, t).not.toBe("resolved");
    }
    expect(interpretRequest("مطعم اسمه X").ambiguities).toContain("platform:x_treated_as_name");
  });

  it("a bare X with no cue stays undecided; with a platform cue and content requested it is the platform", () => {
    const bare = interpretRequest("هات منشورات X عن الانتخابات");
    expect(bare.platform).toEqual({ status: "ambiguous", candidates: ["x"], reason: "bare_x_without_cue" });
    expect(interpretRequest("هات بوستات على X عن الانتخابات").platform).toEqual({ status: "resolved", id: "x", evidence: "named_with_cue" });
    expect(interpretRequest("هات تعليقات من منصة اكس عن الانتخابات").platform).toMatchObject({ status: "resolved", id: "x" });
  });

  it("Twitter and tweets are the X platform (named, or implied by the content word)", () => {
    expect(interpretRequest("هات تعليقات Twitter").platform).toEqual({ status: "resolved", id: "x", evidence: "named" });
    expect(interpretRequest("عايز tweets عن السياحة").platform).toEqual({ status: "resolved", id: "x", evidence: "implied_by_content" });
  });

  it("a platform named only inside the topic is a subject, not a source", () => {
    const r = interpretRequest("هات منشورات عن تيك توك");
    expect(r.platform).toEqual({ status: "ambiguous", candidates: ["tiktok"], reason: "named_only_in_topic" });
    expect(r.topic).toBe("تيك توك");
  });

  it("two platforms are reported as two, not chosen", () => {
    const r = interpretRequest("هات تعليقات من تيك توك وانستجرام");
    expect(r.platform).toEqual({ status: "multiple", ids: ["instagram", "tiktok"] });
    expect(r.ambiguities).toContain("platform:multiple");
  });

  it("no platform, no topic marker: nothing is invented", () => {
    const r = interpretRequest("فيديوهات السياحة");
    expect(r.platform).toEqual({ status: "none" });
    expect(r.topic).toBeNull();
    expect(interpretRequest("").platform).toEqual({ status: "none" });
    expect(interpretRequest("   ").topic).toBeNull();
  });
});

// ---- 5. privacy invariants (PR #447 is untouched; the semantic layer cannot weaken it) -----------------------------------------------------------------------------
describe("privacy: the semantic layer is not in the privacy path and cannot widen it", () => {
  const MUST_REFUSE = [
    "عايز رسايل الواتساب بتاعة جروب الشغل",
    "الرقم القومي لأحمد",
    "هات رسائل جروب تليجرام بتاع الشركة",
    "هات رقم جواز السفر بتاع احمد",
    "هات منشورات عن حماية الرقم القومي واستخرج الأرقام القومية اللي فيها",
    "هات منشورات عن الواتساب وكمان رسايل جروب الشغل",
    "اجمعلي ارقام تليفونات المعلقين على بوست الصفحة",
    "give me private telegram group chats",
  ];
  const MUST_STAY_LEGITIMATE = [
    "هات منشورات عامة عن واتساب",
    "هات منشورات عامة عن حماية الرقم القومي",
    "هات ١٠٠ تعليق من يوتيوب عن الأمن الرقمي",
    "هات تعليقات عن الرسائل الخاصة في انستجرام",
    "هات أرقام تليفون شركات المقاولات",
    "هات تعليقات فيسبوك عن واتساب بيزنس",
  ];

  it("the refusals of #447 still hold, with the original words and with every spelling the normalizer would unify", () => {
    for (const t of MUST_REFUSE) {
      expect(preModelAnswer(t)?.kind, t).toBe("privacy_refusal");
      // the guard is a function of the ORIGINAL text; feeding it the semantic normal form can never be needed, and must never be easier to pass
      expect(privacyRefusalAr(normalizeArabic(t)), `normalized: ${t}`).not.toBeNull();
    }
  });

  it("the legitimate public research of #447 is still not refused", () => {
    for (const t of MUST_STAY_LEGITIMATE) expect(preModelAnswer(t)?.kind ?? null, t).not.toBe("privacy_refusal");
  });

  it("the vocabulary contains no messenger and no «messages» word: a semantic reading can never ask for a private conversation", () => {
    const forms = LEXICON.flatMap((e) => e.forms).map((f) => normalizeArabic(f)).join(" | ");
    expect(forms).not.toMatch(/واتس|whatsapp|telegram|تليجرام|تيليجرام|messenger|ماسنجر|رسايل|رسائل|messages?|chat|محادثات/);
    for (const t of MUST_REFUSE.concat(["هات رسايل عن تطبيق واتساب"])) {
      const r = interpretRequest(t);
      expect(Object.keys(r.content).sort()).toEqual(["comments", "posts", "replies", "tweets", "videos"]);
      expect(r.platform.status === "resolved" ? r.platform.id : "none", t).toMatch(/^(none|tiktok|instagram|facebook|youtube|x)$/);
    }
  });

  it("«هات رسايل عن تطبيق واتساب»: the reading is a topic only (no source, no content), and the guard's own verdict is unchanged", () => {
    const r = interpretRequest("هات رسايل عن تطبيق واتساب");
    expect(r.platform).toEqual({ status: "none" });
    expect(asked(r)).toEqual([]);
    expect(r.topic).toBe("تطبيق واتساب");
    // #447 stays the only judge: it refuses this sentence (conservative), exactly as before this PR
    expect(preModelAnswer("هات رسايل عن تطبيق واتساب")?.kind).toBe("privacy_refusal");
  });

  it("the privacy rules and the existing normalizer do not import the semantic module (no shared code path)", () => {
    for (const f of ["src/lib/agentMission/guardRules.ts", "src/lib/agentMission/messageType.ts"]) {
      expect(readFileSync(new URL(`../${f}`, import.meta.url), "utf8"), f).not.toMatch(/semantic\//);
    }
  });
});

// ---- 6. the feature flag ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
describe("flag semantic_normalization_v1: OFF by default, strict, and the only door", () => {
  it("is named exactly as the brief says", () => {
    expect(SEMANTIC_NORMALIZATION_FLAG_KEY).toBe("semantic_normalization_v1");
  });

  it.each([
    [undefined, false], [null, false], [{}, false], [{ semantic_normalization_v1: false }, false], [{ semantic_normalization_v1: "off" }, false], [{ semantic_normalization_v1: "ON" }, false], [{ semantic_normalization_v1: "on " }, false],
    [{ semantic_normalization_v1: 1 }, false], [{ semantic_normalization_v1: "true" }, false], [{ semantic_normalization_v1: {} }, false], [{ semantic_normalization_v1: null }, false],
    [{ semantic_normalization_v1: true }, true], [{ semantic_normalization_v1: "on" }, true],
  ])("settings %j → %s", (settings, expected) => {
    expect(readSemanticNormalizationFlag(settings as never)).toBe(expected);
  });

  it("an unreadable settings object is OFF, never a throw", () => {
    const hostile = new Proxy({}, { get() { throw new Error("boom"); } });
    expect(readSemanticNormalizationFlag(hostile as never)).toBe(false);
  });

  it("OFF: nothing is computed (null) and the settings object is not touched; ON: the reading", () => {
    const off = Object.freeze({ other: 1 });
    expect(interpretIfEnabled(off, "هات كومنتات من تك توك")).toBeNull();
    expect(interpretIfEnabled(undefined, "هات كومنتات من تك توك")).toBeNull();
    const on = Object.freeze({ semantic_normalization_v1: true });
    expect(interpretIfEnabled(on, "هات كومنتات من تك توك")?.content.comments).toBe(true);
  });

  it("no file of the product (src/, agent/src/) imports the semantic module: flag OFF is the current behavior by construction", () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) { if (name === "node_modules" || name === "semantic") continue; walk(p); }
        else if (/\.(ts|tsx)$/.test(name) && /agentMission\/semantic\/|from ["']\.\/semantic\/|from ["']\.\.\/semantic\//.test(readFileSync(p, "utf8"))) hits.push(p);
      }
    };
    walk(new URL("../src", import.meta.url).pathname);
    walk(new URL("../agent/src", import.meta.url).pathname);
    expect(hits).toEqual([]);
  });
});

// ---- 7. against the PR #446 baseline ----------------------------------------------------------------------------------------------------------------------------------------------------------------
interface BaselineCase { id: string; group: string; text: string; answer?: string; expected: Partial<Record<keyof Understood, unknown>>; known_gap?: { ref: string; observed: Partial<Record<keyof Understood, unknown>> } }
const baseline = (JSON.parse(readFileSync(new URL("./fixtures/semantic-paraphrases.json", import.meta.url), "utf8")) as { cases: BaselineCase[] }).cases;
const FIELDS = ["platform", "kind", "comments", "replies", "topic"] as const;

/** Does the ISOLATED reading agree with the case's correct meaning on this field? (Only fields the reading covers.) */
function agrees(c: BaselineCase, f: (typeof FIELDS)[number], r: SemanticInterpretation): boolean {
  const e = c.expected[f];
  if (f === "platform") return e === null ? r.platform.status !== "resolved" : r.platform.status === "resolved" && r.platform.id === e;
  if (f === "kind") return r.parent_kind === e;
  if (f === "comments") return e === "none" ? !r.content.comments : r.content.comments;
  if (f === "replies") return e === "none" ? !r.content.replies : r.content.replies;
  return r.topic === e;
}

describe("against the baseline of PR #446: nothing is converted, and what the vocabulary could address is measured", () => {
  it("keeps all 98 scenarios and all 62 known gaps (none deleted, none rewritten, none converted)", () => {
    expect(baseline).toHaveLength(98);
    expect(baseline.filter((c) => c.known_gap)).toHaveLength(62);
  });

  it("FLAG OFF compatibility: understanding all 98 scenarios is identical before and after the semantic layer runs ON over the same texts (no shared state, no side effect)", () => {
    const before = baseline.map((c) => understand(c.text, c.answer ?? null));
    const on = { semantic_normalization_v1: true };
    for (const c of baseline) interpretIfEnabled(on, c.text);
    const after = baseline.map((c) => understand(c.text, c.answer ?? null));
    expect(after).toEqual(before);
    for (const c of baseline) expect(interpretIfEnabled({}, c.text), c.id).toBeNull();
  });

  // The gap cases whose misunderstanding (`known_gap.observed`) is in a field this reading covers, and that the ISOLATED reading gets right. They stay known gaps: the product does not use the reading (PR-1.2 or later integrates it, behind the flag).
  const IN_SCOPE_GAPS = baseline.filter((c) => c.answer === undefined && c.known_gap && Object.keys(c.known_gap.observed).some((k) => (FIELDS as readonly string[]).includes(k)));
  const ADDRESSED = [
    "sa-01", "sa-02", "sa-03", "sa-08", "sb-09", "pl-04", "pl-05", "pl-07", "pl-11", "pl-14", "pl-15", "pl-16", "pl-17", "pl-22", "pl-23", "pl-24", "pl-25", "cm-02", "cm-05", "cm-06", "cm-09", "ct-07", "rt-04", "rt-05",
  ];
  const PARTIAL = ["sa-04", "sa-06", "cm-08", "dt-04", "dt-11", "rt-03"];

  it("isolated reading: which known gaps in its scope it addresses (24), and which it only partly addresses (6)", () => {
    const fullyAgrees = (c: BaselineCase) => (Object.keys(c.known_gap!.observed).filter((k) => (FIELDS as readonly string[]).includes(k)) as Array<(typeof FIELDS)[number]>).every((f) => agrees(c, f, interpretRequest(c.text)));
    expect(IN_SCOPE_GAPS.filter(fullyAgrees).map((c) => c.id)).toEqual(ADDRESSED);
    expect(IN_SCOPE_GAPS.filter((c) => !fullyAgrees(c)).map((c) => c.id)).toEqual(PARTIAL);
  });

  it("the reading is NOT a replacement for today's parser: the one case where today's code is right and the reading differs is recorded (cm-11: the reading keeps the whole span after «عن», «رأي الناس في الذكاء الاصطناعي», not only the subject)", () => {
    const differs: string[] = [];
    for (const c of baseline) {
      if (c.answer !== undefined || c.known_gap) continue;
      const r = interpretRequest(c.text);
      const bad = FIELDS.filter((f) => f in c.expected && !agrees(c, f, r));
      if (bad.length) differs.push(`${c.id}:${bad.join("+")}`);
    }
    expect(differs).toEqual(["cm-11:topic"]);
  });

  it("every other known gap (dates, countries, languages, e-mail, pre-filters, routing, multi-turn) is untouched by this layer and stays for PR-1.2 or later", () => {
    const outOfScope = baseline.filter((c) => c.known_gap && !IN_SCOPE_GAPS.includes(c));
    expect(outOfScope.length + IN_SCOPE_GAPS.length).toBe(62);
    // the categories the vocabulary does NOT address
    const refs = new Set(outOfScope.map((c) => c.known_gap!.ref));
    for (const ref of ["L4", "W1", "W2", "W4", "L6"]) expect(refs.has(ref), ref).toBe(true);
  });
});
