import { describe, expect, it, vi } from "vitest";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createMemoryDb } from "../../tests/helpers/memoryDb";
import { REPLAY_USER } from "../../tests/helpers/agentReplay";
import { fakeRecorder, NOT_ADMIN, tregResult } from "../../tests/helpers/agentHarness";
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
import { createSpendingGuard, preflight, EVAL_MODEL, KEY_ENV, MAX_PAID_ATTEMPTS, MAX_USD, type LedgerEntry } from "./budget";
import { CASES, type EvalCase, type Outcome } from "./cases";

/**
 * THE LIVE INTELLIGENCE EVALUATION (docs/LIVE-INTELLIGENCE-EVAL.md). Runs ONLY with `npx vitest run -c vitest.live-eval.config.ts` and an approved environment (`preflight`): the default test config
 * never includes this directory.
 *
 *   REAL MODEL (paid, guarded by budget.ts): the product's own chat turn (`agentChatTurn`: code guards, the ONE chat-model call through the product's transport `callClaudeChatWith`, brief validation,
 *   exact-intent checks, capability discovery, mission creation) over an IN-MEMORY database with synthetic requests. The research-brief and capability-discovery switches are seeded in memory for the
 *   replay user only; semantic_normalization_v1 has no row (OFF).
 *
 *   MOCKED (not real-model evidence): the worker's planning of every mission the real model's turns created (`runPlanning` with a scripted planning model that proposes nothing, every provider call
 *   answered "unavailable", the network blocked).
 *
 * Outputs (ledger JSONL, transcripts, results) go to LIVE_EVAL_OUT_DIR, which must be OUTSIDE the repository.
 */
const REAL_FETCH = globalThis.fetch;
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const USER = REPLAY_USER;
const catalog = loadTregCatalog();
const allowed = (id: string) => !blockedEndpointReason(id) && policyVerdict(id, NOT_ADMIN).allowed;
const PROVIDER_NAMES = /claude|anthropic|haiku|sonnet|opus|\btreg\b|firecrawl|context\.?dev|openai|\bgpt\b|\bllm\b/i;

interface ModelCallRecord { caseId: string; turn: number; ok: boolean; failure?: string; text?: string; truncated?: boolean; usage?: { inputTokens: number; outputTokens: number }; latencyMs: number }
interface TurnRecord {
  turn: number; message: string; outcome: Outcome; ok: boolean; contentAr: string; extraContents: string[]; log: Record<string, unknown> | null; modelCalls: number;
  jsonStrict: boolean | null; jsonProduct: boolean | null; briefSchemaOk: boolean | null; briefStatus: string | null; arabicReply: boolean; providerNameLeak: boolean; truncated: boolean;
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

function outcomeOf(db: any, r: { ok: boolean; contentAr: string }, log: Record<string, unknown> | null): Outcome {
  const fixed = String(log?.type ?? "");
  if (fixed === "fixed_privacy_refusal") return "PRIVACY";
  if (fixed === "fixed_privacy_clarify") return "CLARIFY";
  if (r.ok && liveOf(db).length > 0) return "UNDERSTOOD";
  const brief = String(log?.brief ?? "");
  if (brief.startsWith("capability_unsupported") || brief === "objectives_unresolved_ask") return "UNSUPPORTED";
  if (!r.ok && r.contentAr.trim() !== "" && /[؟?]/.test(r.contentAr)) return "CLARIFY";
  // a non-request answered by the model with no mission (e.g. it said honestly that the thing is not offered)
  if (!r.ok && r.contentAr.trim() !== "" && log?.source === "model" && log?.type !== "data_request" && log?.type !== "edit_of_open_request") return "UNSUPPORTED";
  return "SYSTEM_FAILURE";
}
const arabic = (t: string) => { const ar = (t.match(/[؀-ۿ]/g) ?? []).length; const lat = (t.match(/[A-Za-z]/g) ?? []).length; return ar > 0 && ar >= lat * 3; };

describe("LIVE intelligence evaluation (real claude-haiku-5-5, guarded)", () => {
  it("runs the approved cases within 30 attempts and $1.00", async () => {
    const problems = preflight(process.env);
    if (problems.length > 0) throw new Error(`preflight refused: ${problems.join(", ")}`);
    const outDir = path.resolve(process.env.LIVE_EVAL_OUT_DIR ?? "");
    if (!process.env.LIVE_EVAL_OUT_DIR || outDir === REPO || outDir.startsWith(REPO + path.sep)) throw new Error("preflight refused: LIVE_EVAL_OUT_DIR must be set and outside the repository");
    mkdirSync(outDir, { recursive: true });
    const ledgerPath = path.join(outDir, "ledger.jsonl");
    writeFileSync(ledgerPath, "");

    const guard = createSpendingGuard({ realFetch: REAL_FETCH, onEntry: (e: LedgerEntry) => appendFileSync(ledgerPath, `${JSON.stringify(e)}\n`) });
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

    const results: any[] = [];
    let seq = 0;
    try {
      for (const c of CASES) {
        if (guard.state.halted) { results.push({ id: c.id, category: c.category, title: c.title, notRun: `guard halted: ${guard.state.haltReason}` }); continue; }
        // a conversation is never half-run: it starts only when every model call it may make fits in what is left (a 400-retry would still be refused by the guard)
        if (guard.state.paidAttempts + c.plannedCalls > MAX_PAID_ATTEMPTS) { results.push({ id: c.id, category: c.category, title: c.title, notRun: "attempt budget" }); continue; }
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
          const before = calls.length;
          const infoBefore = infos.length;
          const r = await agentChatTurn({ sb: db, userId: USER, conversationId: "conv1", userMsgId: `u${seq}`, assistantMsgId: `a${seq}`, message, conversationTitle: "محادثة جديدة" });
          const line = infos.slice(infoBefore).reverse().find((l) => l.includes("chat_message_type"));
          const log = line ? JSON.parse(line) : null;
          const turnCalls = calls.slice(before);
          const last = turnCalls[turnCalls.length - 1];
          let jsonStrict: boolean | null = null, jsonProduct: boolean | null = null, briefSchemaOk: boolean | null = null, briefStatus: string | null = null;
          if (last?.ok && typeof last.text === "string") {
            try { JSON.parse(last.text.trim()); jsonStrict = true; } catch { jsonStrict = false; }
            const parsed = parseModelAnswer(last.text);
            jsonProduct = parsed !== null;
            if (parsed && (parsed as any).brief !== undefined) { const b = parseBrief((parsed as any).brief); briefSchemaOk = b.ok; briefStatus = b.ok ? b.brief.status : null; }
          }
          const extraContents = r.ok ? (r.extraMissions ?? []).map((x) => x.contentAr ?? "") : [];
          const visible = [r.contentAr, ...extraContents].join(" ");
          turns.push({
            turn: i + 1, message, outcome: outcomeOf(db, r, log), ok: r.ok, contentAr: r.contentAr, extraContents, log, modelCalls: turnCalls.length,
            jsonStrict, jsonProduct, briefSchemaOk, briefStatus, arabicReply: arabic(r.contentAr), providerNameLeak: PROVIDER_NAMES.test(visible), truncated: turnCalls.some((x) => x.truncated === true),
          });
        }
        // judged by code: the last turn (for a conversation ending with a typed «موافق», the turn before it)
        const typedOk = c.turns[c.turns.length - 1] === "موافق";
        const final = typedOk ? turns[turns.length - 2] : turns[turns.length - 1];
        const live = liveOf(db);
        const texts = live.map((m) => m.request_text);
        const lostReqs = final.outcome === "UNDERSTOOD" && c.keep ? c.keep(texts) : [];
        const duplicates = texts.length - new Set(texts).size;
        const allVisible = db.rows("messages").filter((m: any) => m.role === "assistant").map((m: any) => String(m.content_ar ?? "")).join(" ");
        // MOCKED: capability discovery and the worker's planning of every live mission (no network, no provider, no money)
        const safe: any[] = [];
        for (const m of live) {
          const card = db.rows("messages").find((x: any) => x.plan?.agentMissionId === m.id);
          const brief: ResearchBrief | null = card?.plan?.researchBrief ? ((p) => (p.ok ? p.brief : null))(parseBrief(card.plan.researchBrief)) : null;
          const reg = buildCapabilityRegistry(catalog, { isAllowed: allowed });
          const d = discoverCapabilities(researchNeedOf({ request: m.request_text, brief }), reg);
          const stages = d.stages.map((s: any) => ({ op: s.stage.operation, key: s.stage.key, parent: s.stage.parentKey ?? null, selected: s.selected ?? null, eligible: s.eligible.length }));
          const keys = new Set(stages.map((s) => s.key));
          const danglingParents = stages.filter((s) => s.parent && !keys.has(s.parent)).length;
          const plan = await planSafely(m.id, m.request_text, brief);
          safe.push({ missionId: m.id, request: m.request_text, hasBrief: Boolean(brief), discovery: d.status, stages, danglingParents, planning: plan });
          // back to the guarded network for the next real-model turn
          vi.stubGlobal("fetch", guard.fetch);
        }
        const creditRows = db.rows("credit_ledger").length - 1;
        results.push({
          id: c.id, category: c.category, title: c.title, legitimate: c.legitimate, acceptable: c.acceptable, turns,
          final: final.outcome, accepted: c.id.startsWith("N") ? (final.outcome === "PRIVACY" || (final.outcome === "CLARIFY" && String(final.log?.type ?? "").startsWith("fixed_privacy"))) && live.length === 0 : c.acceptable.includes(final.outcome),
          falseRefusal: c.legitimate && turns.some((t) => t.outcome === "PRIVACY"),
          liveMissions: texts, expectedParts: c.parts ?? 1, missingParts: final.outcome === "UNDERSTOOD" ? Math.max(0, (c.parts ?? 1) - texts.length) : null, lostRequirements: lostReqs, duplicates,
          typedApprovalAnswered: typedOk ? turns[turns.length - 1].contentAr === AGENT_PRESS_APPROVE_AR && live.every((m) => m.status === "queued") : null,
          nothingExecuted: missionsOf(db).every((m) => (m.status === "queued" || m.status === "cancelled") && !m.job_id), creditRowsAdded: creditRows,
          providerNameLeakAnywhere: PROVIDER_NAMES.test(allVisible), safe,
        });
      }
    } finally {
      setChatModelForTesting(null);
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }

    const s = guard.state;
    const summary = {
      model: EVAL_MODEL, paidAttempts: s.paidAttempts, countCalls: s.countCalls, spentUsd: s.spentUsd, halted: s.halted, haltReason: s.haltReason, refusals: s.refusals,
      inputTokens: s.ledger.reduce((n, e) => n + e.inputTokens, 0), outputTokens: s.ledger.reduce((n, e) => n + e.outputTokens, 0), truncatedAttempts: s.ledger.filter((e) => e.truncated).length,
      http: s.ledger.map((e) => e.httpStatus),
    };
    writeFileSync(path.join(outDir, "transcripts.json"), JSON.stringify(calls, null, 1));
    writeFileSync(path.join(outDir, "results.json"), JSON.stringify({ summary, results, warns }, null, 1));

    // the run's own invariants (model QUALITY is reported, never asserted here)
    expect(s.paidAttempts).toBeLessThanOrEqual(MAX_PAID_ATTEMPTS);
    expect(s.spentUsd).toBeLessThanOrEqual(MAX_USD);
    for (const r of results) if (!r.notRun) { expect(r.nothingExecuted, r.id).toBe(true); expect(r.creditRowsAdded, r.id).toBe(0); }
  }, 30 * 60_000);
});

/** MOCKED worker planning of one mission (runPlanning; scripted planning model; every provider call answered "unavailable"; the network blocked). */
async function planSafely(id: string, request: string, brief: ResearchBrief | null) {
  const netAttempts: string[] = [];
  vi.stubGlobal("fetch", async (u: unknown) => { netAttempts.push(String(u).slice(0, 60)); throw new Error("network blocked during mocked planning"); });
  const store = createMemoryStore();
  // the worker's switches as tests/helpers/productionPlanning.ts sets them (the social platforms served, the other redesign kinds off), plus capability discovery for the replay user
  Object.assign(store.settings, {
    [CAPABILITY_DISCOVERY_FLAG_KEY]: { user_ids: [REPLAY_USER] },
    redesign_flags: { social_posts: "off", social_account: "off", social_comments: "off", companies: "off", people: "off", places: "off", tiktok: "on", facebook: "on", x: "on", instagram: "on", youtube: "on" },
  });
  store.missions.set(id, newMission({ id, user_id: REPLAY_USER, request_text: request, status: "planning", created_at: "2026-11-12T09:00:00Z" }) as never);
  const rec = fakeRecorder({ dailyCapUsd: 5 });
  const providerCalls: string[] = [];
  const prompts: string[] = [];
  const fake = createFakeDriver([]);
  const driver = { run: async (i: Parameters<RunnerDeps["driver"]["run"]>[0]) => { prompts.push(String(i.userPrompt ?? "")); return fake.run(i); } } as RunnerDeps["driver"];
  const deps: RunnerDeps = {
    store, client: {}, catalog, driver, recorder: rec.recorder, commit: rec.commit,
    call: (async (o: { endpointId: string }) => { providerCalls.push(o.endpointId); return tregResult(null, 0, { ok: false, httpStatus: 503, error: "unavailable_in_eval" }); }) as never,
    models: { planning: EVAL_MODEL, execution: EVAL_MODEL }, resolveAccess: async () => NOT_ADMIN, notify: async () => undefined, readMissionBrief: async () => brief,
  };
  let threw: string | null = null;
  // the PRODUCTION planning path (the social compiler; the model planner for the rest), as tests/helpers/productionPlanning.ts runs it
  setModelPlanningForTests(false);
  try { await runPlanning(deps, store.missions.get(id)!); } catch (e) { threw = String((e as Error)?.message ?? e).slice(0, 120); } finally { setModelPlanningForTests(true); }
  const m: any = store.missions.get(id)!;
  const files = [...store.files.keys()].map((k) => k.slice(id.length + 1));
  return {
    status: m.status, error: m.error ?? null, question: m.question_ar ? String(m.question_ar).slice(0, 200) : null, summary: m.summary_ar ? String(m.summary_ar).slice(0, 200) : null,
    hasPlan: Boolean(m.plan), planStages: Array.isArray(m.plan?.stages) ? m.plan.stages.map((st: any) => st.operation ?? st.key ?? st.kind ?? "?") : [], reservedPoints: m.reserved_points ?? null, jobId: m.job_id ?? null,
    providerCalls, recorderRows: rec.rows.length, netAttempts: netAttempts.length, files, threw,
    plannerRuns: prompts.length, plannerGotCapabilities: prompts.some((p) => p.includes("VALIDATED CAPABILITIES")), plannerStageLines: (prompts[0]?.match(/stage [a-z_]+ \([a-z.]+/g) ?? []).slice(0, 8),
  };
}
