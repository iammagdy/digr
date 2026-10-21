/**
 * Pure parts of the staged pressure test (scripts/pressure/run.ts). The test is run by the OWNER against a PREVIEW deployment that uses the
 * fake provider and a SEPARATE test database (docs/PRESSURE_TEST_RUNBOOK.md). Nothing here talks to a network.
 */
import { PRODUCTION_DATABASE_REF } from "../../src/lib/server/fakeProviderMode";

export const PRODUCTION_HOSTS = ["diger.tech", "www.diger.tech", "diger.vercel.app", "diger-iam-magdy.vercel.app", "diger-git-main-iam-magdy.vercel.app"];
export const CONFIRM_PHRASE = "preview-and-test-database";

export interface Stage { visitors: number; rampSeconds: number; missionShare: number; chatTurns: number }

/** The four stages. Each starts only after the one before it passed (see `stagePassed`). */
export const STAGES: Record<number, Stage> = {
  50: { visitors: 50, rampSeconds: 60, missionShare: 0.25, chatTurns: 3 },
  100: { visitors: 100, rampSeconds: 60, missionShare: 0.25, chatTurns: 3 },
  250: { visitors: 250, rampSeconds: 90, missionShare: 0.25, chatTurns: 3 },
  500: { visitors: 500, rampSeconds: 120, missionShare: 0.25, chatTurns: 3 },
};

export interface SafetyInput { base: string; testDatabaseUrl: string; confirm: string | undefined; stage: number; allow500: boolean }

/** Returns the reasons the run must NOT start (an empty list means it may). */
export function safetyProblems(input: SafetyInput): string[] {
  const problems: string[] = [];
  let host = "";
  try { host = new URL(input.base).hostname.toLowerCase(); } catch { problems.push("the base address is not a valid address"); }
  if (host && PRODUCTION_HOSTS.includes(host)) problems.push(`${host} is the live site: the pressure test never runs against it`);
  if (host && !host.endsWith(".vercel.app")) problems.push(`${host} is not a preview deployment address (*.vercel.app)`);
  if (input.testDatabaseUrl.includes(PRODUCTION_DATABASE_REF)) problems.push("the test database address is the LIVE database");
  if (!/^https:\/\/[a-z0-9]+\.supabase\.co\/?$/i.test(input.testDatabaseUrl)) problems.push("the test database address is not a database address");
  if (input.confirm !== CONFIRM_PHRASE) problems.push(`set PRESSURE_TEST_CONFIRM=${CONFIRM_PHRASE} to confirm it is a preview and a test database`);
  if (!STAGES[input.stage]) problems.push(`unknown stage ${input.stage} (use 50, 100, 250 or 500)`);
  if (input.stage === 500 && !input.allow500) problems.push("stage 500 needs --yes-500 after stages 50, 100 and 250 passed");
  return problems;
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

export interface StepStats { count: number; ok: number; statuses: Record<string, number>; p50: number; p95: number; max: number }

export class Recorder {
  private readonly steps = new Map<string, { ms: number[]; statuses: Map<string, number> }>();
  record(step: string, status: number | string, ms: number): void {
    const entry = this.steps.get(step) ?? { ms: [] as number[], statuses: new Map<string, number>() };
    entry.ms.push(ms);
    entry.statuses.set(String(status), (entry.statuses.get(String(status)) ?? 0) + 1);
    this.steps.set(step, entry);
  }
  summary(): Record<string, StepStats> {
    const out: Record<string, StepStats> = {};
    for (const [step, entry] of this.steps) {
      const statuses = Object.fromEntries(entry.statuses);
      out[step] = {
        count: entry.ms.length,
        ok: Object.entries(statuses).filter(([code]) => /^2\d\d$/.test(code)).reduce((a, [, n]) => a + n, 0),
        statuses,
        p50: Math.round(percentile(entry.ms, 50)),
        p95: Math.round(percentile(entry.ms, 95)),
        max: Math.round(Math.max(...entry.ms)),
      };
    }
    return out;
  }
}

export interface LedgerRow { id: string; user_id: string; delta: number | string; type: string; job_id?: string | null }

export interface LedgerFindings { ok: boolean; problems: string[]; users: number; jobs: number }

/**
 * The money rules, checked on the test database after a stage: one reserve per job, one release per job at most, one charge per job at
 * most, a charge never above its reserve, no balance below zero, and no job whose reserve was taken twice.
 */
export function checkLedger(rows: LedgerRow[]): LedgerFindings {
  const problems: string[] = [];
  const byJob = new Map<string, { reserve: number[]; release: number[]; charge: number[] }>();
  const balance = new Map<string, number>();
  for (const row of rows) {
    const delta = Number(row.delta);
    balance.set(row.user_id, (balance.get(row.user_id) ?? 0) + (Number.isFinite(delta) ? delta : 0));
    if (!row.job_id) continue;
    const entry = byJob.get(row.job_id) ?? { reserve: [], release: [], charge: [] };
    if (row.type === "reserve") entry.reserve.push(delta);
    else if (row.type === "release") entry.release.push(delta);
    else if (row.type === "charge") entry.charge.push(delta);
    byJob.set(row.job_id, entry);
  }
  for (const [job, entry] of byJob) {
    if (entry.reserve.length > 1) problems.push(`job ${job}: ${entry.reserve.length} reserves`);
    if (entry.release.length > 1) problems.push(`job ${job}: ${entry.release.length} releases`);
    if (entry.charge.length > 1) problems.push(`job ${job}: ${entry.charge.length} charges`);
    const reserved = Math.abs(entry.reserve[0] ?? 0);
    const charged = Math.abs(entry.charge[0] ?? 0);
    if (entry.charge.length > 0 && entry.reserve.length === 0) problems.push(`job ${job}: a charge with no reserve`);
    if (reserved > 0 && charged > reserved) problems.push(`job ${job}: charged ${charged} above the reserve ${reserved}`);
  }
  for (const [user, value] of balance) if (value < -1e-9) problems.push(`user ${user}: balance below zero (${value})`);
  return { ok: problems.length === 0, problems, users: balance.size, jobs: byJob.size };
}

export interface StageResult { stage: number; summary: Record<string, StepStats>; ledger: LedgerFindings; failedVisitors: number; visitors: number }

/** A stage passes when nothing broke money, almost every chat answered, and no step is mostly failing. The owner reads the numbers too. */
export function stagePassed(result: StageResult): { passed: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!result.ledger.ok) reasons.push(`the ledger check failed: ${result.ledger.problems.slice(0, 3).join("; ")}`);
  const chat = result.summary.chat_turn;
  if (!chat || chat.count === 0) reasons.push("no chat turn was recorded");
  else if (chat.ok / chat.count < 0.98) reasons.push(`only ${Math.round((chat.ok / chat.count) * 100)}% of chat turns answered`);
  if (chat && chat.p95 > 20_000) reasons.push(`the slowest 5% of chat turns took over 20 s (p95 ${chat.p95} ms)`);
  if (result.failedVisitors / Math.max(1, result.visitors) > 0.05) reasons.push(`${result.failedVisitors} of ${result.visitors} visitors could not finish their steps`);
  return { passed: reasons.length === 0, reasons };
}
