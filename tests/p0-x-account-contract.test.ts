import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadTregCatalog } from "../src/lib/treg/catalog";
import { createMemoryStore } from "../agent/src/memoryStore";
import { planByCompiler } from "../agent/src/compiled";
import { RAW_PATH } from "../agent/src/gateway";
import { namedSourceTruthAr, shortfallClauseAr, shortfallFromStopAr } from "../agent/src/finalize";
import { buildShapeDigest } from "../src/lib/modelPlanner/digest";
import { buildAsk } from "../src/lib/agentMission/foundation/ask";
import { carriedBy, carryOf, compilePlan, parentEligible, parentInputs } from "../src/lib/agentMission/foundation/compilePlan";
import { cardOf } from "../src/lib/agentMission/foundation/toolCards";
import { filterVerdict, parseFilters, resolveFilters, findFilterFields, type StageFilter } from "../src/lib/agentMission/filters";
import { buildRequestContract } from "../src/lib/agentMission/requestContract";
import { REVISION_JOINER_AR } from "../src/lib/agentMission/revisionText";
import { isFollowUpOfEndedRequest } from "../src/lib/agentMission/chatTurn";
import { parseBrief, validateBrief } from "../src/lib/agentMission/researchBrief";
import { customerPlanView } from "../src/lib/agentMission/plan";
import { checkCustomerText } from "../src/lib/agentMission/text";
import { SOURCE_DECLINED_AR, SOURCE_OPTIONS_AR, rowIsBy, sourceAnswerOf, sourceIdIn, sourceIdOf, sourceOperatorNoteAr } from "../src/lib/agentMission/foundation/sourceScope";

/**
 * P0, 14 NOV 2026: CUSTOMER DELIVERY FAILURE (recorded production evidence, zero paid calls).
 * The customer asked for 400 real X posts of the Saudi Ministry of Health's official account about health rumors. Three missions:
 *   msn_93ed6dea95edb303fd2b: «… على وزارة الصحة السعودية على إكس خلال آخر ٣ أشهر»: the account was not read at all; all of X was searched for «الشائعات الصحية»; 1 tweet delivered (the Iraqi Ministry of Interior's), 1 point charged, «completed»;
 *   msn_fefee20b5a4dfc1aafc2: «… عبر الصفحة الرسمية لوزارة الصحة السعودية أو أي تصحيح لشائعة صحية على إكس»: the whole sentence was the exact search phrase; nothing found, «unserved»;
 *   msn_dd7c2e9c131b8783bf2e: «طيب ابحث عن الشائعات فقط» in the same conversation became a NEW request of its own words; the account was read as a name but never written into the search; «الشائعات فقط» searched
 *     across all of X; 79 tweets of 38 other accounts delivered, 40 points charged, «completed», with 158 delivery-contract completions of «غير مطابق» marks that the customer never read.
 * The fixture is those missions' recorded plans (their pinned pool rows rebuilt in the provider's page shape, anonymised) and their recorded outcomes.
 * THE FIX IS GENERAL (owner, 14 Nov 2026: no rule per word, per service or per platform): the understanding layer (the research brief) reads the source, the topic and the turns; code enforces ONE source rule on every platform from the
 * cards' own data (sourceScope.ts): a named source is carried by the service (its input, an evidence lookup, or the search's documented operator with an exact author check of every row) or asked once before pricing, never guessed.
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
/** msn_93ed's words as the understanding layer consolidated them in the live evaluation of 14 Nov 2026 (P0-1, the real model's brief): the institution «على وزارة الصحة السعودية» is read as the source by the MODEL, not by a code word rule. */
const M1_BRIEF = "جمع ٤٠٠ تغريدة على إكس من حساب وزارة الصحة السعودية عن الشائعات الصحية خلال آخر ٣ أشهر";

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


describe("P0 reading (code fallback): what the customer named is kept; a revision's latest change wins for what it names", () => {
  it("msn_dd7c as the conversation now plans it: the account, the platform and the count stay the request's; the change's topic is read", () => {
    const ask = buildAsk(M3_NOW, null, AT3);
    expect(ask.platform).toBe("x");
    expect(ask.count).toBe(400);
    expect(ask.topic.text).toBe("الشائعات فقط");
    // (the code reader keeps the customer's words; the understanding layer writes the topic as the subject alone: see the brief tests below)
  });
  it("the latest change wins for the count and the period; what it does not name stays", () => {
    const base = "أريد ٤٠٠ تغريدة عن الشائعات الصحية من حساب @ExampleMinistry على إكس خلال آخر ٣ أشهر.";
    const kept = buildAsk(`${base} ${REVISION_JOINER_AR} طيب ابحث عن الشائعات`, null, AT1);
    expect(kept).toMatchObject({ count: 400, topic: { text: "الشائعات" }, source: { kind: "named", text: "ExampleMinistry" }, period: { from: "2026-08-14", to: "2026-11-14" } });
    const changed = buildAsk(`${base} ${REVISION_JOINER_AR} خليها ١٠٠ تغريدة خلال آخر شهر`, null, AT1);
    expect(changed.count).toBe(100);
    expect(changed.period).toMatchObject({ from: "2026-10-14", to: "2026-11-14" });
    expect(changed.topic.text).toBe("الشائعات الصحية");
  });
  it("a period written with a number WORD is the same period (the understanding layer wrote «آخر ثلاثة أشهر» in the live evaluation)", () => {
    expect(buildAsk("جمع ٤٠٠ تغريدة على إكس من حساب وزارة الصحة السعودية عن الشائعات الصحية خلال آخر ثلاثة أشهر", null, AT1).period).toEqual(buildAsk(M1.request_text, null, AT1).period);
  });
});

describe("P0 the understanding layer (research brief): the source is read, never invented, never lost", () => {
  // the briefs below are the REAL model's answers of the live evaluation of 14 Nov 2026 (evals/live-intelligence P0-1, P0-2, P0-4), and two corrupted on purpose
  const brief = (b: Record<string, unknown>) => { const p = parseBrief({ status: "ready", platforms: ["x"], content: ["tweets"], count: null, topic: "", period: "", country: "", language: "", ...b }); if (!p.ok) throw new Error(p.issue); return p.brief; };
  const ctx = (turns: string[]) => ({ customerTurns: turns, prior: null, assistantQuestion: null });
  it("msn_93ed's words: the ministry is the source, the topic is the subject, the period and count kept", () => {
    const b = brief({ request: "جمع ٤٠٠ تغريدة على إكس من حساب وزارة الصحة السعودية عن الشائعات الصحية خلال آخر ٣ أشهر", count: 400, topic: "الشائعات الصحية", period: "آخر ٣ أشهر", source: "وزارة الصحة السعودية" });
    const v = validateBrief(b, ctx([M1.request_text]));
    if (!v.ok) throw new Error(v.reason);
    const ask = buildAsk(v.brief.request, null, AT1);
    expect(ask).toMatchObject({ platform: "x", count: 400, source: { kind: "named", text: "وزارة الصحة السعودية" }, topic: { text: "الشائعات الصحية" }, period: { from: "2026-08-14", to: "2026-11-14" } });
  });
  it("msn_fefee's words («لوزارة …», an attached letter): the source is the customer's own", () => {
    const b = brief({ request: "جمع ٤٠٠ تغريدة على إكس عن الشائعات الصحية من حساب وزارة الصحة السعودية، أو أي تصحيح لشائعة صحية منشور على إكس.", count: 400, topic: "الشائعات الصحية", source: "وزارة الصحة السعودية" });
    const v = validateBrief(b, ctx([M2.request_text]));
    expect(v.ok).toBe(true);
  });
  it("a source the customer never wrote is rejected (never invented)", () => {
    const b = brief({ request: "جمع ١٠٠ تغريدة على إكس من حساب @SomeGuess عن كأس العالم", count: 100, topic: "كأس العالم", source: "@SomeGuess" });
    expect(validateBrief(b, ctx(["عايز ١٠٠ تغريدة عن كأس العالم على إكس"]))).toMatchObject({ ok: false, reason: "source_not_written" });
  });
  it("a source the consolidated request would lose is rejected (never dropped)", () => {
    const b = brief({ request: "جمع ٤٠٠ تغريدة على إكس عن الشائعات الصحية", count: 400, topic: "الشائعات الصحية", source: "وزارة الصحة السعودية" });
    expect(validateBrief(b, ctx([M1.request_text]))).toMatchObject({ ok: false, reason: "source_dropped" });
  });
});

describe("P0 THE GENERAL SOURCE RULE: carried by the service, or asked before pricing", () => {
  it("msn_dd7c's recorded 40-row pool with the ministry named by its name: never priced", () => {
    const ask = buildAsk(M3_NOW, null, AT3);
    expect(carryOf(searchCard, ask)).toBeNull();
    const r = compilePlan({ ask, pool: { card: searchCard, params: parentInputs(searchCard, ask), pages: [{ callId: "call_0001", page: M3.pool_page }] }, exposure: () => undefined, capabilityOf });
    expect(r).toEqual({ ok: false, reason: "source_unenforceable" });
  });
  it("with the identifier the customer gave, the search carries it by the card's documented operator", () => {
    const ask = { ...buildAsk(M1.request_text, null, AT1), source: { kind: "named" as const, text: HANDLE } };
    expect(carryOf(searchCard, ask)).toBe("operator");
    expect(parentInputs(searchCard, ask)).toEqual({ query: "\"الشائعات الصحية\" from:ExampleMinistry since:2026-08-13_21:00:00_UTC until:2026-11-14_22:00:00_UTC -filter:replies", queryType: "Latest", limit: 20 });
    expect(carriedBy(searchCard, ask).carried).toContain("source");
  });
  it("the recorded msn_dd7c pool, scoped to an identifier: no row of the 38 other accounts is chosen, so nothing is priced", () => {
    const ask = { ...buildAsk(M3_NOW, null, AT3), source: { kind: "named" as const, text: HANDLE } };
    expect(compilePlan({ ask, pool: { card: searchCard, params: parentInputs(searchCard, ask), pages: [{ callId: "call_0001", page: M3.pool_page }] }, exposure: () => undefined, capabilityOf }).ok).toBe(false);
  });
  it("a mixed pool: only the source's own rows; a fan account and a copied display name are not; the exact filter goes to execution; the card says it", () => {
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
    expect(stage.filters).toContainEqual({ kind: "account", field: "username", fields: ["username"], values: [HANDLE], exact: true });
    expect(r.plan.notes_ar).toContain(sourceOperatorNoteAr(HANDLE));
    expect(r.plan.notes_ar!.join(" ")).toMatch(/وجدنا في ما قرأناه ٢ فقط تناسب طلبك من ٤٠٠/);
    const view = customerPlanView(r.plan);
    for (const l of [view.summary_ar, ...(view.notes_ar ?? [])]) expect(checkCustomerText(l.replace(`@${HANDLE}`, "الحساب"), { maxChars: 600 }).issues, l).toEqual([]);
  });
  it("the exact author check (any platform's row): username, author link or channel id; never a display name or «contains»", () => {
    expect(rowIsBy({ username: "exampleministry" }, "@ExampleMinistry")).toBe(true);
    expect(rowIsBy({ author_url: "https://www.facebook.com/ExampleMinistry/" }, "ExampleMinistry")).toBe(true);
    expect(rowIsBy({ username: "ExampleMinistry_fans" }, "ExampleMinistry")).toBe(false);
    expect(rowIsBy({ author: "ExampleMinistry" }, "ExampleMinistry")).toBe(false);
    const ask = { platform: "x" as const, topic: { text: null, relation: "none" as const }, source: { kind: "named" as const, text: HANDLE } };
    expect(parentEligible({ username: "Example_Ministry" }, ask, { authorId: HANDLE })).toBe(false);
  });
});

describe("P0 the execution filter: every row a search reads is checked by its own author", () => {
  const exact: StageFilter = { kind: "account", field: "username", fields: ["username"], values: [HANDLE], exact: true };
  it("only the exact identifier passes", () => {
    const v = (row: Record<string, unknown>) => filterVerdict([exact], row, { textKey: "text", now: AT1 });
    expect(v({ username: "ExampleMinistry" })).toBeNull();
    expect(v({ username: "@exampleministry" })).toBeNull();
    expect(v({ username: "ExampleMinistry_fans", author: "ExampleMinistry" })).toBe("filter_account");
    expect(v({ author: "ExampleMinistry" })).toBe("filter_account");
  });
  it("the stored plan keeps it exact and never widens it to display names", () => {
    const parsed = parseFilters([exact], "tweets");
    expect(parsed.filters[0].exact).toBe(true);
    const resolved = resolveFilters(parsed.filters, findFilterFields({ mappedKeys: ["id", "text", "author", "username"], columnKeys: ["text", "author", "username"] }), "tweets");
    expect(resolved.filters.find((f) => f.kind === "account")!.fields).toEqual(["username"]);
  });
  it("an account filter without `exact` behaves as before", () => {
    const loose: StageFilter = { kind: "account", field: "username", fields: ["username", "author"], values: ["الأهلي"] };
    expect(filterVerdict([loose], { username: "x", author: "النادي الأهلي" }, { textKey: "text", now: AT1 })).toBeNull();
  });
});

describe("P0 the same rule on the five platforms (planByCompiler, no paid call)", () => {
  const mk = (page: unknown) => {
    const store = createMemoryStore();
    const queries: string[] = [];
    let n = 0;
    const gateway = { async tregCall(input: { endpoint_id?: unknown; params?: unknown }) { n += 1; queries.push(JSON.stringify(input.params ?? {})); const id = `call_${String(n).padStart(4, "0")}`; await store.putFile("msn_t", RAW_PATH(id), JSON.stringify(page), "application/json"); const { reading } = buildShapeDigest(page, catalog.byId.get(String(input.endpoint_id))!); return { ok: true as const, call_id: id, http_status: 200, rows_in_page: reading.rows.length, has_more: null, next_cursor: null }; } };
    return { store, gateway, queries };
  };
  const mission = (request_text: string, answer_text: string | null = null) => ({ id: "msn_t", request_text, answer_text, created_at: M2.created_at });
  const plan = (text: string, extra: Record<string, unknown> = {}, page: unknown = M3.pool_page) => { const a = mk(page); return planByCompiler({ mission: mission(text, (extra.answer as string) ?? null), gateway: a.gateway as never, store: a.store, catalog, nowMs: AT3, ...extra }).then((r) => ({ r, a })); };
  for (const [label, text] of [["X, msn_93ed (as the understanding layer wrote it)", M1_BRIEF], ["X, msn_fefee", M2.request_text], ["X, msn_dd7c (now)", M3_NOW]] as const) {
    it(`${label}: asked for the identifier before anything is read, held or priced`, async () => {
      const { r, a } = await plan(text);
      if (r.kind !== "question") throw new Error(r.kind);
      expect(r.why).toBe("source_id");
      expect(r.question).toMatch(/لا نخمّنه/);
      expect(r.options).toEqual([SOURCE_OPTIONS_AR.widen, SOURCE_OPTIONS_AR.cancel]);
      expect(a.queries).toEqual([]);
    });
  }
  it("Instagram, an account named by its name: asked for the username (it was refused as «no tool» before)", async () => {
    const { r, a } = await plan("عايز ٢٠ منشور انستجرام من حساب وزارة الصحة عن التطعيمات");
    expect(r).toMatchObject({ kind: "question", why: "source_id" });
    expect(a.queries).toEqual([]);
  });
  it("Facebook, a page named by its name with a topic: asked for the page link (the keyword search cannot restrict to a page)", async () => {
    const { r, a } = await plan("عايز ٢٠ منشور فيسبوك من صفحة وزارة الصحة عن التطعيمات");
    expect(r).toMatchObject({ kind: "question", why: "source_id" });
    expect(a.queries).toEqual([]);
  });
  it("TikTok, an account named: no TikTok service can restrict to an account, so the question says so and offers to search without it", async () => {
    const { r, a } = await plan("عايز ٢٠ فيديو تيك توك من حساب وزارة الصحة عن التطعيمات");
    if (r.kind !== "question") throw new Error(r.kind);
    expect(r.why).toBe("source_id");
    expect(r.question).toMatch(/لا تستطيع تقييد البحث بحساب/);
    expect(a.queries).toEqual([]);
  });
  it("YouTube, a channel named: the channel lookup carries it (no source question)", async () => {
    const { r } = await plan("عايز ٢٠ فيديو يوتيوب من قناة وزارة الصحة عن التطعيمات");
    expect(r.kind === "question" ? r.why : null).not.toBe("source_id");
  });
  it("the customer gives the identifier: every search carries the operator and only the source's rows are planned", async () => {
    const { r, a } = await plan(M1_BRIEF, { answer: "@ExampleMinistry", choices: { sourceId: HANDLE }, answerIsChoice: true }, pageOf([tweet("11", HANDLE, "تحذير من الشائعات الصحية"), tweet("12", "other_account", "الشائعات الصحية")]));
    if (r.kind !== "plan") throw new Error(r.kind);
    expect(a.queries.length).toBeGreaterThan(0);
    for (const q of a.queries) expect(q).toMatch(/from:ExampleMinistry/);
    expect((r.plan.stages[0].pinned_rows as Array<{ id: string }>).map((x) => x.id)).toEqual(["11"]);
  });
  it("the customer explicitly chooses to search without the source: no operator, and the plan says the results are not the source's", async () => {
    const { r, a } = await plan(M1_BRIEF, { answer: SOURCE_OPTIONS_AR.widen, choices: { sourceWiden: true, sourceName: "وزارة الصحة السعودية" }, answerIsChoice: true });
    if (r.kind !== "plan") throw new Error(r.kind);
    for (const q of a.queries) expect(q).not.toMatch(/from:/);
    expect(r.plan.notes_ar!.join(" ")).toMatch(/غير مقيّدة بـ«وزارة الصحة السعودية»/);
  });
  it("no usable answer: the request ends honestly, nothing read", async () => {
    const { r, a } = await plan(M1_BRIEF, { answer: "حساب الوزارة", choices: { sourceDeclined: true }, answerIsChoice: true });
    expect(r).toMatchObject({ kind: "cannot", reason: "source_missing" });
    expect(a.queries).toEqual([]);
    expect(SOURCE_DECLINED_AR).toMatch(/لم يُخصم منك شيء/);
  });
});

describe("P0 the answer is read by code, the same on every platform", () => {
  it("identifiers, the two options, and nothing else", () => {
    expect(sourceAnswerOf("@ExampleMinistry")).toEqual({ kind: "id", id: "ExampleMinistry" });
    expect(sourceAnswerOf("https://x.com/ExampleMinistry")).toEqual({ kind: "id", id: "ExampleMinistry" });
    expect(sourceAnswerOf("https://www.instagram.com/example.page/")).toEqual({ kind: "id", id: "example.page" });
    expect(sourceAnswerOf("https://www.youtube.com/@ExampleChannel")).toEqual({ kind: "id", id: "ExampleChannel" });
    expect(sourceAnswerOf("ExampleMinistry")).toEqual({ kind: "id", id: "ExampleMinistry" });
    expect(sourceAnswerOf(SOURCE_OPTIONS_AR.widen)).toEqual({ kind: "widen" });
    expect(sourceAnswerOf(SOURCE_OPTIONS_AR.cancel)).toEqual({ kind: "cancel" });
    expect(sourceAnswerOf("وزارة الصحة السعودية")).toBeNull();
    expect(sourceIdIn("راسل someone@example.com")).toBeNull();
    expect(sourceIdOf("وزارة الصحة السعودية")).toBeNull();
  });
});

describe("P0 the conversation: a follow-up of an ended request keeps that request (structural, no word list)", () => {
  it("a message that names no platform and no kind of data is a follow-up; one that does stands on its own", () => {
    expect(isFollowUpOfEndedRequest(M3.request_text)).toBe(true);
    expect(isFollowUpOfEndedRequest("خليها آخر ٥ سنين")).toBe(true);
    expect(isFollowUpOfEndedRequest(M2.request_text)).toBe(false);
    expect(isFollowUpOfEndedRequest("عايز ١٠٠ فيديو من تيك توك عن القهوة")).toBe(false);
    expect(isFollowUpOfEndedRequest("عايز شركات برمجة في مصر")).toBe(false);
  });
});

describe("P0 the outcome is truthful", () => {
  it("«the source gave no more» speaks of the plan's search, never of the customer's whole request", () => {
    expect(shortfallClauseAr("source_exhausted", { pending: 0, stop: null })).toBe("لأن المصدر لم يعد يعطي نتائج أخرى للبحث المعتمد في خطتك");
    expect(shortfallFromStopAr("source_exhausted", { pending: 0, stop: null })).not.toMatch(/لهذا الطلب/);
  });
  it("msn_dd7c: 79 delivered, none the named source's: the customer reads it is partial and not the source's", () => {
    const line = namedSourceTruthAr({ source: "وزارة الصحة السعودية", delivered: 79, notFromSource: 79 })!;
    expect(line).toMatch(/لم يثبت أن أيًا مما سُلّم من «وزارة الصحة السعودية»/);
    expect(line).toMatch(/تسليم جزئي/);
    expect(line).not.toMatch(/[0-9٠-٩]/);
    expect(namedSourceTruthAr({ source: "x", delivered: 10, notFromSource: 0 })).toBeNull();
    expect(namedSourceTruthAr({ source: "x", delivered: 10, notFromSource: 3 })).toMatch(/بعض ما سُلّم/);
  });
});

describe("P0 unrelated requests are unchanged", () => {
  it("an X search with no source keeps its query exactly", () => {
    const ask = buildAsk("هات ٢٠ تغريدة على X فيها «العاصمة الإدارية» بالعربي في شهر أكتوبر ٢٠٢٦", null, Date.parse("2026-11-03T07:13:38Z"));
    expect(ask.source.kind).toBe("none");
    expect(parentInputs(searchCard, ask).query).toBe("\"العاصمة الإدارية\" lang:ar since:2026-09-30_21:00:00_UTC until:2026-10-31_22:00:00_UTC -filter:replies");
  });
  it("a TikTok topic search is untouched", () => {
    const tt = buildAsk("هات فيديوهين تيك توك بالعربي عن الذكاء الاصطناعي من مصر", null, AT1);
    expect(JSON.stringify(parentInputs(cardOf("tikhub.tiktok.search.videos")!, tt))).not.toMatch(/from:/);
  });
});
