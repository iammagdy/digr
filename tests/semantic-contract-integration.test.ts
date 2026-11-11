import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildAsk } from "../src/lib/agentMission/foundation/ask";
import { NO_ABOUT_OPTIONS_AR } from "../src/lib/agentMission/foundation/topicChoice";
import { PLATFORM_QUESTION_AR } from "../src/lib/agentMission/platformQuestion";
import { buildRequestContract, buildRequestContractWithReport } from "../src/lib/agentMission/requestContract";
import { preModelAnswer } from "../src/lib/agentMission/guardRules";
import { createCustomerMission } from "../src/lib/agentMission/customerActions";
import { readSemanticNormalizationFlag, readSemanticNormalizationFlagFromClient } from "../src/lib/agentMission/semantic/flag";
import { createMemoryDb } from "./helpers/memoryDb";
import { runProductionPlanning, type ProductionPlanning } from "./helpers/productionPlanning";
import { M12 } from "./helpers/round14Missions";
import { SEMANTIC_NOW_MS, understand, type Understood } from "./helpers/semanticUnderstand";

/**
 * PR-1.2: THE SEMANTIC READING IN THE REAL REQUEST CONTRACT. Not tests of the interpreter (`semantic-normalization.test.ts` has those): tests of `buildRequestContract`, `buildAsk` and the worker's own planning run (`runPlanning`, over the stored live pages, the test seam OFF,
 * no model, no provider, no network) with the flag `semantic_normalization_v1` OFF and ON. The flag is read from the trusted settings only; the customer's words never switch it.
 */
beforeAll(() => { vi.stubGlobal("fetch", () => { throw new Error("network is forbidden in the semantic integration tests"); }); });
afterAll(() => { vi.unstubAllGlobals(); });

const ON = { semantic: true } as const;
const OFF = { semantic: false } as const;

// ---- 1. the contract, OFF and ON, on the examples of the brief ------------------------------------------------------------------------------------------------------------------------------------
describe("the real request contract: flag OFF is today, flag ON is the corrected reading", () => {
  it("TEST 1: «هات كومنتات من تك توك عن السياحة» → TikTok + comments + السياحة (OFF: no platform, no comments stage)", () => {
    const text = "هات كومنتات من تك توك عن السياحة";
    const off = buildRequestContract(text, undefined, OFF);
    expect(off).toMatchObject({ platform: null, comments: "none", topic: "السياحة" });
    const on = buildRequestContract(text, undefined, ON);
    expect(on).toMatchObject({ platform: "tiktok", comments: "some", replies: "none", topic: "السياحة" });
    // the ask the compiler reads carries the comments stage and the topic as well
    const ask = buildAsk(text, null, SEMANTIC_NOW_MS, {}, ON);
    expect(ask).toMatchObject({ platform: "tiktok", comments: "some", replies: "none", topic: { text: "السياحة", relation: "about" } });
    expect(buildAsk(text, null, SEMANTIC_NOW_MS, {}, OFF)).toMatchObject({ platform: null, comments: "none" });
  });

  it("TEST 2: «عايز التعليقات والردود على فيديوهات تيكتوك» keeps BOTH comments and replies, with the flag OFF and ON (the parser's value is never overwritten)", () => {
    const text = "عايز التعليقات والردود على فيديوهات تيكتوك";
    for (const options of [OFF, ON]) expect(buildRequestContract(text, undefined, options), JSON.stringify(options)).toMatchObject({ platform: "tiktok", parentKind: "videos", comments: "some", replies: "some" });
    // the same request in the spellings the parser did not read: OFF drops both, ON keeps both and keeps them apart
    const variant = "عايز الكومنتس والريبلايز على فيديوهات تك توك";
    expect(buildRequestContract(variant, undefined, OFF)).toMatchObject({ platform: null, comments: "none" });
    expect(buildRequestContract(variant, undefined, ON)).toMatchObject({ platform: "tiktok", parentKind: "videos", comments: "some", replies: "some" });
    // comments alone stay comments alone, replies alone stay replies alone
    expect(buildRequestContract("هات كومنتس تيك توك", undefined, ON)).toMatchObject({ comments: "some", replies: "none" });
    expect(buildRequestContract("هات ريبلايز تيك توك", undefined, ON)).toMatchObject({ comments: "none", replies: "some" });
  });

  it("TEST 3: «هات تعليقات فيديوهات تيك توك الخاصة بالسياحة» → the topic السياحة (OFF: no topic)", () => {
    const text = "هات تعليقات فيديوهات تيك توك الخاصة بالسياحة";
    expect(buildRequestContract(text, undefined, OFF).topic).toBeNull();
    expect(buildRequestContract(text, undefined, ON)).toMatchObject({ platform: "tiktok", parentKind: "videos", comments: "some", topic: "السياحة" });
    expect(buildRequestContract("هات تعليقات فيديوهات تيك توك المتعلقة بالسياحة", undefined, ON).topic).toBe("السياحة");
    expect(buildRequestContract("هات تعليقات تيك توك حول السياحة", undefined, ON).topic).toBe("السياحة");
  });

  it("TEST 4: «محتاج comments من TikTok عن السياحة» → comments recognized (OFF: comments none)", () => {
    const text = "محتاج comments من TikTok عن السياحة";
    expect(buildRequestContract(text, undefined, OFF)).toMatchObject({ platform: "tiktok", comments: "none" });
    expect(buildRequestContract(text, undefined, ON)).toMatchObject({ platform: "tiktok", comments: "some", topic: "السياحة" });
    for (const t of ["عايز 100 comments على Tik Tok", "هاتلي كومنتات من التك توك"]) {
      expect(buildRequestContract(t, undefined, OFF).platform, t).toBeNull();
      expect(buildRequestContract(t, undefined, ON), t).toMatchObject({ platform: "tiktok", comments: "some" });
    }
  });

  it("TEST 5: «مطعم اسمه X» is NOT forced into the X platform (OFF: it is, today); an unclear X stays unclear", () => {
    expect(buildRequestContract("مطعم اسمه X", undefined, OFF)).toMatchObject({ platform: "x", parentKind: "tweets" });
    expect(buildRequestContract("مطعم اسمه X", undefined, ON)).toMatchObject({ platform: null, parentKind: null });
    const review = "تقييمات مطعم X على جوجل ماب، آخر ٢٠٠ ريفيو";
    expect(buildRequestContract(review, undefined, ON).platform).toBeNull();
    // the platform X with a cue is still the platform (the parser's own value is never taken away)
    expect(buildRequestContract("هات بوستات على X عن الانتخابات", undefined, ON).platform).toBe("x");
    expect(buildRequestContract("هات منشورات X عن الانتخابات", undefined, ON).platform).toBe("x"); // the parser read it; the reading is only ambiguous, so it changes nothing
    expect(buildRequestContract("عايز tweets عن السياحة", undefined, ON)).toMatchObject({ platform: "x", parentKind: "tweets", topic: "السياحة" });
  });

  it("an output field is never part of the topic, nor an exclusion (OFF: the topic swallows it)", () => {
    const a = "هات تعليقات تيك توك عن السياحة والردود";
    expect(buildRequestContract(a, undefined, OFF).topic).toBe("السياحة والردود");
    expect(buildRequestContract(a, undefined, ON)).toMatchObject({ platform: "tiktok", topic: "السياحة", comments: "some", replies: "some" });
    const b = "اعمل لي تعليقات تيك توك عن السياحة بس استبعد الحسابات اللي في الملف";
    expect(buildRequestContract(b, undefined, OFF).topic).toBe("السياحة بس استبعد الحسابات اللي");
    expect(buildRequestContract(b, undefined, ON).topic).toBe("السياحة");
    // the platform introduced as the source is not the topic; a country or a period after it is not the topic either
    expect(buildRequestContract("عايز تعليقات عن السياحة على تيك توك", undefined, ON)).toMatchObject({ platform: "tiktok", topic: "السياحة" });
    expect(buildRequestContract("هات تعليقات tiktok about tourism in Egypt", undefined, ON).topic).toBe("tourism");
  });

  it("the customer's own capitalization and the original text are kept (a topic is not lower-cased, the input is not replaced)", () => {
    expect(buildRequestContract("هات ١٠٠ تعليق من تيك توك عن ChatGPT", undefined, ON).topic).toBe("ChatGPT");
    const text = "  هات   كومنتات!!! من تك توك  عن   السياحة  ";
    const before = text;
    buildRequestContract(text, undefined, ON);
    expect(text).toBe(before);
  });

  it("FLAG OFF is the existing parser, byte for byte: the same contract and an empty report for every request of the 98-scenario baseline", () => {
    for (const c of baselineCases) {
      const plain = buildRequestContract(c.text, c.answer ?? undefined);
      const off = buildRequestContractWithReport(c.text, c.answer ?? undefined, OFF);
      const missing = buildRequestContractWithReport(c.text, c.answer ?? undefined);
      expect(off.contract, c.id).toEqual(plain);
      expect(missing.contract, c.id).toEqual(plain);
      expect(off.report, c.id).toEqual({ filled: [], tightened: [], cleared: [], disagreements: [] });
    }
  });
});

// ---- 2. FILL-ONLY: the parser stays authoritative ----------------------------------------------------------------------------------------------------------------------------------------------------
interface Case { id: string; group: string; text: string; answer?: string; expected: Partial<Record<keyof Understood, unknown>>; known_gap?: { ref: string; observed: Partial<Record<keyof Understood, unknown>> } }
const baselineCases = (JSON.parse(readFileSync(new URL("./fixtures/semantic-paraphrases.json", import.meta.url), "utf8")) as { cases: Case[] }).cases;

describe("fill-only: a value the parser produced is kept; the reading fills, tightens a topic, or clears a bare «X» name, and says which", () => {
  it("over the 98 scenarios, every field is equal, or was empty and is filled, or is a tightened topic, or a cleared X: and the report says exactly which", () => {
    let changed = 0;
    for (const c of baselineCases) {
      const off = buildRequestContract(c.text, c.answer ?? undefined, OFF);
      const { contract: on, report } = buildRequestContractWithReport(c.text, c.answer ?? undefined, ON);
      if (JSON.stringify(on) !== JSON.stringify(off)) changed += 1;
      // platform
      if (on.platform !== off.platform) expect(off.platform === null ? report.filled : report.cleared, `${c.id} platform`).toContain("platform");
      if (off.platform !== null && on.platform !== null) expect(on.platform, c.id).toBe(off.platform);
      // comments / replies: never taken away by the reading (X has no comments stage: a platform change may do that, and it is reported as a platform change)
      for (const f of ["comments", "replies"] as const) {
        if (off[f] !== "none" && on[f] !== off[f]) expect(on.platform, `${c.id} ${f}`).not.toBe(off.platform);
        if (off[f] === "none" && on[f] !== "none") expect(report.filled, `${c.id} ${f}`).toContain(f);
      }
      // parent kind and topic
      if (off.parentKind !== null && on.parentKind !== off.parentKind) expect(on.platform, `${c.id} kind`).not.toBe(off.platform);
      if (off.topic === null && on.topic !== null) expect(report.filled, `${c.id} topic`).toContain("topic");
      if (off.topic !== null && on.topic !== off.topic) { expect(report.tightened, `${c.id} topic`).toContain("topic"); expect(off.topic.startsWith(`${on.topic} `), c.id).toBe(true); }
      // what the reading does not read stays exactly as it was
      expect({ count: on.count, source: on.source, country: on.country, language: on.language, period: on.period }, c.id).toEqual({ count: off.count, source: off.source, country: off.country, language: off.language, period: off.period });
    }
    expect(changed).toBeGreaterThan(20);
  });

  it("a disagreement keeps the parser's value and is reported by field name only (cm-11: the parser's topic «الذكاء الاصطناعي» is kept over the reading's wider span)", () => {
    const { contract, report } = buildRequestContractWithReport("عايز داتا عن رأي الناس في الذكاء الاصطناعي", undefined, ON);
    expect(contract.topic).toBe("الذكاء الاصطناعي");
    expect(report.disagreements).toEqual(["topic"]);
    expect(JSON.stringify(report)).not.toMatch(/[ء-ي]/); // field names only: never the customer's words
  });

  it("an ambiguous reading is never made definite: a bare X with no cue, two platforms, a platform only inside the topic", () => {
    expect(buildRequestContract("هات منشورات عن تيك توك وانستجرام", undefined, ON).platform).toBe("tiktok"); // the parser's first platform, kept
    expect(buildRequestContract("فيديوهات السياحة", undefined, ON)).toMatchObject({ platform: null, topic: null });
    // the parser reads a bare «X» / «اكس» as the platform today; the reading is only ambiguous there, so it adds nothing and takes nothing away
    for (const t of ["عايز اكس", "هات منشورات X عن الانتخابات"]) expect(buildRequestContract(t, undefined, ON).platform, t).toBe(buildRequestContract(t, undefined, OFF).platform);
    expect(buildRequestContract("هات بوستات وفيديوهات", undefined, ON).parentKind).toBe("videos"); // the parser's kind; the reading is ambiguous (posts vs videos) and adds nothing
  });

  it("an explicit platform choice and a typed answer are respected: the answer is read with the request, an earlier platform is never replaced", () => {
    const withAnswer = buildRequestContract("هات كومنتات عن السياحة", "انستجرام", ON);
    expect(withAnswer).toMatchObject({ platform: "instagram", comments: "some" });
    expect(withAnswer.topic).toBe(buildRequestContract("هات كومنتات عن السياحة", "انستجرام", OFF).topic); // the parser's own reading of the joined words (the worker adds a tapped platform to the request instead, `withPlatformChoice`)
    // the request names TikTok (in a spelling the parser reads); an answer naming another platform does not change it
    expect(buildRequestContract("هات تعليقات تيك توك عن السياحة", "انستجرام", ON).platform).toBe("tiktok");
    expect(buildRequestContract("هات تعليقات تك توك عن السياحة", "انستجرام", ON).platform).toBe("instagram"); // two platforms in the words: undecided by the reading, the parser's only platform stays
  });
});

// ---- 3. across the 98 scenarios: what is really fixed, end to end ------------------------------------------------------------------------------------------------------------------------------
describe("the 98-scenario baseline with the flag ON, measured through the real contract and ask (not the isolated interpreter)", () => {
  const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
  const run = (c: Case, options: { semantic?: boolean }) => understand(c.text, c.answer ?? null, SEMANTIC_NOW_MS, options);

  const outcome = (c: Case): { kind: "fixed" | "partial" | "unchanged" | "changed_still_wrong" | "regression" | "ok"; wrong?: string[] } => {
    const off = run(c, OFF);
    const on = run(c, ON);
    const keys = Object.keys(c.expected) as Array<keyof Understood>;
    const rightOff = keys.filter((k) => same(off[k], c.expected[k]));
    const rightOn = keys.filter((k) => same(on[k], c.expected[k]));
    if (!c.known_gap) return rightOn.length === keys.length ? { kind: "ok" } : { kind: "regression", wrong: keys.filter((k) => !rightOn.includes(k)) as string[] };
    if (rightOn.length === keys.length) return { kind: "fixed" };
    if (rightOn.length > rightOff.length) return { kind: "partial", wrong: keys.filter((k) => !rightOn.includes(k)) as string[] };
    return { kind: same(on, off) ? "unchanged" : "changed_still_wrong" };
  };

  const FIXED = [
    "sa-01", "sa-02", "sa-03", "sa-08", "sb-09", "pl-04", "pl-05", "pl-07", "pl-11", "pl-14", "pl-16", "pl-17", "pl-22", "pl-24", "pl-25", "cm-02", "cm-05", "cm-06", "cm-09", "ct-07", "rt-04", "rt-05", "mt-09",
  ];
  const PARTIAL = ["sa-04", "sa-06", "pl-15", "pl-23"];

  it("OFF: the baseline of PR #446 is untouched (the 62 gaps are all still gaps with the flag OFF)", () => {
    expect(baselineCases).toHaveLength(98);
    expect(baselineCases.filter((c) => c.known_gap)).toHaveLength(62);
    for (const c of baselineCases.filter((x) => x.known_gap)) {
      const off = run(c, OFF);
      for (const [k, v] of Object.entries(c.known_gap!.observed)) expect(off[k as keyof Understood], `${c.id}.${k}`).toEqual(v);
    }
  });

  it(`ON: ${FIXED.length} of the 62 known gaps are FIXED end to end (every expected field of the case holds), ${PARTIAL.length} improve partly, none regresses`, () => {
    const gaps = baselineCases.filter((c) => c.known_gap);
    const fixed = gaps.filter((c) => outcome(c).kind === "fixed").map((c) => c.id);
    const partial = gaps.filter((c) => outcome(c).kind === "partial").map((c) => c.id);
    expect(fixed).toEqual(FIXED);
    expect(partial).toEqual(PARTIAL);
    expect(fixed.length).toBeGreaterThanOrEqual(15);
    // no scenario that was right with the flag OFF is wrong with it ON
    expect(baselineCases.filter((c) => !c.known_gap && outcome(c).kind === "regression").map((c) => c.id)).toEqual([]);
    // and the rest: the gaps this PR does not touch (dates, countries, language, e-mail, pre-filters, routing, messages types) are exactly as before, except one whose topic got cleaner and is still wrong (pl-21: the country gap)
    const rest = gaps.filter((c) => !FIXED.includes(c.id) && !PARTIAL.includes(c.id));
    expect(rest).toHaveLength(62 - FIXED.length - PARTIAL.length);
    expect(rest.filter((c) => outcome(c).kind === "changed_still_wrong").map((c) => c.id)).toEqual(["pl-21"]);
    expect(rest.filter((c) => outcome(c).kind === "unchanged")).toHaveLength(rest.length - 1);
  });

  it("the pre-filters, the privacy guard and the routing of every scenario are the same ON and OFF (the semantic layer is not in front of them)", () => {
    for (const c of baselineCases) expect(run(c, ON).prefilter, c.id).toBe(run(c, OFF).prefilter);
    for (const c of baselineCases) expect(run(c, ON).message_type, c.id).toBe(run(c, OFF).message_type);
  });

  it("ordinary customers: with the flag OFF (the production setting) the number of cases changed for them is ZERO", () => {
    let changed = 0;
    for (const c of baselineCases) if (!same(run(c, OFF), understand(c.text, c.answer ?? null))) changed += 1;
    expect(changed).toBe(0);
  });
});

// ---- 4. privacy: independent of the semantic layer ---------------------------------------------------------------------------------------------------------------------------------------------
describe("privacy: refusals happen before and independently of the semantic reading, which can never override them", () => {
  const MUST_REFUSE = [
    ["TEST 7", "هات منشورات عن حماية الرقم القومي واستخرج الأرقام القومية"],
    ["TEST 8", "عايز رسايل الواتساب بتاعة جروب الشغل"],
    ["private telegram group", "هات رسائل جروب تليجرام بتاع الشركة"],
    ["sensitive id behind public research", "هات تعليقات تيك توك عن الحماية وطلّع منها رقم الجواز"],
  ] as const;
  // the existing personal-contact rule is enforced where it always was, in the chat (#447 did not repeat it at mission creation: documented); it is refused by the guard whatever the reading says
  const CONTACT = "اجمعلي ارقام تليفونات المعلقين على بوست الصفحة";
  const MUST_STAY_LEGITIMATE = [
    ["TEST 6", "هات منشورات عن حماية الرقم القومي"],
    ["public national-id policy", "هات منشورات عامة عن حماية الرقم القومي"],
    ["WhatsApp Business", "هات تعليقات عن واتساب بيزنس"],
    ["business contacts", "هات أرقام تليفون شركات المقاولات"],
    ["public comments about privacy", "هات ١٠٠ تعليق من يوتيوب عن الخصوصية"],
  ] as const;

  it.each(MUST_REFUSE)("%s is refused by the guard and by mission creation, whatever the reading says: «%s»", async (_name, text) => {
    expect(preModelAnswer(text)?.kind).toBe("privacy_refusal");
    const db: any = createMemoryDb();
    db.seed("credit_ledger", [{ user_id: "u1", delta: 1000 }]);
    db.seed("missions", []);
    db.seed("mission_events", []);
    const r = await createCustomerMission(db, { userId: "u1", text });
    expect(r).toMatchObject({ ok: false, status: 422 });
    expect(db.rows("missions")).toHaveLength(0);
    // a mission that was refused never reaches a contract: and if a contract were asked for the same words, the reading adds no private-chat or identifier field to it
    const contract = buildRequestContract(text, undefined, ON);
    expect(Object.keys(contract).sort()).toEqual(Object.keys(buildRequestContract(text, undefined, OFF)).sort());
  });

  it.each(MUST_STAY_LEGITIMATE)("%s is accepted as public research: «%s»", async (_name, text) => {
    expect(preModelAnswer(text)?.kind ?? null).not.toBe("privacy_refusal");
    const db: any = createMemoryDb();
    db.seed("credit_ledger", [{ user_id: "u1", delta: 1000 }]);
    db.seed("missions", []);
    db.seed("mission_events", []);
    const r = await createCustomerMission(db, { userId: "u1", text });
    expect(r.ok, text).toBe(true);
    // the stored request is the customer's own text, never a normalized one
    expect(db.rows("missions")[0].request_text).toBe(text);
  });

  it("the personal-contact refusal is the guard's, unchanged by the reading", () => {
    expect(preModelAnswer(CONTACT)?.kind).toBe("privacy_refusal");
    expect(buildRequestContract(CONTACT, undefined, ON).platform).toBe(buildRequestContract(CONTACT, undefined, OFF).platform);
  });

  it("the guards, the chat and mission creation do not read the flag or import the semantic layer (no shared path, nothing to override)", () => {
    for (const f of ["guardRules.ts", "chatTurn.ts", "customerActions.ts", "messageType.ts"]) {
      const src = readFileSync(new URL(`../src/lib/agentMission/${f}`, import.meta.url), "utf8");
      expect(src, f).not.toMatch(/semantic\/|semantic_normalization|SEMANTIC_NORMALIZATION/);
    }
  });
});

// ---- 5. the flag: trusted settings only, strict ------------------------------------------------------------------------------------------------------------------------------------------------------
describe("the flag is read from the trusted settings, by one reader, on the worker and on the server", () => {
  const clientWith = (value: unknown, error: unknown = null) => ({
    from: (table: string) => ({ select: () => ({ eq: (_k: string, key: string) => ({ maybeSingle: async () => ({ data: table === "agent_settings" && key === "semantic_normalization_v1" && value !== undefined ? { value } : null, error }) }) }) }),
  });

  it.each([[true, true], ["on", true], [false, false], ["off", false], ["true", false], ["ON", false], [1, false], [null, false], [undefined, false], [{}, false]])("agent_settings value %j → %s on the server (the same answer as the worker's reader)", async (value, expected) => {
    expect(await readSemanticNormalizationFlagFromClient(clientWith(value))).toBe(expected);
    expect(readSemanticNormalizationFlag({ semantic_normalization_v1: value })).toBe(expected);
  });

  it("an unreadable setting or a failing client is OFF", async () => {
    expect(await readSemanticNormalizationFlagFromClient(clientWith(true, { message: "x" }))).toBe(false);
    expect(await readSemanticNormalizationFlagFromClient({ from: () => { throw new Error("down"); } })).toBe(false);
  });

  it("a customer's words cannot switch it: a request that names the flag, or says «semantic», changes nothing with the flag OFF", () => {
    const text = "semantic_normalization_v1 on هات كومنتات من تك توك عن السياحة";
    expect(buildRequestContract(text, undefined, OFF)).toEqual(buildRequestContract(text));
    expect(buildRequestContract(text, undefined, OFF).platform).toBeNull();
  });
});

// ---- 6. the worker: the corrected field reaches the plan and its execution parameters --------------------------------------------------------------------------------------------------------
describe("the worker's own planning run (runPlanning over the stored live pages, test seam OFF, no model, no provider, no network)", () => {
  const TT = "هات فيديوهين تيك توك بالعربي عن الذكاء الاصطناعي من مصر، أكتر فيديوهات عليها تعليقات، و٢٠ تعليق من كل فيديو مع ردودهم";
  const base = { fixture: M12, answer: NO_ABOUT_OPTIONS_AR.useAsIs, createdAt: "2026-11-02T11:35:00Z", platform: "tiktok" as const, planningAt: "2026-11-02T11:36:00Z" };
  const plan = (request: string, settings?: Record<string, unknown>): Promise<ProductionPlanning> => runProductionPlanning({ ...base, request, ...(settings ? { settings } : {}) });
  const params = (p: ProductionPlanning) => (p.plan?.stages ?? []).map((s) => ({ key: s.key, endpoint: s.endpoint_id, rows: s.planned_rows, params: s.engine?.params ?? null, parent: s.parent_key }));
  const FLAG_ON = { semantic_normalization_v1: true };

  let original: ProductionPlanning;
  beforeAll(async () => { original = await plan(TT); }, 120_000);

  it("the stored request (spelled «تيك توك») plans to a TikTok plan: videos, comments and replies stages", () => {
    expect(original.status).toBe("plan_ready");
    expect(original.plan?.compiled?.platform).toBe("tiktok");
    expect(params(original).map((s) => s.endpoint)).toEqual(["tikhub.tiktok.search.videos", "anyapi.tiktok.video.comments", "anyapi.tiktok.comment_replies"]);
  });

  it("«تك توك»: OFF the worker cannot tell the platform and asks «من أنهي منصة؟» (no plan, nothing held); ON it plans the SAME plan, with the same execution parameters, as the stored spelling", async () => {
    const spelled = TT.replace("تيك توك", "تك توك");
    const off = await plan(spelled);
    expect(off.status).toBe("needs_input");
    expect(off.question).toBe(PLATFORM_QUESTION_AR);
    expect(off.plan).toBeNull();
    const on = await plan(spelled, FLAG_ON);
    expect(on.status).toBe("plan_ready");
    expect(on.plan?.compiled?.platform).toBe("tiktok");
    expect(params(on)).toEqual(params(original));
    expect(on.mission.reserved_points).toEqual(original.mission.reserved_points);
    expect(on.mission.unit_price_points).toEqual(original.mission.unit_price_points);
    // the provider calls the worker made while planning are the same calls, with the same inputs, as for the stored spelling
    expect(on.providerCalls.map((c) => [c.endpointId, c.params])).toEqual(original.providerCalls.map((c) => [c.endpointId, c.params]));
  }, 120_000);

  it("the flag is strict on the worker too: «true» as a string, «ON», a false or an absent value all behave as OFF", async () => {
    const spelled = TT.replace("تيك توك", "تك توك");
    for (const settings of [{ semantic_normalization_v1: "true" }, { semantic_normalization_v1: "ON" }, { semantic_normalization_v1: false }, { semantic_normalization_v1: 1 }]) {
      const r = await plan(spelled, settings);
      expect(r.status, JSON.stringify(settings)).toBe("needs_input");
      expect(r.question).toBe(PLATFORM_QUESTION_AR);
    }
  }, 120_000);

  it("«كومنتس والريبلايز»: OFF the comments and replies are DROPPED silently (a videos-only plan); ON the worker does not add a stage on its own, it asks the customer how many comments per video first (the scope and the price come only after the answer, and nothing runs before approval)", async () => {
    const asked = TT.replace("أكتر فيديوهات عليها تعليقات، و٢٠ تعليق من كل فيديو مع ردودهم", "وهات الكومنتس والريبلايز");
    const off = await plan(asked);
    expect(off.status).toBe("plan_ready");
    expect(params(off).map((s) => s.endpoint)).toEqual(["tikhub.tiktok.search.videos"]); // the silent drop of today
    const on = await plan(asked, FLAG_ON);
    expect(on.status).toBe("needs_input");
    expect(on.question).toBe("كم تعليقًا تريد من كل فيديو؟ اختر «كل التعليقات» أو رقمًا.");
    expect(on.plan).toBeNull(); // no plan, no price, no reservation: the customer decides first
    expect(on.mission.reserved_points ?? null).toBeNull();
  }, 120_000);

  it("a request the parser already reads is planned identically with the flag ON (the existing value is kept): same status, same stages, same parameters, same price", async () => {
    const on = await plan(TT, FLAG_ON);
    expect(on.status).toBe(original.status);
    expect(params(on)).toEqual(params(original));
    expect(on.mission.reserved_points).toEqual(original.mission.reserved_points);
    expect(on.mission.unit_price_points).toEqual(original.mission.unit_price_points);
  }, 120_000);

  it("the plan is the single source of what executes: its own stored fields carry the platform and the parameters, so the execution phase never re-reads the request and cannot disagree about the flag", async () => {
    const on = await plan(TT.replace("تيك توك", "tik tok"), FLAG_ON);
    expect(on.plan?.compiled?.by).toBe("compiler");
    expect(on.plan?.compiled?.platform).toBe("tiktok");
    const src = readFileSync(new URL("../agent/src/runMission.ts", import.meta.url), "utf8");
    // one read of the settings per planning run feeds every contract built in it and the compiler
    expect((src.match(/readSemanticNormalizationFlag\(/g) ?? []).length).toBe(1);
    expect(src).toMatch(/\{ semantic \}\)\.platform === null/);
    expect(src).toMatch(/\.\.\.\(semantic \? \{ semantic: true \} : \{\}\)/);
  }, 120_000);
});
