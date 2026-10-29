import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { classifyRow, classifyRowDetailed, looksLikeList, validateRelevanceSpec, type RelevanceSpec } from "../src/lib/agentMission/relevance";
import { filterVerdict, startsWithHandle, type StageFilter } from "../src/lib/agentMission/filters";
import { textDedupeKey } from "../src/lib/agentMission/contract";
import { missionDownloadName } from "../src/lib/agentMission/fileNames";
import { customerFileLink } from "../src/lib/agentMission/customerActions";
import { fileLink } from "../src/lib/agentMission/adminActions";
import { customerSafeText, isInternalPhrase } from "../src/lib/agentMission/text";
import { customerMissionView, type CustomerMissionView } from "../src/lib/agentMission/customerView";
import { buildMissionNotice } from "../src/lib/agentMission/notices";
import { buildMissionFiles, workbookNoteAr } from "../agent/src/workbook";
import type { PricedPlan } from "../src/lib/agentMission/plan";

/**
 * THE NAMESAKE, THE REPLY, THE REPEAT, THE FILE NAME, THE ENGLISH LINE AND THE FILE NOTE of the live run of 2026-10-29 (msn_169c911fd8a0a5c89cf1), on four mission types: X tweets about a person, Facebook posts about a person,
 * TikTok comments about a brand, and the employees of a company. Each section is one root cause; none of them is written for «محمد صلاح».
 */
interface Kind { name: string; spec: RelevanceSpec; about: string; namesake: string; namesakeByPlan: string; ad: string; list: string; context: string; reply: string }
const spec = (o: Partial<RelevanceSpec> & Pick<RelevanceSpec, "terms">): RelevanceSpec => ({ subject_ar: "الموضوع", text_columns: ["text"], min_own_words: 2, review: true, ...o });
const KINDS: Kind[] = [
  {
    name: "X tweets about a footballer",
    spec: spec({ terms: ["محمد صلاح", "Mohamed Salah"], context_terms: ["ليفربول", "هدف", "الأهلي"], competing_meanings: [{ meaning_ar: "الحكم محمد صلاح عبد الفتاح", titles: ["حكم", "الخبير التحكيمي"] }, { meaning_ar: "المدرب محمد صلاح أبو عمر", extensions: ["أبو عمر"], titles: ["مدرب"] }] }),
    about: "محمد صلاح يسجل هدفًا رائعًا مع ليفربول الليلة", namesake: "محمد صلاح عبد الفتاح يدير مباراة الأهلي والزمالك الليلة", namesakeByPlan: "المدرب محمد صلاح يقود تدريب الفريق قبل مباراة الدوري",
    ad: "ورشة تنمية القدرات اللفظية مع محمد صلاح، سجل الآن وانضم إلينا", list: "أسماء الحضور: أحمد عز، محمد صلاح، نجيب ساويرس، هشام طلعت مصطفى، محمد منصور", context: "هدف", reply: "@fan1 محمد صلاح يسجل هدفًا رائعًا مع ليفربول",
  },
  {
    name: "Facebook posts about a doctor",
    spec: spec({ terms: ["مصطفى محمود"], context_terms: ["الدكتور", "العلم والإيمان", "مسجد", "كتاب"], competing_meanings: [{ meaning_ar: "مصطفى محمود الموظف", titles: ["الموظف"] }] }),
    about: "الدكتور مصطفى محمود قدّم برنامج العلم والإيمان لسنوات طويلة", namesake: "مصطفى محمود عبد الرازق فاز بجائزة الحي هذا العام مع الدكتور سامي", namesakeByPlan: "الموظف مصطفى محمود تسلّم عمله الجديد في الدكتور سامي",
    ad: "دورة تدريبية في الإدارة مع مصطفى محمود، رابط التسجيل في التعليقات", list: "أسماء الفائزين: أحمد علي، مصطفى محمود، سارة حسن، هالة يوسف، كريم عادل", context: "مسجد", reply: "@someone مصطفى محمود رحمه الله كان عالمًا كبيرًا",
  },
  {
    name: "TikTok comments about a brand",
    spec: spec({ terms: ["نيسان صني"], context_terms: ["سيارة", "موديل", "عفشة", "بنزين"], competing_meanings: [] }),
    about: "نيسان صني موديل جديد والسيارة ممتازة في استهلاك البنزين", namesake: "نيسان صني الدين اشترى بيتًا جديدًا وسيارة جديدة", namesakeByPlan: "نيسان صني موديل قديم",
    ad: "خصم كبير على الإكسسوارات مع نيسان صني، تواصل معنا الآن", list: "الأنواع: كيا، هيونداي، نيسان صني، تويوتا، شيفروليه، بيجو", context: "سيارة", reply: "@omar نيسان صني سيارة ممتازة للعائلة",
  },
  {
    name: "employees of a company",
    spec: spec({ terms: ["أحمد منصور"], context_terms: ["مدير", "شركة", "المبيعات", "الموارد البشرية"] }),
    about: "أحمد منصور مدير المبيعات في شركة النيل للتجارة", namesake: "أحمد منصور عبد الله طبيب الأسنان في المعادي", namesakeByPlan: "أحمد منصور مدير المبيعات في شركة النيل",
    ad: "وظائف شاغرة لدينا، للتواصل مع أحمد منصور واتساب فقط", list: "فريق العمل: سارة، أحمد منصور، هالة، كريم، مها، ياسر، نادين", context: "مدير", reply: "@hr أحمد منصور مدير في شركة النيل",
  },
];

describe.each(KINDS)("A. $name", (k) => {
  it("the name extended by more name words is another person: excluded by rule even with a context word in the text (built in: «عبد…», «أبو», «الدين»)", () => {
    const v = classifyRow(k.spec, { text: k.namesake });
    expect(v).toEqual({ verdict: "exclude", reason: "name_extended" });
  });

  it("a title right next to the name, listed by the plan, excludes by rule; the same text with no list in the plan is judged by the other rules (here: a match)", () => {
    const hasList = (k.spec.competing_meanings ?? []).length > 0;
    expect(classifyRow(k.spec, { text: k.namesakeByPlan })).toEqual(hasList ? { verdict: "exclude", reason: "name_extended" } : { verdict: "match" });
    expect(classifyRow({ ...k.spec, competing_meanings: undefined }, { text: k.namesakeByPlan }).verdict).toBe("match");
  });

  it("an ordinary item about the intended meaning is a match", () => {
    expect(classifyRow(k.spec, { text: k.about }).verdict).toBe("match");
  });

  it("an advert or a list with the name and NO word of the intended meaning goes to the model check, never straight to delivery; with a word of the meaning it is judged as before", () => {
    expect(classifyRow(k.spec, { text: k.ad })).toEqual({ verdict: "review", reason: "uncertain" });
    expect(classifyRow(k.spec, { text: k.list })).toEqual({ verdict: "review", reason: "uncertain" });
    expect(looksLikeList(k.list)).toBe(true);
    expect(classifyRow(k.spec, { text: `${k.about} ${k.context}` }).verdict).toBe("match");
  });

  it("the decoration of the text changes nothing: emoji, invisible marks and spaces in front do not hide a namesake", () => {
    for (const prefix of ["🔴 عاجل | ", "  ⚽ ", "‏1️⃣ ", "﻿", "​​"]) expect(classifyRow(k.spec, { text: `${prefix}${k.namesake}` }), prefix).toEqual({ verdict: "exclude", reason: "name_extended" });
  });
});

describe("A. the rest of the rule", () => {
  const footballer = KINDS[0].spec;
  it("an extension that is itself one of the plan's own terms (a nickname) is the SAME person", () => {
    const s = spec({ terms: ["محمد صلاح", "محمد صلاح أبو مكة"], context_terms: ["ليفربول"] });
    expect(classifyRowDetailed(s, { text: "محمد صلاح أبو مكة يسجل هدفًا مع ليفربول" }).verdict).toBe("match");
    expect(classifyRowDetailed({ ...s, terms: ["محمد صلاح"] }, { text: "محمد صلاح أبو مكة يسجل هدفًا مع ليفربول" }).verdict).toBe("exclude");
  });

  it("Latin spellings: «Mohamed Salah Abdel Fattah» is another person; «Mohamed Salah scored» is not", () => {
    expect(classifyRow(footballer, { text: "Mohamed Salah Abdel Fattah refereed the derby today" })).toEqual({ verdict: "exclude", reason: "name_extended" });
    expect(classifyRow(footballer, { text: "Mohamed Salah scored a great goal for Liverpool today" }).verdict).toBe("match");
  });

  it("the words of another meaning (markers): excluded when the text has no word of the intended meaning, reviewed when it has one", () => {
    const s = spec({ terms: ["أحمد منصور"], context_terms: ["شركة"], competing_meanings: [{ meaning_ar: "المذيع أحمد منصور", markers: ["بلا حدود", "الجزيرة"] }] });
    expect(classifyRow(s, { text: "أحمد منصور في حلقة جديدة من برنامج بلا حدود اليوم" })).toEqual({ verdict: "exclude", reason: "other_meaning" });
    expect(classifyRow(s, { text: "أحمد منصور في حلقة بلا حدود عن شركة الاتصالات" })).toEqual({ verdict: "review", reason: "uncertain" });
  });

  it("the plan's list is validated: a short Arabic meaning and at least one of extensions, titles, markers", () => {
    const ok = validateRelevanceSpec({ subject_ar: "لاعب كرة القدم", terms: ["محمد صلاح"], text_columns: ["text"], competing_meanings: [{ meaning_ar: "الحكم محمد صلاح عبد الفتاح", extensions: ["عبد الفتاح"], titles: ["حكم"] }] }, ["text"]);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.spec.competing_meanings).toEqual([{ meaning_ar: "الحكم محمد صلاح عبد الفتاح", extensions: ["عبد الفتاح"], titles: ["حكم"] }]);
    for (const bad of [[{ meaning_ar: "Referee" }], [{ meaning_ar: "الحكم محمد صلاح" }], [{ meaning_ar: "ok مرجع", extensions: ["x"] }], "no"]) {
      const r = validateRelevanceSpec({ subject_ar: "لاعب كرة القدم", terms: ["محمد صلاح"], text_columns: ["text"], competing_meanings: bad }, ["text"]);
      expect(r.ok, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe.each(KINDS)("B. one item written twice, whatever its decoration: $name", (k) => {
  it("the same text with emoji, hashtags, links, spaces, invisible marks and a leading marker has ONE key; another text has another", () => {
    const base = k.about;
    const keys = [base, `🔴 عاجل | ${base}`, `  ${base}  `, `${base} #وسم_جديد`, `1️⃣ ${base}`, `بالفيديو.. ${base} https://t.co/abc`, `‏${base}`, `عاجل ⚠️ ${base}`, `${base}!!!`].map(textDedupeKey);
    expect(keys[0]).not.toBeNull();
    expect(new Set(keys).size).toBe(1);
    expect(textDedupeKey(`${base} وأيضًا خبر آخر مختلف`)).not.toBe(keys[0]);
    expect(textDedupeKey(k.about.replace(/\d+/g, "7"))).not.toBeNull();
  });
});

describe("B. the edges", () => {
  it("different numbers are different items; a reaction is not an item to de-duplicate", () => {
    expect(textDedupeKey("محمد صلاح يسجل هدفًا رقم ١٢ الليلة")).not.toBe(textDedupeKey("محمد صلاح يسجل هدفًا رقم ١٣ الليلة"));
    expect(textDedupeKey("شكرًا 👍")).toBeNull();
    expect(textDedupeKey("🔴 عاجل")).toBeNull();
  });
});

describe.each([["X tweets", "@fan1 رأيي في المباراة أن الفريق لعب جيدًا"], ["Facebook comments", "@sara.ali شكرًا على المعلومة المفيدة جدًا"], ["TikTok comments", "@omar_1 السيارة ممتازة للعائلة فعلًا"], ["Instagram replies", "@a.b_c حلو الفيديو ده والله"]])("C. a text that starts with «@handle» is a reply when the card promises none: %s", (_name, text) => {
  const promise: StageFilter[] = [{ kind: "exclude_replies", field: "is_reply" }];
  const ctx = { textKey: "text", now: Date.parse("2026-10-29T10:00:00Z") };
  it("with the source's flag saying «not a reply», with no flag at all, with the flag set; and after spaces and invisible marks", () => {
    for (const lead of ["", " ", "   ", "‏", "‏  ", "​", "﻿", " ", "‎ ‏", "\n"]) {
      expect(startsWithHandle(`${lead}${text}`), JSON.stringify(lead)).toBe(true);
      expect(filterVerdict(promise, { text: `${lead}${text}`, is_reply: false }, ctx), JSON.stringify(lead)).toBe("filter_reply");
      expect(filterVerdict(promise, { text: `${lead}${text}`, is_reply: "" }, ctx)).toBe("filter_reply");
      expect(filterVerdict([{ kind: "exclude_replies" }], { text: `${lead}${text}` }, ctx)).toBe("filter_reply");
    }
    expect(filterVerdict(promise, { text, is_reply: true }, ctx)).toBe("filter_reply");
  });
  it("a text that only MENTIONS an account later, or has an e-mail, is not a reply; the filter off lets a reply through", () => {
    expect(startsWithHandle("رأيي مع @someone أن الفريق لعب جيدًا")).toBe(false);
    expect(startsWithHandle("راسلنا على info@example.com للتفاصيل")).toBe(false);
    expect(startsWithHandle("@")).toBe(false);
    expect(filterVerdict(promise, { text: "رأيي مع @someone أن الفريق لعب جيدًا", is_reply: false }, ctx)).toBeNull();
    expect(filterVerdict([{ kind: "exclude_replies", field: "is_reply", enabled: false }], { text, is_reply: false }, ctx)).toBeNull();
  });
});

// ------------------------------------------------------------------------------------------------------------------ D. the file name
interface FakeRow { id: string; user_id: string; files: unknown; plan: unknown; request_text: string; delivered_units: number; updated_at: string }
const fakeClient = (row: FakeRow, signed: Array<{ path: string; download: string | undefined }>) => ({
  from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: row, error: null }) }) }) }),
  storage: { from: () => ({ createSignedUrl: async (path: string, _ttl: number, options?: { download?: string }) => { signed.push({ path, download: options?.download }); return { data: { signedUrl: `https://signed.example/${path}` }, error: null }; } }) },
});
const planOf = (title: string): any => ({ stages: [{ key: "s", title_ar: title, deliver: true, relevance: { terms: ["محمد صلاح"], subject_ar: "لاعب" } }] });

describe("D. ONE name for every download of a mission's file", () => {
  const files = (stored: boolean) => [
    { kind: "xlsx", name: "result.xlsx", path: "result/result.xlsx", ...(stored ? { download_name: "تغريدات عن محمد صلاح - ٦٧ - ٢٩ أكتوبر ٢٠٢٦.xlsx" } : {}) },
    { kind: "csv", name: "result.csv", path: "result/result.csv", ...(stored ? { download_name: "تغريدات عن محمد صلاح - ٦٧ - ٢٩ أكتوبر ٢٠٢٦.csv" } : {}) },
  ];
  const row = (stored: boolean): FakeRow => ({ id: "msn_1", user_id: "u1", files: files(stored), plan: planOf("التغريدات"), request_text: "هات ٣٠٠ تغريدة عن محمد صلاح", delivered_units: 67, updated_at: "2026-10-29T07:00:00Z" });

  it.each([["xlsx"], ["csv"]])("the completion panel, the admin's link and «طلباتي» give the same %s name, the mission's (stored with the file)", async (kind) => {
    const signed: Array<{ path: string; download: string | undefined }> = [];
    const client = fakeClient(row(true), signed);
    const name = `result.${kind}`;
    const a = await customerFileLink(client, { id: "msn_1", userId: "u1", name });
    const b = await fileLink(client, { id: "msn_1", name });
    expect(a.ok && b.ok).toBe(true);
    const viaHelper = missionDownloadName({ files: files(true), kind, plan: planOf("التغريدات"), requestText: "هات ٣٠٠ تغريدة عن محمد صلاح", deliveredUnits: 67, date: "2026-10-29T07:00:00Z" });
    expect(signed.map((s) => s.download)).toEqual([viaHelper, viaHelper]);
    expect(viaHelper).toBe(`تغريدات عن محمد صلاح - ٦٧ - ٢٩ أكتوبر ٢٠٢٦.${kind}`);
    expect(signed.every((s) => s.download !== "result.xlsx" && s.download !== "result.csv")).toBe(true);
  });

  it("a mission delivered before the names were stored is named from its plan, the same way, by all three", async () => {
    const signed: Array<{ path: string; download: string | undefined }> = [];
    const client = fakeClient(row(false), signed);
    await customerFileLink(client, { id: "msn_1", userId: "u1", name: "result.xlsx" });
    await fileLink(client, { id: "msn_1", name: "result.xlsx" });
    const viaHelper = missionDownloadName({ files: files(false), kind: "xlsx", plan: planOf("التغريدات"), requestText: "هات ٣٠٠ تغريدة عن محمد صلاح", deliveredUnits: 67, date: "2026-10-29T07:00:00Z" });
    expect(viaHelper).toBe("تغريدات عن محمد صلاح - ٦٧ - ٢٩ أكتوبر ٢٠٢٦.xlsx");
    expect(signed.map((s) => s.download)).toEqual([viaHelper, viaHelper]);
  });

  it("a name never carries a forbidden character; only a mission with no plan and no stored name keeps the file's own name", () => {
    expect(missionDownloadName({ files: [{ kind: "xlsx", name: "result.xlsx", download_name: "تغريدات: عن/محمد? - ٦٧.xlsx" }], kind: "xlsx" })).toBe("تغريدات- عن-محمد- - ٦٧.xlsx");
    expect(missionDownloadName({ files: [{ kind: "xlsx", name: "result.xlsx" }], kind: "xlsx" })).toBe("result.xlsx");
  });

  it("the other download routes call this one function (there is no second naming code)", async () => {
    const { readFileSync } = await import("node:fs");
    const route = readFileSync("src/app/api/jobs/[id]/download/route.ts", "utf8");
    expect(route).toContain("missionDownloadName");
    expect(route).not.toContain("missionFileTitleAr");
    expect(readFileSync("src/lib/agentMission/customerActions.ts", "utf8")).toContain("missionDownloadName");
    expect(readFileSync("src/lib/agentMission/adminActions.ts", "utf8")).toContain("missionDownloadName");
    expect(readFileSync("src/lib/agentMission/customerActions.ts", "utf8")).not.toMatch(/createSignedUrl\([^)]*\{ download: file\.name \}/);
    expect(readFileSync("src/lib/agentMission/adminActions.ts", "utf8")).not.toMatch(/createSignedUrl\([^)]*\{ download: file\.name \}/);
  });
});

// ------------------------------------------------------------------------------------------------------------------ E. the English line
const STATES = ["queued", "planning", "needs_input", "plan_ready", "approved", "executing", "completed", "unserved", "failed", "cancelled"] as const;
const planPublic = (title: string) => ({ summary_ar: "ستحصل على تغريدات عن الموضوع", stages: [{ key: "s", title_ar: title, expected_rows: 300, deliver: true, columns: [{ key: "text", title_ar: "النص" }], sample_rows: [] }], price: { max_charge_points: 200, reserve_points: 200, unit_price_points: 0.67 }, assumptions_ar: ["agent mission note", "المقصود: الموضوع"], notes_ar: ["internal_error rows_tweets"] });
const LATIN = /[A-Za-z]{2,}/;
const customerStrings = (v: CustomerMissionView): string[] => [v.summaryAr, ...v.notesAr, ...v.assumptionsAr, ...v.questionOptionsAr, v.questionAr, v.queueLineAr, v.priceLineAr, v.priceNoteAr, v.fileContentsAr, v.currentLineAr, v.delayAr, v.remainingAr, v.closePageAr, ...v.resultLinesAr, v.resultSummaryAr, v.endLineAr, ...v.stages.flatMap((s) => [s.titleAr, s.noteAr]), ...v.steps.flatMap((s) => [s.titleAr, s.countAr]), v.samples?.stageTitleAr].filter((x): x is string => typeof x === "string");

describe("E. no English or internal phrase in any customer text, in any state of a mission, including what older missions stored", () => {
  it.each(STATES)("status %s: summary, question, events, plan lines and stage titles stored in English or with internal names are shown in Arabic", (status) => {
    const view = customerMissionView({
      mission: { id: "msn_1", status, question_ar: "Which Salah?", plan_public: planPublic("Tweets about Salah"), reserved_points: 200, unit_price_points: 0.67, delivered_units: status === "completed" ? 120 : status === "unserved" || status === "failed" ? 0 : null, charged_points: status === "completed" ? 80 : status === "unserved" || status === "failed" ? 0 : null, summary_ar: "agent mission delivered nothing — engine_zero_ingest", files: null, created_at: "2026-10-29T06:00:00Z" },
      events: [{ id: 1, kind: "progress", message_ar: "fetching page 3 from provider", counts: null, created_at: "2026-10-29T06:01:00Z" }, { id: 2, kind: "system", message_ar: "worker restarted", counts: null, created_at: "2026-10-29T06:02:00Z" }],
      now: Date.parse("2026-10-29T06:03:00Z"),
    });
    for (const t of customerStrings(view)) {
      expect(t, `${status}: «${t}»`).not.toMatch(LATIN);
      expect(t, `${status}: «${t}»`).not.toMatch(/_[a-z]|admin:/i);
    }
  });

  it("an Arabic sentence is shown as it is; a known English release reason is shown as its Arabic meaning; an unknown one as the neutral sentence", () => {
    expect(customerSafeText("لم نجد ما يطابق طلبك.")).toBe("لم نجد ما يطابق طلبك.");
    expect(customerSafeText("agent mission delivered nothing")).toBe("لم نجد ما يطابق طلبك.");
    expect(customerSafeText("agent mission: the result files could not be saved")).toBe("تعذّر حفظ ملفات النتيجة.");
    expect(customerSafeText("Something odd happened", "تعذّر عرض هذه الخطوة.")).toBe("تعذّر عرض هذه الخطوة.");
    expect(customerSafeText("admin: engine_zero_ingest stage=tweets")).toContain("ولم يُخصم منك شيء");
    expect(customerSafeText("تغريدات عن Salah ٢٠٢٦")).toBe("تغريدات عن Salah ٢٠٢٦");
    expect(customerSafeText("خصم 5 نقاط")).toBe("خصم ٥ نقاط");
    expect(customerSafeText(null)).toBe("");
    expect(isInternalPhrase("agent mission delivered nothing — x")).toBe(true);
    expect(isInternalPhrase("مهمة msn_1abc انتهت")).toBe(true);
    expect(isInternalPhrase("N/A")).toBe(false);
  });

  it("«طلباتي»: the line of an unserved mission whose stored reason is English reads in Arabic (the page passes the stored reason through the guard before it adds the released hold)", async () => {
    const { readFileSync } = await import("node:fs");
    const page = readFileSync("src/app/dashboard/requests/page.tsx", "utf8");
    expect(page.indexOf('customerSafeText(cleaned, "تعذر إكمال البحث")')).toBeGreaterThan(0);
    expect(page.indexOf('customerSafeText(cleaned, "تعذر إكمال البحث")')).toBeLessThan(page.indexOf("normalizeReleaseWording(cleaned)"));
    for (const stored of ["agent mission delivered nothing", "agent mission delivered nothing — nothing matched", "agent mission: the job could not be locked against the old driver"]) {
      const shown = customerSafeText(stored, "تعذر إكمال البحث");
      expect(shown, stored).not.toMatch(LATIN);
      expect(shown.length).toBeGreaterThan(5);
    }
  });

  it("the notices (in-site and e-mail) never carry a Latin-only title, in any kind", () => {
    for (const kind of ["completed", "partial", "failed", "unserved"] as const) {
      const n = buildMissionNotice(kind, { delivered: kind === "completed" || kind === "partial" ? 67 : 0, planned: 300, chargedPoints: 0, releasedPoints: 200, reservedPoints: 200, noun: "تغريدة", hasJob: true }, "Tweets about Salah");
      for (const t of [n.title, n.body, n.email!.subject, n.email!.heading, n.email!.lead, n.email!.preheader]) expect(t, `${kind}: ${t}`).not.toMatch(LATIN);
    }
  });

  it("the settlement writes its reasons in Arabic from now on (nothing English is stored for a customer to read later)", async () => {
    const { readFileSync } = await import("node:fs");
    for (const f of ["src/lib/agentMission/lifecycle.ts", "agent/src/runMission.ts"]) {
      const src = readFileSync(f, "utf8");
      expect(src, f).not.toMatch(/releaseReason: "agent mission|p_error_message: "agent mission|\?\? "agent mission/);
    }
  });
});

// ------------------------------------------------------------------------------------------------------------------ F. the file note
const stage = (key: string, title: string, parent: string | null, columns: Array<{ key: string; title_ar: string }>, extra: Record<string, unknown> = {}) => ({ key, title_ar: title, endpoint_id: "e", expected_rows: 3, planned_rows: 3, deliver: true, parent_key: parent, columns, sample_rows: [], ...extra });
const planFor = (stages: unknown[]): PricedPlan => ({ summary_ar: "ملخص", stages, price: {} } as unknown as PricedPlan);
const readNote = async (plan: PricedPlan, rows: Record<string, Array<Record<string, unknown>>>) => {
  const built = await buildMissionFiles(plan, rows);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(built.xlsx as unknown as ArrayBuffer);
  const summary = wb.worksheets[0];
  const headers = wb.worksheets.slice(1).map((s) => (s.getRow(1).values as unknown[]).slice(1).map(String));
  return { note: String(summary.getRow(summary.rowCount).getCell(1).value), headers, sheets: wb.worksheets.length - 1 };
};

describe("F. the note of the summary sheet describes only the sheets and columns the file really has", () => {
  it("one sheet, no parent, no date: no «معرّف الأصل», no link between sheets, no time zone", async () => {
    const { note, headers, sheets } = await readNote(planFor([stage("t", "التغريدات", null, [{ key: "text", title_ar: "نص التغريدة" }, { key: "likes", title_ar: "الإعجابات" }])]), { t: [{ id: "1", text: "أ", likes: 1 }, { id: "2", text: "ب", likes: 2 }] });
    expect(sheets).toBe(1);
    expect(headers[0]).toContain("المعرّف");
    expect(headers[0]).not.toContain("معرّف الأصل");
    expect(note).not.toContain("معرّف الأصل");
    expect(note).not.toContain("للربط بين الأوراق");
    expect(note).not.toContain("توقيت القاهرة");
    expect(note).toContain("المعرّف");
  });

  it("one sheet with a date column says the time zone and nothing about links", async () => {
    const { note } = await readNote(planFor([stage("t", "التغريدات", null, [{ key: "text", title_ar: "نص التغريدة" }, { key: "date", title_ar: "التاريخ والوقت" }])]), { t: [{ id: "1", text: "أ", date: "2026-10-20T10:00:00Z" }, { id: "2", text: "ب", date: "2026-10-21T10:00:00Z" }] });
    expect(note).toContain("توقيت القاهرة");
    expect(note).not.toContain("معرّف الأصل");
  });

  it("two sheets with a parent: the parent column, the link between sheets and how to use it are described, because they exist", async () => {
    const plan = planFor([stage("p", "المنشورات", null, [{ key: "text", title_ar: "نص المنشور" }]), stage("c", "التعليقات", "p", [{ key: "text", title_ar: "نص التعليق" }])]);
    const { note, headers, sheets } = await readNote(plan, { p: [{ id: "p1", text: "منشور" }], c: [{ id: "c1", parent_id: "p1", text: "تعليق" }] });
    expect(sheets).toBe(2);
    expect(headers[1]).toContain("معرّف الأصل");
    expect(note).toContain("معرّف الأصل");
    expect(note).toContain("للربط بين الأوراق");
    expect(note).toContain("اضغط على «معرّف الأصل»");
  });

  it("the note is a function of the facts: no parent column means no mention of one, whatever else is true", () => {
    for (const sheets of [1, 2, 3]) for (const hasDateColumn of [true, false]) {
      const n = workbookNoteAr({ sheets, hasParentColumn: false, parentLinked: false, hasDateColumn });
      expect(n).not.toContain("معرّف الأصل");
      expect(n).not.toContain("للربط");
      expect(n.includes("توقيت القاهرة")).toBe(hasDateColumn);
    }
    expect(workbookNoteAr({ sheets: 2, hasParentColumn: true, parentLinked: false, hasDateColumn: false })).not.toContain("اضغط");
  });
});
