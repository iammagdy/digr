import { describe, expect, it, vi } from "vitest";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { callClaudeChatWith, setChatModelForTesting, type ChatModelResult } from "../../src/lib/agentMission/chatModel";
import { createSpendingGuard, preflight, AUTHORIZED_TOTAL_ATTEMPTS, BUDGET_DIR_ENV, EVAL_MODEL, KEY_ENV, type LedgerEntry } from "../live-intelligence/budget";
import { openCumulativeBudget } from "../live-intelligence/cumulative";
import { JOURNEY_CASES } from "./corpus";
import { runJourneyCase, scoreJourney } from "./runner";

/**
 * THE LIVE CUSTOMER-JOURNEY EVALUATION (round 57). Real claude-haiku-5-5 through the product's own chat transport and the guarded fetch of the live-intelligence evaluation (budget.ts: only the Anthropic Messages API,
 * every attempt reserved against the per-run cap and the cumulative state file before it is sent). Production configuration: research-brief mode OFF. Nothing executes, nothing is held.
 *
 * Run: LIVE_EVAL_CONFIRM=... DIGER_EVAL_ANTHROPIC_KEY=... LIVE_EVAL_BUDGET_DIR=<outside repo> LIVE_EVAL_OUT_DIR=<outside repo> [LIVE_EVAL_BUDGET_INIT=0.5] [JOURNEY_REPEATS=1] [JOURNEY_LABEL=baseline]
 *      npx vitest run -c vitest.live-eval.config.ts evals/customer-journey
 */
const REAL_FETCH = globalThis.fetch;
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const outside = (p: string) => { const r = path.resolve(p); return r !== REPO && !r.startsWith(REPO + path.sep); };

describe("LIVE customer journey (Egyptian cosmetics, real chat model)", () => {
  it("runs the corpus within the caps", async () => {
    const problems = preflight(process.env);
    if (problems.length > 0) throw new Error(`preflight refused: ${problems.join(", ")}`);
    const outRoot = process.env.LIVE_EVAL_OUT_DIR;
    if (!outRoot || !outside(outRoot) || !outside(process.env[BUDGET_DIR_ENV]!)) throw new Error("preflight refused: output and budget folders must be outside the repository");
    const label = (process.env.JOURNEY_LABEL ?? "run").replace(/[^a-z0-9_-]/gi, "");
    const outDir = path.resolve(outRoot, label);
    mkdirSync(outDir, { recursive: true });
    const ledgerPath = path.join(outDir, "ledger.jsonl");
    writeFileSync(ledgerPath, "");
    const initUsd = process.env.LIVE_EVAL_BUDGET_INIT ? Number(process.env.LIVE_EVAL_BUDGET_INIT) : null;
    const budget = openCumulativeBudget({ dir: process.env[BUDGET_DIR_ENV]!, ...(initUsd !== null ? { init: { ceilingUsd: initUsd, maxAttempts: AUTHORIZED_TOTAL_ATTEMPTS } } : {}) });
    const before = budget.snapshot();
    const maxUsd = Number(process.env.LIVE_EVAL_MAX_USD) || 0.15;
    const maxAttempts = Number(process.env.LIVE_EVAL_MAX_ATTEMPTS) || 120;
    const guard = createSpendingGuard({ realFetch: REAL_FETCH, cumulative: budget, maxAttempts, maxUsd, onEntry: (e: LedgerEntry) => appendFileSync(ledgerPath, `${JSON.stringify(e)}\n`) });
    vi.stubGlobal("fetch", guard.fetch);
    const infos: string[] = [];
    vi.spyOn(console, "info").mockImplementation((l: unknown) => { infos.push(String(l)); });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const calls: Array<Record<string, unknown>> = [];
    let current = "-";
    setChatModelForTesting(async (input) => {
      const t0 = Date.now();
      const r: ChatModelResult = await callClaudeChatWith(input, { model: EVAL_MODEL, resolveKey: async () => process.env[KEY_ENV] ?? "", fetchImpl: guard.fetch });
      // the prompt is the product's own (no secret in it: the balance and the plan are synthetic test data); kept so the reply can be read against what the model was told
      calls.push({ at: current, latencyMs: Date.now() - t0, system: input.system, messages: input.messages, ...(r.ok ? { ok: true, text: r.text, usage: r.usage } : { ok: false, failure: r.failure }) });
      return r;
    });
    const repeats = Math.max(1, Math.min(3, Number(process.env.JOURNEY_REPEATS) || 1));
    const ids = (process.env.JOURNEY_CASES ?? "").split(",").map((x) => x.trim()).filter(Boolean);
    const cases = ids.length > 0 ? JOURNEY_CASES.filter((c) => ids.includes(c.id)) : JOURNEY_CASES;
    const results: Array<{ id: string; kind: string; repeat: number; turns: Awaited<ReturnType<typeof runJourneyCase>> }> = [];
    try {
      for (let rep = 1; rep <= repeats; rep += 1) for (const c of cases) {
        if (guard.state.halted) break;
        guard.setCase(`${c.id}#${rep}`);
        const turns = await runJourneyCase(c, infos, (t) => { current = `${c.id}#${rep}.${t}`; });
        results.push({ id: c.id, kind: c.kind, repeat: rep, turns });
      }
    } finally {
      setChatModelForTesting(null);
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    }
    const after = budget.snapshot();
    budget.close();
    const summary = { label, model: EVAL_MODEL, repeats, paidAttempts: guard.state.paidAttempts, spentUsdThisRun: guard.state.spentUsd, halted: guard.state.halted, cumulativeBefore: before, cumulativeAfter: after, score: scoreJourney(results) };
    writeFileSync(path.join(outDir, "results.json"), JSON.stringify({ summary, results }, null, 1));
    writeFileSync(path.join(outDir, "transcripts.json"), JSON.stringify(calls, null, 1));
    expect(guard.state.spentUsd).toBeLessThanOrEqual(maxUsd);
    expect(after.spentUsd + after.inflightUsd).toBeLessThanOrEqual(after.ceilingUsd);
  }, 60 * 60_000);
});
