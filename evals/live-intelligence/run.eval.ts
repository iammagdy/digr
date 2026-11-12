import { describe, expect, it, vi } from "vitest";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createMemoryDb } from "../../tests/helpers/memoryDb";
import { REPLAY_USER } from "../../tests/helpers/agentReplay";
import { fakeRecorder, NOT_ADMIN, tregResult } from "../../tests/helpers/agentHarness";
import { fakeContextDev, mapsPlace, mapsReviews } from "../../tests/helpers/fakeContextDev";
import { agentChatTurn, AGENT_PRESS_APPROVE_AR, CHAT_RESEARCH_BRIEF_FLAG_KEY } from "../../src/lib/agentMission/chatTurn";
import { callClaudeChatWith, setChatModelForTesting, type ChatModelResult } from "../../src/lib/agentMission/chatModel";
import { parseModelAnswer } from "../../src/lib/agentMission/conversationModel";
import { parseBrief, type ResearchBrief } from "../../src/lib/agentMission/researchBrief";
import { buildCapabilityRegistry, CAPABILITY_DISCOVERY_FLAG_KEY, discoverCapabilities, researchNeedOf } from "../../src/lib/agentMission/capabilities";
import { loadTregCatalog } from "../../src/lib/treg/catalog";
import { blockedEndpointReason } from "../../src/lib/treg/blockList";
import { policyVerdict } from "../../src/lib/treg/dataPolicy";
import { createFakeDriver } from "../../agent/src/fakeDriver";
import { createMemoryStore, newMission } from "../../agent/src/memoryStore";
import { runPlanning, type RunnerDeps } from "../../agent/src/runMission";
import { setModelPlanningForTests } from "../../src/lib/agentMission/testSeam";
import { createSpendingGuard, preflight, AUTHORIZED_TOTAL_ATTEMPTS, AUTHORIZED_TOTAL_USD, BUDGET_DIR_ENV, EVAL_MODEL, KEY_ENV, MAX_PAID_ATTEMPTS, MAX_USD, PLANNER_MAX_OUTPUT_TOKENS, type LedgerEntry } from "./budget";
import { openCumulativeBudget } from "./cumulative";
import { createEvalPlannerDriver, type PlannerTurnRecord } from "./plannerDriver";
import { ALL_CASES, type EvalCase, type Outcome } from "./cases";

/**
 * THE LIVE INTELLIGENCE EVALUATION (docs/LIVE-INTELLIGENCE-EVAL.md). Runs ONLY with `npx vitest run -c vitest.live-eval.config.ts` and an approved environment (`preflight`): the default test config never includes this directory.
 *
 *   REAL MODEL, CHAT (paid, guarded by budget.ts + cumulative.ts): the product's own chat turn (`agentChatTurn`: code guards, the ONE chat-model call through the product's transport `callClaudeChatWith`, brief validation, exact-intent
 *   checks, capability discovery, mission creation) over an IN-MEMORY database with synthetic requests. The research-brief and capability-discovery switches are seeded in memory for the replay user only; semantic_normalization_v1 has
 *   no row (OFF).
 *
 *   REAL MODEL, PLANNER (paid, LIVE_EVAL_PLANNER=1): the worker's own `runPlanning` of the missions the chat created, its planning model reached through the guarded Messages-API driver (plannerDriver.ts: production's prompt, tools and
 *   handlers; only the transport differs from the Agent SDK). Every PROVIDER answer is SYNTHETIC (TREG: generic rows; the web: the documented fake Context.dev shapes), the network is blocked except the Anthropic API, nothing executes
 *   and nothing is held: planning ends at a plan, a question or a refusal.
 *
 * Outputs (ledger JSONL, transcripts, results) go to LIVE_EVAL_OUT_DIR; the cumulative budget lives in LIVE_EVAL_BUDGET_DIR. Both must be OUTSIDE the repository.
 * Selection: LIVE_EVAL_SET=original|expanded|all (default all), or LIVE_EVAL_CASES=E1,J1,...
 * Caps: LIVE_EVAL_MAX_ATTEMPTS / LIVE_EVAL_MAX_USD per run; the cumulative ceiling is the state file's (created once with LIVE_EVAL_BUDGET_INIT=<usd>, never above the owner's authorization).
 */
const REAL_FETCH = globalThis.fetch;
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const USER = REPLAY_USER;
const catalog = loadTregCatalog();
const allowed = (id: string) => !blockedEndpointReason(id) && policyVerdict(id, NOT_ADMIN).allowed;
const PROVIDER_NAMES = /claude|anthropic|haiku|sonnet|opus|\btreg\b|firecrawl|context\.?dev|openai|\bgpt\b|\bllm\b/i;
/** The provider family of a stage's source (evaluation output only; never shown to a customer). */
const providerFamily = (id: string): "firecrawl" | "contextdev" | "treg" | "unknown" => (id.startsWith("firecrawl.") ? "firecrawl" : id.startsWith("contextdev.") ? "contextdev" : id && catalog.byId.has(id) ? "treg" : "unknown");
const outside = (p: string) => { const r = path.resolve(p); return r !== REPO && !r.startsWith(REPO + path.sep); };

interface ModelCallRecord { caseId: string; turn: number; ok: boolean; failure?: string; text?: string; truncated?: boolean; usage?: { inputTokens: number; outputTokens: number }; latencyMs: number }
interface TurnRecord {
  turn: number; message: string; outcome: Outcome; ok: boolean; contentAr: string; extraContents: string[]; log: Record<string, unknown> | null; modelCalls: number;
  jsonStrict: boolean | null; jsonProduct: boolean | null; briefSchemaOk: boolean | null; briefIssue: string | null; briefStatus: string | null; objectivesBeside: boolean; arabicReply: boolean; providerNameLeak: boolean; truncated: boolean;
}

function world() {
  const db: any = createMemoryDb();
  db.seed("conversations", [{ id: "conv1", user_id: USER, title: "محادثة جديدة", status: "active" }]);
  db.seed("credit_ledger", [{ user_id: USER, delta: 5000 }]);
  for (const t of ["mission_events", "messages", "missions"]) db.seed(t, []);
  // the two switches, IN MEMORY, for the replay user only; semantic_normalization_v1 has no row (OFF)
  db.seed("agent_settings", [{ key: CHAT_RESEARCH_BRIEF_FLAG_KEY, value: { user_ids: [USER] } }, { key: CAPABILITY_DISCOVERY_FLAG_KEY, value: { user_ids: [USER] } }]);
  const base = db.from;
  db.from = (name: string) => { const b = base(name); if (name === "missions") { const ins = b.insert; b.insert = (row: any) => ins(row.created_at ? row : { ...row, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }); } return b; };
  return db;
}
const missionsOf = (db: any) => db.rows("missions") as Array<{ id: string; status: string; request_text: string; job_id?: string | null }>;
const liveOf = (db: any) => missionsOf(db).filter((m) => m.status !== "cancelled");
const NON_REQUEST = new Set(["greeting_or_small_talk", "service_question", "methodology_request"]);

function outcomeOf(db: any, r: { ok: boolean; contentAr: string }, log: Record<string, unknown> | null): Outcome {
  const fixed = String(log?.type ?? "");
  if (fixed === "fixed_privacy_refusal") return "PRIVACY";
  if (fixed === "fixed_privacy_clarify") return "CLARIFY";
  if (r.ok && liveOf(db).length > 0) return "UNDERSTOOD";
  // round 3: a turn that only updates the parts already prepared (a part removed, the others kept) answers with the summary and draws no new card: the request is understood when live parts remain and nothing is asked
  // (round 51: likewise «كمّل» on a single request in progress, «continue_open_*»: the live mission is kept and nothing is asked)
  if (!r.ok && liveOf(db).length > 0 && /^(?:group_|continue_open_)/.test(String(log?.brief ?? "")) && !/[؟?]/.test(r.contentAr)) return "UNDERSTOOD";
  const brief = String(log?.brief ?? "");
  if (brief.startsWith("capability_unsupported") || brief === "objectives_unresolved_ask" || brief === "words_unsupported_platform") return "UNSUPPORTED";
  if (brief === "privacy" || brief === "group_privacy" || brief === "rejected_privacy_refusal") return "PRIVACY";
  // round 50: a greeting, service or methodology question answered with no mission
  if (!r.ok && r.contentAr.trim() !== "" && NON_REQUEST.has(String(log?.type ?? "")) && liveOf(db).length === 0) return "ANSWERED";
  if (!r.ok && r.contentAr.trim() !== "" && /[؟?]/.test(r.contentAr)) return "CLARIFY";
  // a non-request answered by the model with no mission (e.g. it said honestly that the thing is not offered)
  if (!r.ok && r.contentAr.trim() !== "" && log?.source === "model" && log?.type !== "data_request" && log?.type !== "edit_of_open_request") return "UNSUPPORTED";
  return "SYSTEM_FAILURE";
}
const arabic = (t: string) => { const ar = (t.match(/[؀-ۿ]/g) ?? []).length; const lat = (t.match(/[A-Za-z]/g) ?? []).length; return ar > 0 && ar >= lat * 3; };
const num = (v: string | undefined, d: number) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };

function selectedCases(env: Record<string, string | undefined>): EvalCase[] {
  const ids = (env.LIVE_EVAL_CASES ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  if (ids.length > 0) return ALL_CASES.filter((c) => ids.includes(c.id));
  const set = env.LIVE_EVAL_SET ?? "all";
  return set === "all" ? ALL_CASES : ALL_CASES.filter((c) => c.set === set);
}

describe("LIVE intelligence evaluation (real claude-haiku-5-5, guarded, cumulative budget)", () => {
  it("runs the selected cases within the per-run caps and the cumulative ceiling", async () => {
    const problems = preflight(process.env);
    if (problems.length > 0) throw new Error(`preflight refused: ${problems.join(", ")}`);
    if (!process.env.LIVE_EVAL_OUT_DIR || !outside(process.env.LIVE_EVAL_OUT_DIR)) throw new Error("preflight refused: LIVE_EVAL_OUT_DIR must be set and outside the repository");
    const budgetDir = process.env[BUDGET_DIR_ENV]!;
    if (!outside(budgetDir)) throw new Error(`preflight refused: ${BUDGET_DIR_ENV} must be outside the repository`);
    const outDir = path.resolve(process.env.LIVE_EVAL_OUT_DIR);
    mkdirSync(outDir, { recursive: true });
    const ledgerPath = path.join(outDir, "ledger.jsonl");
    writeFileSync(ledgerPath, "");

    const initUsd = process.env.LIVE_EVAL_BUDGET_INIT ? Number(process.env.LIVE_EVAL_BUDGET_INIT) : null;
    const budget = openCumulativeBudget({ dir: budgetDir, ...(initUsd !== null ? { init: { ceilingUsd: initUsd, maxAttempts: AUTHORIZED_TOTAL_ATTEMPTS } } : {}) });
    const before = budget.snapshot();
    const maxAttempts = num(process.env.LIVE_EVAL_MAX_ATTEMPTS, MAX_PAID_ATTEMPTS);
    const maxUsd = Math.min(num(process.env.LIVE_EVAL_MAX_USD, MAX_USD), AUTHORIZED_TOTAL_USD);
    const plannerOn = process.env.LIVE_EVAL_PLANNER === "1";

    const guard = createSpendingGuard({ realFetch: REAL_FETCH, cumulative: budget, maxAttempts, maxUsd, maxOutputTokens: plannerOn ? PLANNER_MAX_OUTPUT_TOKENS : undefined, onEntry: (e: LedgerEntry) => appendFileSync(ledgerPath, `${JSON.stringify(e)}\n`) });
    vi.stubGlobal("fetch", guard.fetch);
    const infos: string[] = [];
    const warns: string[] = [];
    vi.spyOn(console, "info").mockImplementation((l: unknown) => { infos.push(String(l)); });
    vi.spyOn(console, "warn").mockImplementation((l: unknown) => { warns.push(String(l).slice(0, 160)); });
    const calls: ModelCallRecord[] = [];
    let current = { caseId: "-", turn: 0 };
    setChatModelForTesting(async (input) => {
      const t0 = Date.now();
      const r: ChatModelResult = await callClaudeChatWith(input, { model: EVAL_MODEL, resolveKey: async () => process.env[KEY_ENV] ?? "", fetchImpl: guard.fetch });
      calls.push({ ...current, latencyMs: Date.now() - t0, ...(r.ok ? { ok: true, text: r.text, truncated: r.truncated === true, usage: r.usage } : { ok: false, failure: r.failure }) });
      return r;
    });

    const cases = selectedCases(process.env);
    const results: any[] = [];
    const plannerTranscripts: Record<string, PlannerTurnRecord[]> = {};
    let seq = 0;
    try {
      for (const c of cases) {
        if (guard.state.halted) { results.push({ id: c.id, set: c.set, category: c.category, title: c.title, notRun: `guard halted: ${guard.state.haltReason}` }); continue; }
        // a conversation is never half-run: it starts only when every chat call it may make fits in what is left of the run's attempts
        if (guard.state.paidAttempts + c.plannedCalls > maxAttempts) { results.push({ id: c.id, set: c.set, category: c.category, title: c.title, notRun: "attempt budget" }); continue; }
        const db = world();
        const turns: TurnRecord[] = [];
        for (let i = 0; i < c.turns.length; i += 1) {
          seq += 1;
          current = { caseId: c.id, turn: i + 1 };
          guard.setCase(`${c.id}#${i + 1}`);
          const message = c.turns[i];
          const at = Date.parse("2026-11-12T09:00:00Z") + seq * 10_000;
          db.rows("messages").push(
            { id: `u${seq}`, conversation_id: "conv1", user_id: USER, role: "user", content_ar: message, request_status: "planning", created_at: new Date(at).toISOString() },
            { id: `a${seq}`, conversation_id: "conv1", user_id: USER, role: "assistant", content_ar: "…", created_at: new Date(at + 1).toISOString() },
          );
          const callsBefore = calls.length;
          const infoBefore = infos.length;
          let r: Awaited<ReturnType<typeof agentChatTurn>>;
          try { r = await agentChatTurn({ sb: db, userId: USER, conversationId: "conv1", userMsgId: `u${seq}`, assistantMsgId: `a${seq}`, message, conversationTitle: "محادثة جديدة" }); }
          catch (e) { r = { ok: false, contentAr: `THREW: ${String((e as Error)?.message ?? e).slice(0, 120)}`, status: 500 }; }
          const line = infos.slice(infoBefore).reverse().find((l) => l.includes("chat_message_type"));
          const log = line ? JSON.parse(line) : null;
          const turnCalls = calls.slice(callsBefore);
          const last = turnCalls[turnCalls.length - 1];
          let jsonStrict: boolean | null = null, jsonProduct: boolean | null = null, briefSchemaOk: boolean | null = null, briefStatus: string | null = null, briefIssue: string | null = null, objectivesBeside = false;
          if (last?.ok && typeof last.text === "string") {
            try { const raw = JSON.parse(last.text.trim()); jsonStrict = true; objectivesBeside = Array.isArray(raw?.objectives) && raw.objectives.length > 0; } catch { jsonStrict = false; }
            const parsed = parseModelAnswer(last.text);
            jsonProduct = parsed !== null;
            if (parsed && (parsed as any).brief !== undefined) { const b = parseBrief((parsed as any).brief); briefSchemaOk = b.ok; briefStatus = b.ok ? b.brief.status : null; briefIssue = b.ok ? null : b.issue; }
          }
          const extraContents = r.ok ? (r.extraMissions ?? []).map((x) => x.contentAr ?? "") : [];
          const visible = [r.contentAr, ...extraContents].join(" ");
          turns.push({
            turn: i + 1, message, outcome: outcomeOf(db, r, log), ok: r.ok, contentAr: r.contentAr, extraContents, log, modelCalls: turnCalls.length,
            jsonStrict, jsonProduct, briefSchemaOk, briefIssue, briefStatus, objectivesBeside, arabicReply: arabic(r.contentAr), providerNameLeak: PROVIDER_NAMES.test(visible), truncated: turnCalls.some((x) => x.truncated === true),
          });
          // a correction of a plan that is READY: the first turn's live mission(s) are put in plan_ready (as the worker would) before the next turn
          if (i === 0 && c.openAs === "plan_ready") for (const m of liveOf(db)) m.status = "plan_ready";
        }
        // judged by code: the last turn (for a conversation ending with a typed «موافق», the turn before it)
        const typedOk = c.turns[c.turns.length - 1] === "موافق";
        const final = typedOk ? turns[turns.length - 2] : turns[turns.length - 1];
        const live = liveOf(db);
        const texts = live.map((m) => m.request_text);
        const lostReqs = c.keep && (final.outcome === "UNDERSTOOD" || c.id === "N7") ? c.keep(texts) : [];
        const duplicates = texts.length - new Set(texts).size;
        const allVisible = db.rows("messages").filter((m: any) => m.role === "assistant").map((m: any) => String(m.content_ar ?? "")).join(" ");
        // capability discovery of every live mission (by code), and the worker's planning: REAL planning model when LIVE_EVAL_PLANNER=1, else the scripted one
        const safe: any[] = [];
        for (const m of live) {
          const card = db.rows("messages").find((x: any) => x.plan?.agentMissionId === m.id);
          const brief: ResearchBrief | null = card?.plan?.researchBrief ? ((p) => (p.ok ? p.brief : null))(parseBrief(card.plan.researchBrief)) : null;
          const reg = buildCapabilityRegistry(catalog, { isAllowed: allowed });
          const d = discoverCapabilities(researchNeedOf({ request: m.request_text, brief }), reg);
          const stages = d.stages.map((s: any) => ({ op: s.stage.operation, key: s.stage.key, parent: s.stage.parentKey ?? null, selected: s.selected ?? null, eligible: s.eligible.length }));
          const keys = new Set(stages.map((s) => s.key));
          const danglingParents = stages.filter((s) => s.parent && !keys.has(s.parent)).length;
          const social = d.need.kind === "social";
          const realPlanner = plannerOn && !social && !guard.state.halted;
          const records: PlannerTurnRecord[] = [];
          const plan = await planSafely(m.id, m.request_text, brief, realPlanner ? { guardFetch: guard.fetch, records } : null);
          if (realPlanner) plannerTranscripts[`${c.id}:${m.id}`] = records;
          safe.push({ missionId: m.id, request: m.request_text, hasBrief: Boolean(brief), discovery: d.status, needKind: d.need.kind, needSource: d.need.source, stages, danglingParents, plannerKind: realPlanner ? "real" : social ? "compiler" : "scripted", planning: plan });
          vi.stubGlobal("fetch", guard.fetch);
        }
        // CAPABILITY SELECTION (round 51): the operations code discovered for the live missions, against the case's labels (only when the request was understood)
        const foundOps = [...new Set(safe.flatMap((x) => x.stages.map((st: any) => String(st.op))))];
        const capability = (c.ops || c.forbidOps) && final.outcome === "UNDERSTOOD"
          ? { expected: c.ops ?? [], forbidden: c.forbidOps ?? [], found: foundOps, ok: (c.ops ?? []).every((op) => foundOps.includes(op)) && !(c.forbidOps ?? []).some((op) => foundOps.includes(op)) }
          : null;
        const creditRows = db.rows("credit_ledger").length - 1;
        const accepted = c.category === "N" && c.id !== "N7"
          ? (final.outcome === "PRIVACY" || (final.outcome === "CLARIFY" && String(final.log?.type ?? "").startsWith("fixed_privacy"))) && live.length === 0
          : c.acceptable.includes(final.outcome) && lostReqs.length === 0 && (final.outcome !== "UNDERSTOOD" || texts.length === (c.parts ?? 1));
        results.push({
          id: c.id, set: c.set, category: c.category, title: c.title, legitimate: c.legitimate, acceptable: c.acceptable, turns,
          final: final.outcome, accepted, labelMatch: c.acceptable.includes(final.outcome),
          falseRefusal: c.legitimate && turns.some((t) => t.outcome === "PRIVACY"),
          modelRefusalText: c.legitimate && turns.some((t) => /لا (?:أقدر|نقدر|نجمع|تجمع)|ولا تجمع|لا يمكن(?:نا)? جمع/.test(t.contentAr) && /رقم|أرقام|بيانات شخصية|خاص/.test(t.contentAr)),
          liveMissions: texts, expectedParts: c.parts ?? 1, missingParts: final.outcome === "UNDERSTOOD" ? Math.max(0, (c.parts ?? 1) - texts.length) : null, lostRequirements: lostReqs, duplicates,
          typedApprovalAnswered: typedOk ? turns[turns.length - 1].contentAr === AGENT_PRESS_APPROVE_AR && live.every((m) => m.status === "queued" || m.status === "plan_ready") : null,
          nothingExecuted: missionsOf(db).every((m) => ["queued", "cancelled", "plan_ready"].includes(m.status) && !m.job_id), creditRowsAdded: creditRows,
          providerNameLeakAnywhere: PROVIDER_NAMES.test(allVisible), capability, safe,
        });
      }
    } finally {
      setChatModelForTesting(null);
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }

    const s = guard.state;
    const after = budget.snapshot();
    budget.close();
    const run = results.filter((r) => !r.notRun);
    const rate = (xs: any[]) => ({ n: xs.length, accepted: xs.filter((r) => r.accepted).length });
    const summary = {
      model: EVAL_MODEL, paidAttempts: s.paidAttempts, countCalls: s.countCalls, spentUsdThisRun: s.spentUsd, halted: s.halted, haltReason: s.haltReason, refusals: s.refusals,
      cumulativeBefore: before, cumulativeAfter: after,
      inputTokens: s.ledger.reduce((n, e) => n + e.inputTokens, 0), outputTokens: s.ledger.reduce((n, e) => n + e.outputTokens, 0), truncatedAttempts: s.ledger.filter((e) => e.truncated).length,
      http: s.ledger.reduce((m: Record<string, number>, e) => ({ ...m, [String(e.httpStatus)]: (m[String(e.httpStatus)] ?? 0) + 1 }), {}),
      conversations: rate(run), original: rate(run.filter((r) => r.set === "original")), expanded: rate(run.filter((r) => r.set === "expanded")), heldout: rate(run.filter((r) => r.set === "heldout")),
      falseRefusals: run.filter((r) => r.falseRefusal).map((r) => r.id), lostRequirements: run.filter((r) => r.lostRequirements.length > 0).map((r) => r.id), duplicates: run.filter((r) => r.duplicates > 0).map((r) => r.id),
      providerNameLeaks: run.filter((r) => r.providerNameLeakAnywhere || r.turns.some((t: TurnRecord) => t.providerNameLeak)).map((r) => r.id),
      capabilitySelection: { n: run.filter((r) => r.capability).length, ok: run.filter((r) => r.capability?.ok).length, wrong: run.filter((r) => r.capability && !r.capability.ok).map((r) => r.id) },
      planner: ((ps: any[]) => ({ missions: ps.length, planReady: ps.filter((p) => p.planning.status === "plan_ready").length, needsInput: ps.filter((p) => p.planning.status === "needs_input").length, unserved: ps.filter((p) => p.planning.status === "unserved").length, failed: ps.filter((p) => p.planning.status === "failed").length,
        crossProvider: ps.filter((p) => new Set((p.planning.planStages ?? []).map((st: any) => st.family)).size >= 2).length,
        families: ps.flatMap((p) => (p.planning.planStages ?? []).map((st: any) => st.family)).reduce((m: Record<string, number>, f: string) => ({ ...m, [f]: (m[f] ?? 0) + 1 }), {}) }))(run.flatMap((r) => r.safe.filter((x: any) => x.plannerKind === "real"))),
      notRun: results.filter((r) => r.notRun).map((r) => r.id),
    };
    writeFileSync(path.join(outDir, "transcripts.json"), JSON.stringify(calls, null, 1));
    writeFileSync(path.join(outDir, "planner-transcripts.json"), JSON.stringify(plannerTranscripts, null, 1));
    writeFileSync(path.join(outDir, "results.json"), JSON.stringify({ summary, results, warns }, null, 1));

    // the run's own invariants (model QUALITY is reported, never asserted here)
    expect(s.paidAttempts).toBeLessThanOrEqual(maxAttempts);
    expect(s.spentUsd).toBeLessThanOrEqual(maxUsd);
    expect(after.spentUsd + after.inflightUsd).toBeLessThanOrEqual(after.ceilingUsd);
    for (const r of run) { expect(r.nothingExecuted, r.id).toBe(true); expect(r.creditRowsAdded, r.id).toBe(0); }
  }, 120 * 60_000);
});

/**
 * REALISTIC SYNTHETIC provider rows (never real data, nothing is fetched): plausible FICTIONAL names, Arabic text on the topic the planner searched, recent dates, shaped by what the endpoint serves. Round 1 used obvious placeholders
 * («نتيجة تجريبية», example.org) and the real planner rightly refused to plan from them ("any company I delivered would be invented"): the planner is now measured on rows it can reason about. The names are invented for this evaluation.
 */
const NAMES = ["النخبة", "الريادة", "الأفق", "المرجان", "الواحة", "لؤلؤة البحر", "النجمة الذهبية", "الصفوة", "البيان", "المدار", "الشروق", "الياسمين"];
const LATIN = ["alnokhba", "alreyada", "alofok", "almorgan", "alwaha", "loloat-albahr", "golden-star", "alsafwa", "albayan", "almadar", "alshorouk", "alyasmin"];
function syntheticTreg(endpointId: string, params: Record<string, unknown>): unknown {
  // (round 51: company and people searches name their topic in other inputs, «industry», «name», «title»: any text input is the topic, so a sector search returns rows of that sector instead of a generic «السوق المحلي» the planner rightly refused)
  const anyText = Object.entries(params ?? {}).filter(([k, v]) => typeof v === "string" && v.trim().length >= 3 && !/^(?:url|link|domain|website|country|gl|hl|lang|language|location_?code|cursor|next|page|sort|order|engine|type|format)$/i.test(k) && !/^https?:/i.test(String(v))).map(([, v]) => String(v));
  const q = String(params?.query ?? params?.q ?? params?.keyword ?? params?.keywords ?? params?.search ?? params?.term ?? params?.company ?? anyText.join(" ") ?? "").replace(/\s+/g, " ").trim().slice(0, 60) || "السوق المحلي";
  const id = endpointId.toLowerCase();
  const n = 10;
  // (round 51: the place and the country of the synthetic rows follow the planner's own query, for every city of the corpus: rows from «القاهرة» for a Sharm El-Sheikh or Dubai search were rightly refused by the planner as not matching)
  const allText = `${q} ${Object.values(params ?? {}).filter((v) => typeof v === "string").join(" ")}`;
  const PLACES: Array<[RegExp, string, string]> = [[/شرم|sharm/i, "شرم الشيخ", "EG"], [/غردق|hurghada/i, "الغردقة", "EG"], [/اقصر|أقصر|luxor/i, "الأقصر", "EG"], [/اسكندري|إسكندري|alexandria/i, "الإسكندرية", "EG"], [/معادي|maadi/i, "المعادي، القاهرة", "EG"], [/زمالك|zamalek/i, "الزمالك، القاهرة", "EG"], [/مهندسين|mohandes/i, "المهندسين، الجيزة", "EG"], [/دبي|dubai/i, "دبي", "AE"], [/رياض|riyadh/i, "الرياض", "SA"], [/جدة|jeddah/i, "جدة", "SA"]];
  const place = PLACES.find(([re]) => re.test(allText));
  const cityOf = place ? place[1] : "القاهرة";
  const countryOf = place ? place[2] : /امارات|الإمارات|uae|emirates/i.test(allText) ? "AE" : /سعودي|saudi/i.test(allText) ? "SA" : "EG";
  const day = (i: number) => `2026-11-${String(10 - (i % 9)).padStart(2, "0")}T0${i % 9}:15:00Z`;
  let rows: Array<Record<string, unknown>>;
  // round 51: app stores (a search of apps; the reviews of one app)
  if (/search\.apps|search_apps/.test(id)) rows = Array.from({ length: 6 }, (_, i) => ({ app_id: `com.${LATIN[i].replace(/-/g, "")}.app`, id: `${1400000000 + i}`, title: `${q} ${["", "Pay", "Wallet", "Plus", "Lite", "Pro"][i]}`.trim(), name: `${q} ${["", "Pay", "Wallet", "Plus", "Lite", "Pro"][i]}`.trim(), developer: `${NAMES[i]} للتقنية`, rating: 3.8 + (i % 3) / 5, reviews_count: 12000 - i * 900, link: `https://play.google.com/store/apps/details?id=com.${LATIN[i].replace(/-/g, "")}.app`, url: `https://play.google.com/store/apps/details?id=com.${LATIN[i].replace(/-/g, "")}.app` }));
  else if (/review/.test(id)) rows = Array.from({ length: n }, (_, i) => ({ review_id: `r${i}${id.length}`, rating: 2 + (i % 4), text: ["الخدمة ممتازة والموظفين محترمين", "المكان نظيف بس الأسعار عالية شوية", "تجربة متوسطة والانتظار كان طويل", "أنصح بيه جدًا للعائلات"][i % 4], author: `زائر ${i + 1}`, date: day(i), place_id: `pl_${i}` }));
  else if (/maps|places|local|apple_maps|business/.test(id) && !/compan/.test(id)) rows = Array.from({ length: n }, (_, i) => ({ place_id: `pl_${i}`, name: `${NAMES[i]} — ${q}`, address: `شارع ${NAMES[(i + 3) % 12]}، ${cityOf}`, city: cityOf, rating: 3.6 + (i % 4) / 5, reviews_count: 40 + i * 13, phone: `+2010${String(2000000 + i * 3571).slice(0, 7)}`, website: `https://${LATIN[i]}.com`, maps_url: `https://maps.google.com/?cid=${1000 + i}`, category: q }));
  else if (/employee|people|linkedin|person|contact\.search/.test(id)) rows = Array.from({ length: n }, (_, i) => ({ person_id: `p${i}`, full_name: ["أحمد سمير", "منى خالد", "كريم فؤاد", "سارة عادل", "محمود نبيل", "ريم حسن", "عمرو صلاح", "نهى إبراهيم", "طارق عزت", "دينا مصطفى"][i], title: ["مدير التسويق", "مديرة التسويق الرقمي", "رئيس قسم المبيعات", "مديرة العلامة التجارية"][i % 4], company: `${NAMES[i]} ${q}`, company_domain: `${LATIN[i]}.com`, location: cityOf, profile_url: `https://www.linkedin.com/in/${LATIN[i]}-${i}` }));
  else if (/email|phone/.test(id)) rows = Array.from({ length: 3 }, (_, i) => ({ value: ["info@", "sales@", "contact@"][i] + `${LATIN[0]}.com`, type: "generic", source_page: `https://${LATIN[0]}.com/contact` }));
  else if (/compan|organization|firm|openmart/.test(id)) rows = Array.from({ length: n }, (_, i) => ({ company_id: `c${i}`, name: `${NAMES[i]} ${q}`, website: `https://${LATIN[i]}.com`, domain: `${LATIN[i]}.com`, industry: q, city: cityOf, country: countryOf, employees: 15 + i * 7, description: `شركة ${q} تأسست في ${2008 + i}` }));
  else if (/scrape|extract|contents|fetch|read/.test(id)) rows = [{ url: String(params?.url ?? `https://${LATIN[1]}-news.com/a1`), title: `${q}: تطورات جديدة`, text: `يتناول هذا المقال ${q} من عدة زوايا، ويعرض آراء المختصين وأحدث الأرقام المنشورة رسميًا.`, published_at: day(1) }];
  else rows = Array.from({ length: n }, (_, i) => ({ title: [`${q}: تطورات جديدة هذا الأسبوع`, `خبراء يعلّقون على ${q}`, `أرقام رسمية حول ${q}`, `${q} بين التحديات والفرص`][i % 4], url: `https://${LATIN[i]}-news.com/${2026}/11/article-${i + 1}`, snippet: `تقرير عن ${q} يتناول آخر المستجدات وآراء المختصين.`, source: `${NAMES[i]} نيوز`, date: day(i), position: i + 1 }));
  return { data: rows, results: rows, items: rows, next_cursor: null };
}

/**
 * The worker's planning of one mission (`runPlanning`, the production path). `real`: the planning model is the REAL one through the guarded driver; null: the scripted model that proposes nothing. Every provider answer is synthetic
 * (TREG: generic rows; social: «unavailable», as the social plan compiler is code, not a model); the network outside the Anthropic API is blocked.
 */
async function planSafely(id: string, request: string, brief: ResearchBrief | null, real: { guardFetch: typeof fetch; records: PlannerTurnRecord[] } | null) {
  const netAttempts: string[] = [];
  // during planning only the Anthropic API (through the guard) may be reached; anything else is counted and refused
  vi.stubGlobal("fetch", async (u: unknown, init?: RequestInit) => {
    const url = String(u);
    if (real && url.startsWith("https://api.anthropic.com/")) return real.guardFetch(url, init);
    netAttempts.push(url.slice(0, 60));
    throw new Error("network blocked during planning");
  });
  const store = createMemoryStore();
  Object.assign(store.settings, {
    [CAPABILITY_DISCOVERY_FLAG_KEY]: { user_ids: [REPLAY_USER] },
    redesign_flags: { social_posts: "off", social_account: "off", social_comments: "off", companies: "off", people: "off", places: "off", tiktok: "on", facebook: "on", x: "on", instagram: "on", youtube: "on" },
  });
  store.missions.set(id, newMission({ id, user_id: REPLAY_USER, request_text: request, status: "planning", created_at: "2026-11-12T09:00:00Z" }) as never);
  const rec = fakeRecorder({ dailyCapUsd: 5 });
  const providerCalls: string[] = [];
  const prompts: string[] = [];
  const web = fakeContextDev({
    parse: (parser, _url, body) => (parser === "google-play-reviews" || parser === "app-store-reviews" ? { data: { reviews: Array.from({ length: 20 }, (_, i) => ({ id: `ar${i}`, rating: 1 + (i % 5), date: `2026-11-0${1 + (i % 9)}`, title: ["تطبيق ممتاز", "بطيء أحيانًا", "مشكلة في الدخول", "سهل الاستخدام"][i % 4], text: ["التطبيق سهل وسريع في التحويلات", "بيعلق وقت الضغط", "الرسائل بتتأخر", "التحديث الأخير حلو"][i % 4], author: `مستخدم ${i + 1}` })) }, credits: 1 } : parser === "google-maps" ? { data: mapsPlace("مطعم المرجان"), credits: 1 } : parser === "google-maps-reviews" ? { data: mapsReviews(Math.min(20, Number(body?.parseParams?.limit) || 20)), credits: 1 } : { fail: { error_code: "NOT_FOUND" } }),
    search: (body: any) => Array.from({ length: 8 }, (_, i) => ({ title: `${String(body?.query ?? "الموضوع").slice(0, 50)}: ${["تطورات جديدة", "آراء الخبراء", "أرقام رسمية", "ما الذي تغيّر"][i % 4]}`, url: `https://${LATIN[i]}-news.com/2026/11/a${i + 1}`, description: "تقرير يتناول آخر المستجدات وآراء المختصين.", snippet: "تقرير يتناول آخر المستجدات وآراء المختصين.", date: `2026-11-0${1 + (i % 9)}` })),
    scrape: (url: string) => ({ markdown: `# تقرير\n\nيتناول هذا التقرير الموضوع من عدة زوايا ويعرض آراء المختصين وأحدث الأرقام المنشورة رسميًا. (${url.slice(0, 60)})`, credits: 1 }),
  });
  // FIRECRAWL's page read (POST …/v2/scrape) answers in its own shape; the Context.dev fake answers its search and parsers (and Firecrawl's search, whose path ends the same way)
  const webFetch = (async (input: string, init?: RequestInit) => {
    if (/firecrawl/i.test(String(input)) && String(input).endsWith("/scrape")) {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      web.requests.push({ url: String(input), body, headers: {} });
      const markdown = `# تقرير\n\nيتناول هذا التقرير الموضوع من عدة زوايا ويعرض آراء المختصين وأحدث الأرقام المنشورة رسميًا. (${String(body?.url ?? "").slice(0, 60)})`;
      return { status: 200, ok: true, headers: new Headers(), json: async () => ({ success: true, data: { markdown, links: [], metadata: { statusCode: 200, url: body?.url } }, creditsUsed: 1 }) } as unknown as Response;
    }
    return web.fetchFn(input, init);
  }) as typeof web.fetchFn;
  const base = real ? createEvalPlannerDriver({ fetch: real.guardFetch, key: () => process.env[KEY_ENV] ?? "", model: EVAL_MODEL, maxOutputTokens: PLANNER_MAX_OUTPUT_TOKENS, maxTurns: Number(process.env.LIVE_EVAL_PLANNER_MAX_TURNS) || 30, onTurnRecord: (r) => real.records.push(r) }) : createFakeDriver([]);
  const driver = { run: async (i: Parameters<RunnerDeps["driver"]["run"]>[0]) => { prompts.push(String(i.userPrompt ?? "")); return base.run(i); } } as RunnerDeps["driver"];
  const deps: RunnerDeps = {
    store, client: {}, catalog, driver, recorder: rec.recorder, commit: rec.commit,
    call: (async (o: { endpointId: string; params?: Record<string, unknown> }) => {
      providerCalls.push(o.endpointId);
      // social endpoints: «unavailable» (the social plan is the code's compiler, not a model); every other endpoint: synthetic rows
      if (/tiktok|instagram|facebook|youtube|twitter|(?:^|\.)x\.|\.x$/i.test(o.endpointId)) return tregResult(null, 0, { ok: false, httpStatus: 503, error: "unavailable_in_eval" });
      return tregResult(syntheticTreg(o.endpointId, o.params ?? {}), 0.001);
    }) as never,
    models: { planning: EVAL_MODEL, execution: EVAL_MODEL }, resolveAccess: async () => NOT_ADMIN, notify: async () => undefined, readMissionBrief: async () => brief,
    providerKey: (async () => "synthetic-provider-key") as never, fetchFn: webFetch as never,
  };
  let threw: string | null = null;
  setModelPlanningForTests(false);
  try { await runPlanning(deps, store.missions.get(id)!); } catch (e) { threw = String((e as Error)?.message ?? e).slice(0, 160); } finally { setModelPlanningForTests(true); }
  const m: any = store.missions.get(id)!;
  const plan = m.plan;
  return {
    status: m.status, error: m.error ?? null, question: m.question_ar ? String(m.question_ar).slice(0, 300) : null, summary: m.summary_ar ? String(m.summary_ar).slice(0, 300) : null,
    hasPlan: Boolean(plan), planStages: Array.isArray(plan?.stages) ? plan.stages.map((st: any) => ({ key: st.key, endpoint: st.endpoint_id ?? st.endpointId ?? null, family: providerFamily(String(st.endpoint_id ?? st.endpointId ?? "")), rows: st.expected_rows ?? st.expectedRows ?? null, parent: st.parent_key ?? st.parentKey ?? null, deliver: st.deliver ?? null })) : [],
    unserved: plan?.unserved_steps ?? plan?.unservedSteps ?? null, pricePoints: plan?.price_points ?? plan?.pricePoints ?? plan?.totalPoints ?? null,
    reservedPoints: m.reserved_points ?? null, jobId: m.job_id ?? null,
    providerCalls, webCalls: web.requests.length, recorderRows: rec.rows.length, netAttempts: netAttempts.length, threw,
    plannerRuns: prompts.length, plannerGotCapabilities: prompts.some((p) => p.includes("VALIDATED CAPABILITIES")),
    plannerTurns: real ? real.records.length : 0, plannerToolCalls: real ? real.records.flatMap((r) => r.toolCalls.map((t) => `${t.name}${t.ok === false ? "!" : ""}`)) : [],
  };
}
