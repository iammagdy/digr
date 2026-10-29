import { describe, expect, it } from "vitest";
import { chooseIdField, contentFingerprint, deriveItemId, proveMappedRows, textDedupeKey, dedupeScope } from "../src/lib/agentMission/contract";
import { assumptionLinesShown, filterLineAr, filterVerdict, findFilterFields, flagIsSet, parseFilters, promiseIssues, refitFilters, resolveFilters, type StageFilter } from "../src/lib/agentMission/filters";
import { validateAndPricePlan, customerPlanView, type PlanLookup } from "../src/lib/agentMission/plan";

const NOW = Date.parse("2026-10-29T12:00:00Z");
const ctx = { textKey: "text", now: NOW };

describe("EVERY PROMISE OF THE CARD IS A CHECK: the filters", () => {
  it("replies: the reply flag the source gives, in every shape; with no flag, a text that starts with «@» is a reply", () => {
    const byFlag: StageFilter[] = [{ kind: "exclude_replies", field: "is_reply" }];
    expect(filterVerdict(byFlag, { text: "محمد صلاح يسجل", is_reply: "نعم" }, ctx)).toBe("filter_reply");
    expect(filterVerdict(byFlag, { text: "محمد صلاح يسجل", is_reply: true }, ctx)).toBe("filter_reply");
    expect(filterVerdict(byFlag, { text: "محمد صلاح يسجل", is_reply: "12345" }, ctx)).toBe("filter_reply");
    expect(filterVerdict(byFlag, { text: "محمد صلاح يسجل", is_reply: "لا" }, ctx)).toBeNull();
    expect(filterVerdict(byFlag, { text: "محمد صلاح يسجل", is_reply: "" }, ctx)).toBeNull();
    expect(filterVerdict(byFlag, { text: "@someone محمد صلاح يسجل", is_reply: false }, ctx)).toBeNull();
    const byText: StageFilter[] = [{ kind: "exclude_replies" }];
    expect(filterVerdict(byText, { text: "@fan1 محمد صلاح يسجل هدفًا" }, ctx)).toBe("filter_reply");
    expect(filterVerdict(byText, { text: "محمد صلاح يسجل هدفًا مع @fan1" }, ctx)).toBeNull();
    expect(flagIsSet("no")).toBe(false);
    expect(flagIsSet(0)).toBe(false);
    expect(flagIsSet(null)).toBe(false);
    expect(flagIsSet("1")).toBe(true);
  });

  it("a filter that is switched off is neither applied nor promised", () => {
    expect(filterVerdict([{ kind: "exclude_replies", enabled: false }], { text: "@x رد" }, ctx)).toBeNull();
  });

  it("reposts", () => {
    expect(filterVerdict([{ kind: "exclude_reposts" }], { text: "RT @x: محمد صلاح" }, ctx)).toBe("filter_repost");
    expect(filterVerdict([{ kind: "exclude_reposts", field: "is_retweet" }], { text: "محمد", is_retweet: true }, ctx)).toBe("filter_repost");
  });

  it("language: by the script of the text, or by the language code the source gives", () => {
    const ar: StageFilter[] = [{ kind: "language", lang: "ar" }];
    expect(filterVerdict(ar, { text: "محمد صلاح يسجل هدفًا رائعًا" }, ctx)).toBeNull();
    expect(filterVerdict(ar, { text: "Salah scores a great goal for Liverpool tonight" }, ctx)).toBe("filter_language");
    expect(filterVerdict(ar, { text: "https://t.co/abc @user #tag" }, ctx)).toBeNull();
    expect(filterVerdict([{ kind: "language", lang: "ar", field: "lang" }], { text: "Salah scores", lang: "ar" }, ctx)).toBeNull();
    expect(filterVerdict([{ kind: "language", lang: "ar", field: "lang" }], { text: "محمد صلاح", lang: "en" }, ctx)).toBe("filter_language");
    expect(filterVerdict([{ kind: "language", lang: "en" }], { text: "محمد صلاح يسجل هدفًا رائعًا" }, ctx)).toBe("filter_language");
  });

  it("period: the last N days from now, or an explicit range; an item with no readable date is not inside it", () => {
    const last30: StageFilter[] = [{ kind: "period", field: "date", days: 30 }];
    expect(filterVerdict(last30, { text: "x", date: "2026-10-20T10:00:00Z" }, ctx)).toBeNull();
    expect(filterVerdict(last30, { text: "x", date: "2026-08-01T10:00:00Z" }, ctx)).toBe("filter_period");
    expect(filterVerdict(last30, { text: "x", date: "" }, ctx)).toBe("filter_period");
    const range: StageFilter[] = [{ kind: "period", field: "date", from: "2026-10-01", to: "2026-10-15" }];
    expect(filterVerdict(range, { text: "x", date: "2026-10-15T23:00:00Z" }, ctx)).toBeNull();
    expect(filterVerdict(range, { text: "x", date: "2026-10-16T00:30:00Z" }, ctx)).toBe("filter_period");
    expect(filterVerdict(range, { text: "x", date: 1_790_000_000 }, ctx)).toBe("filter_period");
  });

  it("account and place", () => {
    const acc: StageFilter[] = [{ kind: "account", field: "username", values: ["@MoSalah", "LFC"] }];
    expect(filterVerdict(acc, { text: "x", username: "mosalah" }, ctx)).toBeNull();
    expect(filterVerdict(acc, { text: "x", username: "other" }, ctx)).toBe("filter_account");
    const place: StageFilter[] = [{ kind: "place", field: "location", values: ["القاهرة", "الجيزة"] }];
    expect(filterVerdict(place, { text: "x", location: "حي المعادي، القاهرة" }, ctx)).toBeNull();
    expect(filterVerdict(place, { text: "x", location: "الإسكندرية" }, ctx)).toBe("filter_place");
  });

  it("the filters are parsed and checked: kinds, parameters, no duplicate", () => {
    expect(parseFilters([{ kind: "exclude_replies" }, { kind: "language", lang: "ar" }, { kind: "period", days: 7 }], "s").issues).toEqual([]);
    expect(parseFilters([{ kind: "nope" }], "s").issues.length).toBe(1);
    expect(parseFilters([{ kind: "language", lang: "fr" }], "s").issues.length).toBe(1);
    expect(parseFilters([{ kind: "period" }], "s").issues.length).toBe(1);
    expect(parseFilters([{ kind: "period", days: 0 }], "s").issues.length).toBe(1);
    expect(parseFilters([{ kind: "period", from: "2026-10-10", to: "2026-10-01" }], "s").issues.length).toBe(1);
    expect(parseFilters([{ kind: "account" }], "s").issues.length).toBe(1);
    expect(parseFilters([{ kind: "exclude_replies" }, { kind: "exclude_replies" }], "s").issues.length).toBe(1);
  });

  it("the fields are found by code from what the mapping gives; a filter nothing can enforce is refused; the ones the mapping could support are offered switched off", () => {
    const fields = findFilterFields({ mappedKeys: ["id", "text", "created_at", "is_reply", "lang", "username"], columnKeys: ["text", "created_at"] });
    expect(fields).toMatchObject({ text: "text", date: "created_at", replyFlag: "is_reply", lang: "lang", account: "username" });
    const ok = resolveFilters([{ kind: "exclude_replies" }, { kind: "period", days: 30 }], fields, "s");
    expect(ok.issues).toEqual([]);
    expect(ok.filters.find((f) => f.kind === "exclude_replies")).toMatchObject({ field: "is_reply" });
    expect(ok.filters.find((f) => f.kind === "period")).toMatchObject({ field: "created_at", days: 30 });
    expect(ok.filters.find((f) => f.kind === "language")).toMatchObject({ enabled: false, lang: "ar", field: "lang" });
    // no date field at all: the period cannot be enforced, so it is refused when it is on, and not offered when it is off
    const noDate = findFilterFields({ mappedKeys: ["id", "text"], columnKeys: ["text"] });
    expect(resolveFilters([{ kind: "period", days: 30 }], noDate, "s").issues.join(" ")).toContain("needs a mapped date field");
    expect(resolveFilters([{ kind: "period", days: 30, enabled: false }], noDate, "s").issues).toEqual([]);
    expect(resolveFilters([], noDate, "s").filters.some((f) => f.kind === "period")).toBe(false);
    // a field the model named that the mapping does not give is found again from what it does give
    const refit = refitFilters([{ kind: "period", days: 7, field: "nope" }], fields, ["id", "text", "created_at"], "s");
    expect(refit.filters.find((f) => f.kind === "period")).toMatchObject({ field: "created_at" });
  });

  it("the card's sentence of a filter is built by code, in Arabic with Arabic-Indic digits", () => {
    expect(filterLineAr({ kind: "exclude_replies" })).toBe("دون الردود.");
    expect(filterLineAr({ kind: "language", lang: "ar" })).toBe("باللغة العربية فقط.");
    expect(filterLineAr({ kind: "period", days: 30 })).toBe("آخر ٣٠ يومًا.");
    expect(filterLineAr({ kind: "period", days: 7 })).toBe("آخر ٧ أيام.");
    expect(filterLineAr({ kind: "period", from: "2026-10-01", to: "2026-10-15" })).toBe("من ٢٠٢٦-١٠-٠١ إلى ٢٠٢٦-١٠-١٥.");
  });
});

describe("NO PROMISE WITHOUT A CHECK", () => {
  const stage = (filters: StageFilter[] = [], hasRelevance = false) => [{ key: "t", filters, hasRelevance }];
  it("a sentence that promises replies out, a language, a period, an account, a place or namesakes out needs its filter (or the relevance rule)", () => {
    const say = (text: string, st = stage()) => promiseIssues([{ where: "summary_ar", text }], st);
    expect(say("تغريدات دون الردود").length).toBe(1);
    expect(say("التغريدات العربية الأصلية").length).toBeGreaterThan(0);
    expect(say("تغريدات عربية عن محمد صلاح").length).toBe(1);
    expect(say("تغريدات من آخر ٣٠ يومًا").length).toBe(1);
    expect(say("تغريدات من حساب محدد").length).toBe(1);
    expect(say("المنشورات في مدينة القاهرة").length).toBe(1);
    expect(say("لا الحكم أو أي شخص آخر بالاسم نفسه").length).toBe(1);
    // with the check in place the same sentences are fine
    expect(say("تغريدات دون الردود", stage([{ kind: "exclude_replies", field: "is_reply" }]))).toEqual([]);
    expect(say("تغريدات عربية عن محمد صلاح", stage([{ kind: "language", lang: "ar" }]))).toEqual([]);
    expect(say("تغريدات من آخر ٣٠ يومًا", stage([{ kind: "period", field: "date", days: 30 }]))).toEqual([]);
    expect(say("لا الحكم أو أي شخص آخر بالاسم نفسه", stage([], true))).toEqual([]);
    // a filter that is OFF does not back a promise
    expect(say("تغريدات دون الردود", stage([{ kind: "exclude_replies", enabled: false }])).length).toBe(1);
    // a sentence that promises nothing of the kind needs nothing
    expect(say("ستحصل على تغريدات عن محمد صلاح مع نص كل تغريدة ورابطها.")).toEqual([]);
  });

  it("the assumption lines the card shows: the model's own wording while its filter is ON, the code's sentence for a filter nothing says, nothing when it is off", () => {
    const lines = ["المقصود: محمد صلاح لاعب كرة القدم.", "تغريدات عربية، الأحدث أولًا."];
    expect(assumptionLinesShown(lines, [{ kind: "language", lang: "ar" }])).toEqual(lines);
    expect(assumptionLinesShown(lines, [{ kind: "language", lang: "ar" }, { kind: "exclude_replies" }])).toEqual([...lines, "دون الردود."]);
    expect(assumptionLinesShown(lines, [{ kind: "language", lang: "ar", enabled: false }])).toEqual(["المقصود: محمد صلاح لاعب كرة القدم."]);
  });
});

describe("THE CONTRACT OF THE MAPPING: an id or a key, every column, every field a filter reads", () => {
  it("the id: the item's own, else a key field every item has, else the fingerprint of its text; the same item gets the same id", () => {
    expect(chooseIdField([{ id: "a" }, { id: "b" }])).toEqual({ field: "id", basis: "id" });
    expect(chooseIdField([{ post_id: "1", text: "x" }, { post_id: "2", text: "y" }])).toEqual({ field: "post_id", basis: "key" });
    expect(chooseIdField([{ link: "https://a/1", text: "x" }, { link: "https://a/2", text: "y" }])).toEqual({ field: "link", basis: "key" });
    expect(chooseIdField([{ text: "x", author: "a" }, { text: "y", author: "b" }])).toEqual({ field: "$content", basis: "content" });
    // a key that repeats is no key
    expect(chooseIdField([{ link: "https://a", text: "x" }, { link: "https://a", text: "y" }]).basis).toBe("content");
    expect(deriveItemId({ text: "x", url: "https://a/1" }, "url")).toBe("https://a/1");
    const a = deriveItemId({ text: "محمد", author: "a", likes: 3 }, "$content");
    expect(a).toBe(deriveItemId({ text: "محمد", author: "a", likes: 99 }, "$content"));
    expect(a).not.toBe(deriveItemId({ text: "محمد", author: "b", likes: 3 }, "$content"));
    expect(contentFingerprint({ text: "x" })).toMatch(/^c_[a-z0-9]+$/);
  });

  it("the proof: a promised column the mapping does not give, a relevance text column, a field a filter reads: each is an issue naming it", () => {
    const rows = [{ id: "1", text: "محمد", date: "2026-10-20" }, { id: "2", text: "صلاح", date: "2026-10-21" }];
    expect(proveMappedRows({ rows, columnKeys: ["text", "date"], label: "s" }).issues).toEqual([]);
    expect(proveMappedRows({ rows, columnKeys: ["text", "likes"], label: "s" }).issues.join(" ")).toContain("«likes»");
    expect(proveMappedRows({ rows, columnKeys: ["text"], textColumns: ["body"], label: "s" }).issues.join(" ")).toContain("«body»");
    expect(proveMappedRows({ rows, columnKeys: ["text"], filters: [{ kind: "exclude_replies", field: "is_reply" }], label: "s" }).issues.join(" ")).toContain("«is_reply»");
    expect(proveMappedRows({ rows: [], columnKeys: ["text"], label: "s" }).issues.length).toBeGreaterThan(0);
    // a filter that is off is not required of the mapping
    expect(proveMappedRows({ rows, columnKeys: ["text"], filters: [{ kind: "exclude_replies", field: "is_reply", enabled: false }], label: "s" }).issues).toEqual([]);
  });
});

describe("THE SAME TEXT TWICE (a post, a comment): one item", () => {
  it("the key ignores links, mentions, hashtag marks, punctuation, diacritics, letter forms and case", () => {
    const k = textDedupeKey("محمدٌ صلاح يسجل هدفًا رائعًا!! https://t.co/abc @fan");
    expect(k).toBe(textDedupeKey("محمد صلاح يسجل هدفا رائعا https://t.co/zzz"));
    expect(textDedupeKey("Salah SCORES a goal tonight")).toBe(textDedupeKey("salah scores a goal tonight."));
  });
  it("a reaction is not a repeated item: a text shorter than twelve letters has no key", () => {
    expect(textDedupeKey("شكرًا")).toBeNull();
    expect(textDedupeKey("👍👍")).toBeNull();
  });
  it("the scope: a stage's items, and for comments the items of the same parent", () => {
    expect(dedupeScope(null)).toBe("root");
    expect(dedupeScope("p1")).not.toBe(dedupeScope("p2"));
  });
});

describe("the plan check: the card states what code checks", () => {
  const sample = (n: number) => ({ id: `s${n}`, text: `محمد صلاح يسجل هدفًا رقم ${n} مع ليفربول`, url: `https://x.example/s/${n}`, author: `fan${n}`, created_at: "2026-10-20T10:00:00Z", is_reply: "لا" });
  const mapped = [1, 2, 3, 4, 5].map(sample);
  const lookup = (requestText?: string, answerText?: string): PlanLookup => ({
    call: (id) => (id === "call_0001" ? { id, endpointId: "anyapi.x.search.posts", ok: true, costUsd: 0.00075, rows: 20, params: { query: "محمد صلاح" } } : null),
    evidenceText: (id) => (id === "out_0001" ? JSON.stringify(mapped) : JSON.stringify(mapped) + " https://x.example/s/1 https://x.example/s/2 s1 s2 s3 s4 s5"),
    endpointAllowed: () => true, ...(requestText ? { requestText } : {}), ...(answerText ? { answerText } : {}),
  });
  const stage = (extra: Record<string, unknown> = {}) => ({
    key: "tweets", title_ar: "التغريدات", endpoint_id: "anyapi.x.search.posts", expected_rows: 200, parent_key: null, deliver: true,
    columns: [{ key: "text", title_ar: "نص التغريدة" }, { key: "url", title_ar: "رابط التغريدة" }, { key: "author", title_ar: "الحساب" }, { key: "created_at", title_ar: "التاريخ والوقت" }],
    sample_rows: mapped.slice(0, 2), measured_by: ["call_0001", "out_0001"], relevance: { subject_ar: "لاعب كرة القدم محمد صلاح", terms: ["محمد صلاح"], text_columns: ["text"], min_own_words: 0 }, yield_from: "out_0001", ...extra,
  });
  const plan = (stageExtra: Record<string, unknown>, top: Record<string, unknown> = {}, request = "هات ٣٠٠ تغريدة عن محمد صلاح", answer?: string) =>
    validateAndPricePlan({ summary_ar: "ستحصل على تغريدات عن لاعب كرة القدم محمد صلاح مع نص كل تغريدة ورابطها.", stages: [stage(stageExtra)], ...top }, lookup(request, answer));

  it("THE TARGET IS THE CUSTOMER'S NUMBER: the model wrote 200, the customer asked for 300 in digits, in words, in dialect: the plan holds 300 and is priced on 300", () => {
    for (const request of ["هات ٣٠٠ تغريدة عن محمد صلاح", "هات 300 تغريدة عن محمد صلاح", "هات تلتمية تغريدة عن محمد صلاح", "هات ثلاثمائة تغريدة عن محمد صلاح"]) {
      const r = plan({}, {}, request);
      expect(r.ok, request).toBe(true);
      if (!r.ok) continue;
      expect(r.plan.stages[0].planned_rows).toBe(300);
      expect(r.plan.stages[0].expected_rows).toBe(300);
      expect(r.plan.price.deliveredRows).toBe(300);
      expect(r.plan.quantity).toEqual({ requested: 300, stage_key: "tweets", target: 300, source: "request" });
    }
    const more = plan({ expected_rows: 900 });
    expect(more.ok && more.plan.stages[0].planned_rows).toBe(300);
    const priced200 = plan({}, {}, "هات تغريدات عن محمد صلاح");
    expect(priced200.ok && priced200.plan.stages[0].planned_rows).toBe(200);
    expect(priced200.ok && priced200.plan.quantity).toBeUndefined();
  });

  it("an answer to the agent's question wins over the request", () => {
    const r = plan({}, {}, "هات تغريدات عن محمد صلاح", "٥٠٠ تغريدة");
    expect(r.ok && r.plan.stages[0].planned_rows).toBe(500);
  });

  it("FEWER than the customer asked for only with a reason the card shows: one number on the card, the reason beside it", () => {
    const r = plan({ expected_rows: 120, target_reason_ar: "المصدر لا يعطي أكثر من هذا العدد من التغريدات الأصلية" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.stages[0].planned_rows).toBe(120);
    expect(r.plan.quantity).toMatchObject({ requested: 300, target: 120, reason_ar: "المصدر لا يعطي أكثر من هذا العدد من التغريدات الأصلية" });
    const view = customerPlanView(r.plan);
    expect(view.stages[0].expected_rows).toBe(120);
    expect(view.notes_ar).toContain("المصدر لا يعطي أكثر من هذا العدد من التغريدات الأصلية");
    // a reason with a number in it, or in Latin letters, is refused; with no reason the customer's number is the target
    expect(plan({ expected_rows: 120, target_reason_ar: "المصدر يعطي ١٢٠ فقط" }).ok).toBe(false);
    const noReason = plan({ expected_rows: 120 });
    expect(noReason.ok && noReason.plan.stages[0].planned_rows).toBe(300);
  });

  it("the card never states a count that is not the target: the model's «حتى ٣٠٠» with a target of 120 is refused", () => {
    const r = validateAndPricePlan({ summary_ar: "تجمع لك التغريدات حتى ٣٠٠ تغريدة بقدر ما يتوفر منها.", stages: [stage({ expected_rows: 120, target_reason_ar: "المصدر لا يعطي أكثر من هذا العدد" })] }, lookup("هات ٣٠٠ تغريدة عن محمد صلاح"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.join(" ")).toContain("not a target of the plan");
  });

  it("every promise has a check: «دون الردود» and «تغريدات عربية» need their filters; with them the plan is accepted and the fields are found from the mapping", () => {
    const withoutFilters = validateAndPricePlan({ summary_ar: "ستحصل على تغريدات عربية أصلية دون الردود عن محمد صلاح.", stages: [stage()] }, lookup("هات ٣٠٠ تغريدة"));
    expect(withoutFilters.ok).toBe(false);
    if (!withoutFilters.ok) { const text = withoutFilters.issues.join(" "); expect(text).toContain("replies"); expect(text).toContain("language"); }
    const ok = validateAndPricePlan({ summary_ar: "ستحصل على تغريدات عربية أصلية دون الردود عن محمد صلاح.", stages: [stage({ filters: [{ kind: "exclude_replies" }, { kind: "language", lang: "ar" }] })] }, lookup("هات ٣٠٠ تغريدة"));
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    const f = ok.plan.stages[0].filters!;
    expect(f.find((x) => x.kind === "exclude_replies")).toMatchObject({ field: "is_reply" });
    expect(f.find((x) => x.kind === "language")).toMatchObject({ lang: "ar" });
    // the period the mapping can enforce is offered, switched off
    expect(f.find((x) => x.kind === "period")).toMatchObject({ enabled: false, field: "created_at" });
    const view = customerPlanView(ok.plan);
    expect(view.assumptions_ar).toContain("دون الردود.");
    expect(view.assumptions_ar).not.toContain("آخر ٣٠ يومًا.");
    expect(view.edit.stages[0].filters.map((x) => [x.kind, x.enabled])).toEqual([["exclude_replies", true], ["language", true], ["exclude_reposts", false], ["period", false]]);
  });

  it("a number in a sentence that is not a target is refused; per-parent numbers and the plan's own are fine", () => {
    const r = validateAndPricePlan({ summary_ar: "ستحصل على ٤٠٠ تغريدة عن محمد صلاح.", stages: [stage()] }, lookup("هات ٣٠٠ تغريدة"));
    expect(r.ok).toBe(false);
    const ok = validateAndPricePlan({ summary_ar: "ستحصل على ٣٠٠ تغريدة عن محمد صلاح من آخر ٣٠ يومًا.", stages: [stage({ filters: [{ kind: "period", days: 30 }] })] }, lookup("هات ٣٠٠ تغريدة"));
    expect(ok.ok).toBe(true);
  });

  it("a stage that hangs on the stage the quantity counts follows in proportion and never above what its parent gives", () => {
    const calls = new Map([["call_0001", { id: "call_0001", endpointId: "x.x.search-posts-all", ok: true, costUsd: 0.05, rows: 10 }], ["call_0002", { id: "call_0002", endpointId: "anyapi.instagram.post.comments", ok: true, costUsd: 0.00144, rows: 12 }]]);
    const lk: PlanLookup = { call: (id) => calls.get(id) ?? null, evidenceText: () => "9000 9001 9000-c0 https://x.example/p/9000", endpointAllowed: () => true, requestText: "هات ١٠٠ منشور وتعليقاتهم" };
    const r = validateAndPricePlan({ summary_ar: "ستحصل على منشورات وتعليقاتها في ورقتين مرتبطتين.", stages: [
      { key: "posts", title_ar: "المنشورات", endpoint_id: "x.x.search-posts-all", expected_rows: 20, parent_key: null, deliver: true, columns: [{ key: "text", title_ar: "النص" }], sample_rows: [{ id: "9000", text: "a", url: "https://x.example/p/9000" }], measured_by: ["call_0001"] },
      { key: "comments", title_ar: "التعليقات", endpoint_id: "anyapi.instagram.post.comments", expected_rows: 200, parent_key: "posts", per_parent_rows: 12, deliver: true, columns: [{ key: "text", title_ar: "النص" }], sample_rows: [{ id: "9000-c0", text: "x" }], measured_by: ["call_0002"] },
    ] }, lk);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.stages[0].planned_rows).toBe(100);
    // 200 comments for 20 posts became 1000 for 100 posts: 100 x 12 = 1200 is the ceiling
    expect(r.plan.stages[1].planned_rows).toBe(1000);
  });

  it("a quantity the stage cannot reach through its parent is refused with what to do", () => {
    const calls = new Map([["call_0001", { id: "call_0001", endpointId: "x.x.search-posts-all", ok: true, costUsd: 0.05, rows: 10 }], ["call_0002", { id: "call_0002", endpointId: "anyapi.instagram.post.comments", ok: true, costUsd: 0.00144, rows: 12 }]]);
    const lk: PlanLookup = { call: (id) => calls.get(id) ?? null, evidenceText: () => "9000 9001 9000-c0 https://x.example/p/9000", endpointAllowed: () => true, requestText: "هات ٥٠٠ تعليق" };
    const r = validateAndPricePlan({ summary_ar: "ستحصل على منشورات وتعليقاتها في ورقتين مرتبطتين.", stages: [
      { key: "posts", title_ar: "المنشورات", endpoint_id: "x.x.search-posts-all", expected_rows: 20, parent_key: null, deliver: false, columns: [{ key: "text", title_ar: "النص" }], sample_rows: [{ id: "9000", text: "a", url: "https://x.example/p/9000" }], measured_by: ["call_0001"] },
      { key: "comments", title_ar: "التعليقات", endpoint_id: "anyapi.instagram.post.comments", expected_rows: 200, parent_key: "posts", per_parent_rows: 5, deliver: true, columns: [{ key: "text", title_ar: "النص" }], sample_rows: [{ id: "9000-c0", text: "x" }], measured_by: ["call_0002"] },
    ] }, lk);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.join(" ")).toContain("raise the parent stage's expected_rows or per_parent_rows");
  });
});
