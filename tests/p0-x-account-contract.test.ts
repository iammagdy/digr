import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { createMemoryStore } from "../agent/src/memoryStore";
import { planByCompiler } from "../agent/src/compiled";
import { RAW_PATH } from "../agent/src/gateway";
import { namedSourceTruthAr, shortfallClauseAr, shortfallFromStopAr } from "../agent/src/finalize";
import { buildShapeDigest } from "../src/lib/modelPlanner/digest";
import { buildAsk } from "../src/lib/agentMission/foundation/ask";
import { carriedBy, compilePlan, parentEligible, parentInputs } from "../src/lib/agentMission/foundation/compilePlan";
import { cardOf } from "../src/lib/agentMission/foundation/toolCards";
import { filterVerdict, parseFilters, resolveFilters, findFilterFields, type StageFilter } from "../src/lib/agentMission/filters";
import { buildRequestContract } from "../src/lib/agentMission/requestContract";
import { REVISION_JOINER_AR } from "../src/lib/agentMission/revisionText";
import { isFollowUpOfEndedRequest } from "../src/lib/agentMission/chatTurn";
import { customerPlanView } from "../src/lib/agentMission/plan";
import { checkCustomerText } from "../src/lib/agentMission/text";
import {
  X_ACCOUNT_DECLINED_AR, X_ACCOUNT_OPTIONS_AR, xAccountAnswerOf, xAccountNoteAr, xAccountMentionOf, xAccountQuestionAr, xHandleIn, xHandleMatches, xHandleOfAsk, xHandleOfSource,
} from "../src/lib/agentMission/foundation/xAccount";

/**
 * P0, 14 NOV 2026: CUSTOMER DELIVERY FAILURE (recorded production evidence, zero paid calls).
 * The customer asked for 400 real X posts of the Saudi Ministry of Health's official account about health rumors. Three missions:
 *   msn_93ed6dea95edb303fd2b: «… على وزارة الصحة السعودية على إكس خلال آخر ٣ أشهر»: the account was not read at all; all of X was searched for «الشائعات الصحية»; 1 tweet delivered (the Iraqi Ministry of Interior's), 1 point charged, «completed»;
 *   msn_fefee20b5a4dfc1aafc2: «… عبر الصفحة الرسمية لوزارة الصحة السعودية أو أي تصحيح لشائعة صحية على إكس»: the whole sentence was the exact search phrase; nothing found, «unserved»;
 *   msn_dd7c2e9c131b8783bf2e: «طيب ابحث عن الشائعات فقط» in the same conversation became a NEW request of its own words; the account was read as a name but never written into the search; «الشائعات فقط» searched
 *     across all of X; 79 tweets of 38 other accounts delivered, 40 points charged, «completed», with 158 delivery-contract completions of «غير مطابق» marks that the customer never read.
 * The fixture is those missions' recorded plans (their pinned pool rows rebuilt in the provider's page shape, anonymised) and their recorded outcomes.
 */
const fx = JSON.parse(readFileSync(new URL("./fixtures/p0-x-account/production-2026-11-14.json", import.meta.url), "utf8")) as {
  missions: Record<string, { request_text: string; answer_text: string | null; created_at: string; engine_params?: { query: string }; pool_page?: { output: { data: { items: Array<Record<string, unknown>> } } }; pool_distinct_accounts?: number; compiled_conditions?: { named: boolean }; compiled_source_text?: string }>;
};
const M1 = fx.missions.msn_93ed6dea95edb303fd2b;
const M2 = fx.missions.msn_fefee20b5a4dfc1aafc2;
const M3 = fx.missions.msn_dd7c2e9c131b8783bf2e;
const AT1 = Date.parse(M1.created_at);
const AT3 = Date.parse(M3.created_at);
const catalog = loadTregCatalog();
const capabilityOf = (id: string) => catalog.byId.get(id)?.capability ?? null;
const searchCard = cardOf("anyapi.x.search.posts")!;
/** A username the CUSTOMER would type at the question (made up for the test: the real handle is never guessed by code or by this test). */
const HANDLE = "ExampleMinistry";
/** The follow-up of msn_dd7c as the conversation now plans it: the ended request's words with the change joined after the revision marker (chatTurn.ts). */
const M3_NOW = `${M2.request_text} ${REVISION_JOINER_AR} ${M3.request_text}`;

const tweet = (id: string, username: string, text: string, extra: Record<string, unknown> = {}) => ({ id, text, authorName: `name_${username}`, authorUsername: username, createdUtc: "2026-11-10T10:00:00.000Z", url: `https://x.com/${username}/status/${id}`, isReply: false, lang: "ar", likeCount: 1, replyCount: 0, retweetCount: 0, viewCount: 10, ...extra });
const pageOf = (items: unknown[]) => ({ output: { data: { items, nextCursor: null } } });

describe("P0 evidence: what production did (the recorded plans)", () => {
  it("msn_93ed searched all of X: no account in the query, and the one tweet read was another country's ministry", () => {
    expect(M1.engine_params!.query).toBe("\"الشائعات الصحية\" since:2026-08-13_21:00:00_UTC until:2026-11-14_22:00:00_UTC -filter:replies");
    expect(M1.engine_params!.query).not.toMatch(/from:/);
    expect(M1.compiled_conditions!.named).toBe(false);
  });
  it("msn_dd7c named the ministry but searched «الشائعات فقط» across all of X; its pool held 40 tweets of 38 accounts", () => {
    expect(M3.engine_params!.query).toBe("\"الشائعات فقط\" -filter:replies");
    expect(M3.compiled_conditions!.named).toBe(true);
    expect(M3.compiled_source_text).toBe("وزارة الصحة السعودية");
    expect(M3.pool_page!.output.data.items).toHaveLength(40);
    expect(M3.pool_distinct_accounts).toBe(38);
  });
});

describe("P0 reading: the account, the topic, the period and the count are kept", () => {
  it("msn_93ed: «على وزارة الصحة السعودية على إكس» names the account (it was dropped); topic, period and count are the customer's", () => {
    const ask = buildAsk(M1.request_text, null, AT1);
    expect(ask.platform).toBe("x");
    expect(ask.count).toBe(400);
    expect(ask.source).toEqual({ kind: "named", text: "وزارة الصحة السعودية" });
    expect(ask.topic.text).toBe("الشائعات الصحية");
    expect(ask.period).toMatchObject({ from: "2026-08-14", to: "2026-11-14" });
  });
  it("msn_fefee: the topic is the subject, not the whole sentence; the official page's name is the named source", () => {
    const ask = buildAsk(M2.request_text, null, Date.parse(M2.created_at));
    expect(ask.topic.text).toBe("الشائعات الصحية");
    expect(ask.source).toEqual({ kind: "named", text: "وزارة الصحة السعودية" });
    expect(ask.count).toBe(400);
  });
  it("msn_dd7c as production read it: «فقط» is never part of the search phrase", () => {
    const ask = buildAsk(M3.request_text, M3.answer_text, AT3);
    expect(ask.topic.text).toBe("الشائعات");
    expect(ask.source).toEqual({ kind: "named", text: "وزارة الصحة السعودية" });
  });
  it("msn_dd7c as the conversation now plans it: the change names the topic; the account, the platform and the count stay the request's", () => {
    const ask = buildAsk(M3_NOW, null, AT3);
    expect(ask.platform).toBe("x");
    expect(ask.count).toBe(400);
    expect(ask.topic.text).toBe("الشائعات");
    expect(ask.source).toEqual({ kind: "named", text: "وزارة الصحة السعودية" });
  });
  it("a revision keeps the request's period and count unless the change names them, and the latest change wins for what it names", () => {
    const base = "أريد ٤٠٠ تغريدة عن الشائعات الصحية من حساب @ExampleMinistry على إكس خلال آخر ٣ أشهر.";
    const kept = buildAsk(`${base} ${REVISION_JOINER_AR} طيب ابحث عن الشائعات فقط`, null, AT1);
    expect(kept).toMatchObject({ count: 400, topic: { text: "الشائعات" }, source: { kind: "named", text: "ExampleMinistry" }, period: { from: "2026-08-14", to: "2026-11-14" } });
    const changed = buildAsk(`${base} ${REVISION_JOINER_AR} خليها ١٠٠ تغريدة خلال آخر شهر`, null, AT1);
    expect(changed.count).toBe(100);
    expect(changed.period).toMatchObject({ from: "2026-10-14", to: "2026-11-14" });
    expect(changed.topic.text).toBe("الشائعات الصحية");
  });
  it("a username given in the words (a link or «@») is the account itself", () => {
    expect(buildAsk("أريد ٥٠ تغريدة عن الشائعات من https://x.com/ExampleMinistry", null, AT1).source).toEqual({ kind: "named", text: "ExampleMinistry" });
    expect(buildAsk("هات ٥٠ تغريدة من @ExampleMinistry على إكس عن الشائعات", null, AT1).source).toEqual({ kind: "named", text: "ExampleMinistry" });
  });
});

describe("P0 the X account condition is enforceable or the plan is not priced", () => {
  it("an account named only by its Arabic name is never priced (msn_dd7c's 40-row pool would have been priced as alternatives)", () => {
    const ask = buildAsk(M3_NOW, null, AT3);
    expect(xHandleOfAsk(ask)).toBeNull();
    const r = compilePlan({ ask, pool: { card: searchCard, params: parentInputs(searchCard, ask), pages: [{ callId: "call_0001", page: M3.pool_page }] }, exposure: () => undefined, capabilityOf });
    expect(r).toEqual({ ok: false, reason: "x_account_unverified" });
  });
  it("with the username the customer gave, the query carries `from:` and the account counts as carried", () => {
    const ask = { ...buildAsk(M1.request_text, null, AT1), source: { kind: "named" as const, text: HANDLE } };
    expect(parentInputs(searchCard, ask)).toEqual({ query: "\"الشائعات الصحية\" from:ExampleMinistry since:2026-08-13_21:00:00_UTC until:2026-11-14_22:00:00_UTC -filter:replies", queryType: "Latest", limit: 20 });
    expect(carriedBy(searchCard, ask).carried).toContain("source");
  });
  it("no topic: the account's own tweets are searched", () => {
    const ask = buildAsk("هات ٥٠ تغريدة من @ExampleMinistry على إكس", null, AT1);
    expect(parentInputs(searchCard, ask).query).toBe("from:ExampleMinistry -filter:replies");
  });
  it("the recorded msn_dd7c pool, scoped to the account: no tweet of the 38 other accounts is chosen, so nothing is priced", () => {
    const ask = { ...buildAsk(M3_NOW, null, AT3), source: { kind: "named" as const, text: HANDLE } };
    const r = compilePlan({ ask, pool: { card: searchCard, params: parentInputs(searchCard, ask), pages: [{ callId: "call_0001", page: M3.pool_page }] }, exposure: () => undefined, capabilityOf });
    expect(r.ok).toBe(false);
  });
  it("a mixed pool: only the account's own tweets are chosen; a fan account and a copied display name are not; the plan says the account and carries the exact filter", () => {
    const page = pageOf([
      tweet("1", HANDLE, "تحذير من الشائعات الصحية المتداولة"),
      tweet("2", "ExampleMinistry_fans", "الشائعات الصحية كثيرة"),
      { ...tweet("3", "someone_else", "الشائعات الصحية حول اللقاح"), authorName: "ExampleMinistry" },
      tweet("4", "examplemINISTRY", "لا صحة للشائعات الصحية"),
      ...M3.pool_page!.output.data.items,
    ]);
    const ask = { ...buildAsk(M1.request_text, null, AT1), source: { kind: "named" as const, text: HANDLE }, period: null };
    const r = compilePlan({ ask, pool: { card: searchCard, params: parentInputs(searchCard, ask), pages: [{ callId: "call_0001", page }] }, exposure: () => undefined, capabilityOf });
    if (!r.ok) throw new Error(r.reason);
    const stage = r.plan.stages[0];
    expect((stage.pinned_rows as Array<{ id: string }>).map((x) => x.id).sort()).toEqual(["1", "4"]);
    expect(stage.planned_rows).toBe(2);
    expect(stage.filters).toContainEqual({ kind: "account", field: "username", fields: ["username"], values: [HANDLE], exact: true });
    // the account is said before approval in the plan's note (as Instagram's account note: the username is the customer's own word)
    expect(r.plan.notes_ar).toContain(xAccountNoteAr(HANDLE));
    // the card says before approval that only 2 of the 400 asked were found (measurable: nothing is promised beyond it)
    expect(r.plan.notes_ar!.join(" ")).toMatch(/وجدنا في ما قرأناه ٢ فقط تناسب طلبك من ٤٠٠/);
    const view = customerPlanView(r.plan);
    for (const l of [view.summary_ar, ...(view.notes_ar ?? [])]) expect(checkCustomerText(l.replace(`@${HANDLE}`, "الحساب"), { maxChars: 600 }).issues, l).toEqual([]);
  });
  it("the per-row check: exact username only, case-insensitive", () => {
    const ask = { platform: "x" as const, topic: { text: null, relation: "none" as const }, source: { kind: "named" as const, text: HANDLE } };
    expect(parentEligible({ username: "exampleministry" }, ask)).toBe(true);
    expect(parentEligible({ username: "ExampleMinistry_fans" }, ask)).toBe(false);
    expect(parentEligible({ username: "", author: "ExampleMinistry" }, ask)).toBe(false);
    expect(xHandleMatches("@ExampleMinistry", "EXAMPLEMINISTRY")).toBe(true);
    expect(xHandleMatches("ExampleMinistry", "Example_Ministry")).toBe(false);
  });
});

describe("P0 the execution filter: every tweet the run reads is checked by its own username", () => {
  const exact: StageFilter = { kind: "account", field: "username", fields: ["username"], values: [HANDLE], exact: true };
  it("only the exact username passes; a fan account, a copied display name and a missing username are left out as «من مصدر لم تسمّه»", () => {
    const v = (row: Record<string, unknown>) => filterVerdict([exact], row, { textKey: "text", now: AT1 });
    expect(v({ username: "ExampleMinistry", author: "x" })).toBeNull();
    expect(v({ username: "@exampleministry" })).toBeNull();
    expect(v({ username: "ExampleMinistry_fans", author: "ExampleMinistry" })).toBe("filter_account");
    expect(v({ username: "other", author: "ExampleMinistry" })).toBe("filter_account");
    expect(v({ author: "ExampleMinistry" })).toBe("filter_account");
  });
  it("the stored plan keeps it exact (parse) and the display-name fields are never added (resolve)", () => {
    const parsed = parseFilters([exact], "tweets");
    expect(parsed.filters[0].exact).toBe(true);
    const fields = findFilterFields({ mappedKeys: ["id", "text", "author", "username"], columnKeys: ["text", "author", "username"] });
    const resolved = resolveFilters(parsed.filters, fields, "tweets");
    const account = resolved.filters.find((f) => f.kind === "account")!;
    expect(account.fields).toEqual(["username"]);
    expect(filterVerdict([account], { username: "x1", author: "ExampleMinistry" }, { textKey: "text", now: AT1 })).toBe("filter_account");
  });
  it("an account filter without `exact` behaves as before (other platforms' named sources)", () => {
    const loose: StageFilter = { kind: "account", field: "username", fields: ["username", "author"], values: ["الأهلي"] };
    expect(filterVerdict([loose], { username: "x", author: "النادي الأهلي" }, { textKey: "text", now: AT1 })).toBeNull();
  });
});

describe("P0 the question before pricing, and the customer's answer (planByCompiler, no paid call)", () => {
  const mk = (page: unknown) => {
    const store = createMemoryStore();
    const queries: string[] = [];
    let n = 0;
    const gateway = { async tregCall(input: { endpoint_id?: unknown; params?: unknown }) { n += 1; queries.push(String((input.params as { query?: string })?.query ?? "")); const id = `call_${String(n).padStart(4, "0")}`; await store.putFile("msn_t", RAW_PATH(id), JSON.stringify(page), "application/json"); const { reading } = buildShapeDigest(page, catalog.byId.get(String(input.endpoint_id))!); return { ok: true as const, call_id: id, http_status: 200, rows_in_page: reading.rows.length, has_more: null, next_cursor: null }; } };
    return { store, gateway, queries };
  };
  const mission = (request_text: string, answer_text: string | null = null) => ({ id: "msn_t", request_text, answer_text, created_at: M2.created_at });
  for (const [label, text] of [["msn_93ed", M1.request_text], ["msn_fefee", M2.request_text], ["msn_dd7c (now)", M3_NOW]] as const) {
    it(`${label}: the username is asked BEFORE anything is read, held or priced`, async () => {
      const a = mk(M3.pool_page);
      const r = await planByCompiler({ mission: mission(text), gateway: a.gateway as never, store: a.store, catalog, nowMs: AT3 });
      expect(r.kind).toBe("question");
      if (r.kind !== "question") return;
      expect(r.why).toBe("x_account");
      expect(r.question).toBe(xAccountQuestionAr("وزارة الصحة السعودية"));
      expect(r.question).toMatch(/لا نخمّن اسم المستخدم/);
      expect(r.options).toEqual([X_ACCOUNT_OPTIONS_AR.all, X_ACCOUNT_OPTIONS_AR.cancel]);
      expect(a.queries).toEqual([]);
      expect(r.reads).toEqual({ pool: 0, exposure: 0 });
    });
  }
  it("the customer gives the username: every search carries `from:`, only the account's tweets are planned, and the plan says so", async () => {
    const a = mk(pageOf([tweet("11", HANDLE, "تحذير من الشائعات الصحية"), tweet("12", "other_account", "الشائعات الصحية")]));
    const r = await planByCompiler({ mission: mission(M1.request_text, "@ExampleMinistry"), gateway: a.gateway as never, store: a.store, catalog, nowMs: AT1, choices: { xAccount: HANDLE }, answerIsChoice: true });
    if (r.kind !== "plan") throw new Error(`${r.kind} ${"reason" in r ? r.reason : ""}`);
    expect(a.queries.length).toBeGreaterThan(0);
    for (const q of a.queries) expect(q).toMatch(/from:ExampleMinistry/);
    expect((r.plan.stages[0].pinned_rows as Array<{ id: string }>).map((x) => x.id)).toEqual(["11"]);
    expect(r.plan.notes_ar!.join(" ")).toMatch(/النتائج من حساب «@ExampleMinistry» وحده/);
  });
  it("the customer explicitly chooses all of X: no account in the query, and the plan says the results are not that account's", async () => {
    const a = mk(M3.pool_page);
    const r = await planByCompiler({ mission: mission(M1.request_text, X_ACCOUNT_OPTIONS_AR.all), gateway: a.gateway as never, store: a.store, catalog, nowMs: AT1, choices: { xAccountAll: true, xAccountName: "وزارة الصحة السعودية" }, answerIsChoice: true });
    if (r.kind !== "plan") throw new Error(r.kind);
    for (const q of a.queries) expect(q).not.toMatch(/from:/);
    expect(r.plan.notes_ar!.join(" ")).toMatch(/غير مقيّدة بحساب «وزارة الصحة السعودية»/);
  });
  it("no usable answer: the request ends honestly, nothing read", async () => {
    const a = mk(M3.pool_page);
    const r = await planByCompiler({ mission: mission(M1.request_text, "حساب الوزارة"), gateway: a.gateway as never, store: a.store, catalog, nowMs: AT1, choices: { xAccountDeclined: true }, answerIsChoice: true });
    expect(r).toMatchObject({ kind: "cannot", reason: "x_account_missing" });
    expect(a.queries).toEqual([]);
    expect(X_ACCOUNT_DECLINED_AR).toMatch(/لم يُخصم منك شيء/);
    expect(X_ACCOUNT_DECLINED_AR).toMatch(/لا نخمّنه/);
  });
});

describe("P0 the answer and the name are read by code (xAccount.ts)", () => {
  it("answers", () => {
    expect(xAccountAnswerOf("@ExampleMinistry")).toEqual({ kind: "handle", handle: "ExampleMinistry" });
    expect(xAccountAnswerOf("https://x.com/ExampleMinistry")).toEqual({ kind: "handle", handle: "ExampleMinistry" });
    expect(xAccountAnswerOf("https://twitter.com/ExampleMinistry/status/123")).toEqual({ kind: "handle", handle: "ExampleMinistry" });
    expect(xAccountAnswerOf("اسم الحساب المطلوب: ExampleMinistry")).toEqual({ kind: "handle", handle: "ExampleMinistry" });
    expect(xAccountAnswerOf("ExampleMinistry")).toEqual({ kind: "handle", handle: "ExampleMinistry" });
    expect(xAccountAnswerOf(X_ACCOUNT_OPTIONS_AR.all)).toEqual({ kind: "all" });
    expect(xAccountAnswerOf(X_ACCOUNT_OPTIONS_AR.cancel)).toEqual({ kind: "cancel" });
    expect(xAccountAnswerOf("وزارة الصحة السعودية")).toBeNull();
    expect(xAccountAnswerOf("https://x.com/search")).toBeNull();
    expect(xAccountAnswerOf("someone@example.com")).toBeNull();
  });
  it("names and usernames", () => {
    expect(xAccountMentionOf("عبر الصفحة الرسمية لوزارة الصحة السعودية أو أي تصحيح")).toBe("وزارة الصحة السعودية");
    expect(xAccountMentionOf("تغريدات من حساب هيئة الغذاء والدواء فقط")).toBe("هيئة الغذاء والدواء");
    expect(xAccountMentionOf("تغريدات عن القهوة في مصر")).toBeNull();
    expect(xHandleIn("راسل someone@example.com")).toBeNull();
    expect(xHandleOfSource("وزارة الصحة السعودية")).toBeNull();
    expect(xHandleOfSource("@ExampleMinistry")).toBe("ExampleMinistry");
  });
});

describe("P0 the conversation: a follow-up of an ended request keeps that request", () => {
  it("«طيب ابحث عن الشائعات فقط» is a follow-up; a request that names a platform stands on its own", () => {
    expect(isFollowUpOfEndedRequest(M3.request_text)).toBe(true);
    expect(isFollowUpOfEndedRequest("طيب خليها آخر ٥ سنين")).toBe(true);
    expect(isFollowUpOfEndedRequest(M2.request_text)).toBe(false);
    expect(isFollowUpOfEndedRequest("عايز ١٠٠ فيديو من تيك توك عن القهوة")).toBe(false);
    expect(isFollowUpOfEndedRequest("عايز داتا عن السياحة في مصر")).toBe(false);
  });
});

describe("P0 the outcome is truthful", () => {
  it("«the source gave no more» speaks of the plan's search, never of the customer's whole request", () => {
    expect(shortfallClauseAr("source_exhausted", { pending: 0, stop: null })).toBe("لأن المصدر لم يعد يعطي نتائج أخرى للبحث المعتمد في خطتك");
    expect(shortfallFromStopAr("source_exhausted", { pending: 0, stop: null })).not.toMatch(/لهذا الطلب/);
  });
  it("msn_dd7c: 79 delivered, none the named source's: the customer reads it is partial and not the account's", () => {
    const line = namedSourceTruthAr({ name: "وزارة الصحة السعودية", delivered: 79, notFromSource: 79 })!;
    expect(line).toMatch(/لم يثبت أن أيًا مما سُلّم من «وزارة الصحة السعودية»/);
    expect(line).toMatch(/تسليم جزئي/);
    expect(line).not.toMatch(/[0-9٠-٩]/);
    expect(namedSourceTruthAr({ name: "x", delivered: 10, notFromSource: 0 })).toBeNull();
    expect(namedSourceTruthAr({ name: "x", delivered: 10, notFromSource: 3 })).toMatch(/بعض ما سُلّم/);
  });
});

describe("P0 unrelated requests are unchanged", () => {
  it("an X search with no account keeps its query exactly (no `from:`)", () => {
    const ask = buildAsk("هات ٢٠ تغريدة على X فيها «العاصمة الإدارية» بالعربي في شهر أكتوبر ٢٠٢٦", null, Date.parse("2026-11-03T07:13:38Z"));
    expect(ask.source.kind).toBe("none");
    expect(parentInputs(searchCard, ask).query).toBe("\"العاصمة الإدارية\" lang:ar since:2026-09-30_21:00:00_UTC until:2026-10-31_22:00:00_UTC -filter:replies");
  });
  it("the institution reading is X only: the other four platforms read a ministry in the words as before", () => {
    for (const p of ["تيك توك", "فيسبوك", "يوتيوب", "انستجرام"]) {
      const c = buildRequestContract(`عايز ٢٠ منشور على ${p} عن الشائعات الصحية على وزارة الصحة`);
      const ask = buildAsk(`عايز ٢٠ منشور على ${p} عن الشائعات الصحية على وزارة الصحة`, null, AT1);
      expect(ask.source.kind === "named" ? ask.source.text : null).toBe(c.source.named ? c.source.text : null);
    }
  });
});
