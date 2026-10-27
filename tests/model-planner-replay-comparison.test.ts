import { readFileSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { world } from "./helpers/replayWorld";

vi.mock("../src/lib/supabase/server", async () => (await import("./helpers/replayWorld")).world.supabaseServerMock());
vi.mock("../src/lib/server/sendPlatformEmail", () => ({ sendPlatformEmail: vi.fn(async () => undefined), getRecipient: vi.fn(async () => null) }));
vi.mock("../src/functions/shared/catalogClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/functions/shared/catalogClient")>()),
  getEndpointDetails: vi.fn(async () => null),
  searchCatalog: vi.fn(async () => []),
}));

import { setProviderAdapterForTesting, defaultTregAdapter } from "../src/lib/server/tregAdapter";
import { ChatHandler } from "../src/functions/shared/chatHandler";
import { clearBriefCacheForTesting } from "../src/functions/shared/briefManager";
import { resetProviderBalanceCacheForTesting, setProviderBalanceForTesting } from "../src/functions/shared/providerSpend";
import { createChatDb, withPeopleSettlement } from "./helpers/chatSession";
import { createAnthropicTransport, createScriptedTransport, plannerCostUsd, type PlannerTransport } from "../src/lib/modelPlanner/transport";
import { resetExplorationMemoryForTesting } from "../src/lib/modelPlanner/exploration";
import { MODEL_PLAN_PARAM } from "../src/lib/modelPlanner/constants";
import { PLAN_INCOMPLETE_AR } from "../src/lib/modelPlanner/planner";
import { isWindowParamName } from "../src/lib/modelPlanner/validate";
import { setRowAdvisorForTesting } from "../src/lib/server/rowReviewAdvisor";
import { REPLAY_CASES, type ReplayCase } from "./helpers/replayCases";

/**
 * OLD path against NEW path, on the same stored fixtures, with ZERO real provider calls.
 *
 *  - OLD: the hand-coded chat path (no model call: it is forbidden in a replay), then the worker, as in tests/replay-harness.test.ts.
 *  - NEW: the model planner (`handler.modelPlanner`) with a RECORDED model (scripted tool calls), sample calls served from the same fixtures, then the generic interpreter.
 *    The model is RECORDED, not real. Its token counts are ESTIMATES (4 characters per token of what was sent and answered, no prompt cache); its cost is that estimate at
 *    the planner's price (0.10 USD in, 0.50 USD out per million tokens).
 *  - The topic review of the rows is stubbed for both paths (every row «match»): it is a model call in production and is not replayed here, so a delivered count on
 *    catalog-example rows shows the plumbing, not the relevance.
 *
 * Writes nothing unless asked: `REPLAY_COMPARISON_UPDATE=1 npx vitest run tests/model-planner-replay-comparison.test.ts` rewrites docs/proposals/agent-loop/REPLAY_COMPARISON.md;
 * a plain run fails when the file is out of date.
 * To measure a REAL planning model on these same cases (model cost only: the sources are still the fixtures, no provider call):
 *   REPLAY_MODEL=live REPLAY_REPORT_PATH=/some/path.md npx vitest run tests/model-planner-replay-comparison.test.ts   (needs an Anthropic key in the environment)
 * In that mode the expectations of the recorded model are not asserted, and the report is written to REPLAY_REPORT_PATH.
 */

const LIVE = process.env.REPLAY_MODEL === "live";
const realFetch = globalThis.fetch;
const REPORT = "docs/proposals/agent-loop/REPLAY_COMPARISON.md";

interface Outcome {
  engine: "old" | "new";
  kind: string;
  text: string;
  endpoint: string;
  params: string;
  window: string;
  unit: string;
  hold: string;
  delivered: string;
  charge: string;
  extra: string;
  // the new path only
  turns?: number;
  toolCalls?: number;
  sampleCalls?: number;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
  /** the old path asked its own planning model (forbidden here): nothing else was learned */
  askedOldModel?: boolean;
}
const blank = (engine: "old" | "new"): Outcome => ({ engine, kind: "-", text: "", endpoint: "-", params: "-", window: "-", unit: "-", hold: "-", delivered: "-", charge: "-", extra: "" });

const short = (v: unknown): string => { const s = typeof v === "string" ? v : JSON.stringify(v); return s.length > 48 ? `${s.slice(0, 45)}…` : s; };
const num = (n: unknown): string => (typeof n === "number" ? String(Math.round(n * 1e6) / 1e6) : "-");

function describeOldItem(item: any, quote: any): Pick<Outcome, "endpoint" | "params" | "window" | "unit" | "hold"> {
  const entries = Object.entries(item.params ?? {}).filter(([k]) => !k.startsWith("_"));
  const windowEntries = entries.filter(([k]) => /date|since|until|window|period|time/i.test(k));
  const win = [...windowEntries.map(([k, v]) => `${k}=${short(v)}`), ...(quote?.window ? [`window=${short(quote.window)}`] : [])];
  return {
    endpoint: `${item.endpointId ?? item.capabilitySlug}`,
    params: entries.filter(([k]) => !windowEntries.some(([w]) => w === k)).map(([k, v]) => `${k}=${short(v)}`).join("; ") || "-",
    window: win.length ? win.join("; ") : "none",
    unit: num(item.unitPricePoints),
    hold: num(quote?.quotedPoints),
  };
}

function describeNewItem(item: any, quote: any): Pick<Outcome, "endpoint" | "params" | "window" | "unit" | "hold"> {
  const stored = item.params?.[MODEL_PLAN_PARAM];
  const steps: any[] = stored?.steps ?? [];
  const windows: string[] = [];
  const params = steps.map((s, i) => {
    const ps = (s.params ?? []).map((p: any) => {
      if (isWindowParamName(p.name)) windows.push(`step ${i + 1} ${p.name}=${short(p.value)}`);
      return p.source === "prior_step" ? `${p.name}←step ${p.fromStep?.step}.${p.fromStep?.field} [prior_step]` : `${p.name}=${short(p.value)} [${p.source}]`;
    });
    for (const f of s.filters ?? []) if (f.kind === "date_window") windows.push(`step ${i + 1} ${f.from}..${f.to} («${f.quote}»)`);
    const filters = (s.filters ?? []).filter((f: any) => f.kind !== "date_window").map((f: any) => f.kind === "author_equals" ? `author=${f.value}` : f.kind === "exclude_true" ? `no ${f.field}` : `no «${f.prefix}»`);
    return `${steps.length > 1 ? `step ${i + 1}: ` : ""}${ps.join(", ")}${filters.length ? ` + ${filters.join(", ")}` : ""}`;
  });
  return { endpoint: steps.map((s) => s.endpointId).join(" → ") || String(item.endpointId), params: params.join(" | ") || "-", window: windows.length ? windows.join("; ") : "none", unit: num(item.unitPricePoints), hold: num(quote?.quotedPoints) };
}

function classify(r: any): { kind: string; text: string } {
  const text = String(r?.contentAr ?? "");
  if (r?.outputType === "propose_plan") return { kind: "plan", text };
  if (r?.outputType === "refuse") return { kind: "refusal", text };
  if (r?.outputType === "answer_question" && /غير متاح/.test(text)) return { kind: "refusal", text };
  if (r?.outputType === "answer_question") return { kind: text === PLAN_INCOMPLETE_AR ? "incomplete" : "question", text };
  return { kind: String(r?.outputType ?? "none"), text };
}

let seq = 0;
/** The account the NEW path runs as: an allowlisted account (the OLD path runs as an account that is not on the allowlist). */
const ALLOWLISTED = "magdy.saber@outlook.com";
async function converse(c: ReplayCase, handler: ChatHandler, db: any, answers: ReplayCase["oldAnswers"], onTurn?: (index: number) => void, userEmail?: string): Promise<any[]> {
  const conversationId = `conv_cmp_${++seq}`;
  await db.createRow({ tableId: "conversations", rowId: conversationId, data: { userId: "user_replay", title: "محادثة جديدة", status: "active", totalTokens: 0 } });
  clearBriefCacheForTesting();
  const send = (message: string): Promise<any> => handler.handleUserMessage({ userId: "user_replay", ...(userEmail ? { userEmail } : {}), conversationId, message, userBalance: 40_000 }) as Promise<any>;
  const replies: any[] = [];
  onTurn?.(0);
  replies.push(await send(c.request));
  let turn = 0;
  for (const a of answers ?? []) { onTurn?.(++turn); replies.push(await send(JSON.stringify({ type: "clarification_answers", answers: [{ questionId: a.id, question: a.question, value: a.value }] }))); }
  for (const f of c.followUps ?? []) { onTurn?.(++turn); replies.push(await send(f)); }
  return replies;
}

async function execute(item: any, quote: any, c: ReplayCase, out: Outcome): Promise<void> {
  world.resetJob({ slug: item.capabilitySlug, endpointId: item.endpointId, params: item.params, target: item.targetVolumeMax, unitPrice: item.unitPricePoints, unitCostUsd: item.unitCostUsd });
  world.installFetch(c.fixtures);
  const last = await world.runWorker();
  expect(world.stats.realCalls).toBe(0);
  const released = world.db.rpcCalls.some((x) => x.name === "release_job_atomic");
  out.delivered = String(last.json.deliveredUnits ?? 0);
  out.charge = released && !last.json.settle ? "0 (hold released)" : String(last.json.settle?.charged_credits ?? 0);
  out.extra = [out.extra, `${world.stats.served.length} source call(s) after approval${world.stats.unserved.length ? `, ${world.stats.unserved.length} without a fixture` : ""}`].filter(Boolean).join("; ");
  if (out.charge !== "0 (hold released)" && Number(out.charge) > quote.quotedPoints) throw new Error(`charge above the hold in ${c.id}`);
}

async function runOld(c: ReplayCase): Promise<Outcome> {
  const out = blank("old");
  const db: any = c.people ? withPeopleSettlement(createChatDb()) : createChatDb();
  const handler = new ChatHandler(db);
  (handler as any).llm.executeTurn = vi.fn(async () => { out.askedOldModel = true; throw new Error("the model must not be asked in a replay"); });
  let replies: any[];
  try { replies = await converse(c, handler, db, c.oldAnswers); } catch (e: any) { return { ...out, kind: out.askedOldModel ? "asks the old model" : "error", text: String(e?.message ?? e).split("\n")[0].slice(0, 120) }; }
  const r = replies[replies.length - 1];
  const { kind, text } = classify(r);
  if (out.askedOldModel && kind !== "plan") return { ...out, kind: "asks the old model", text: text.slice(0, 120) };
  Object.assign(out, { kind, text });
  if (kind === "plan") {
    const item = r.planQuote.items[0];
    Object.assign(out, describeOldItem(item, r.planQuote));
    await execute(item, r.planQuote, c, out);
  }
  return out;
}

async function runNew(c: ReplayCase): Promise<Outcome> {
  const out = blank("new");
  const db: any = c.people ? withPeopleSettlement(createChatDb()) : createChatDb();
  const handler = new ChatHandler(db);
  (handler as any).llm.executeTurn = vi.fn(async () => { throw new Error("the old model path must not run when the planner is on"); });
  const transport: PlannerTransport & { requests?: unknown[] } = LIVE ? createAnthropicTransport({ fetchFn: realFetch }) : createScriptedTransport(c.script as any, { model: "recorded" });
  handler.modelPlanner = { transport, client: world.mem, today: () => new Date("2026-10-27T12:00:00Z") };
  world.resetJob({ slug: "x", endpointId: "x", params: {}, target: 1, unitPrice: 1 });
  world.installFetch(c.fixtures);
  const requestsBefore: number[] = [];
  const logFrom = infoSpy.mock.calls.length;
  const replies = await converse(c, handler, db, undefined, () => requestsBefore.push((transport as any).requests?.length ?? 0), ALLOWLISTED);
  const r = replies[replies.length - 1];
  const { kind, text } = classify(r);
  const planned = replies.find((x) => x.outputType === "propose_plan") ?? r;
  Object.assign(out, { kind, text });
  const modelRequestsOnLastTurn = ((transport as any).requests?.length ?? 0) - (requestsBefore[requestsBefore.length - 1] ?? 0);
  if (!LIVE && c.expectNew.kind === "gate") out.kind = modelRequestsOnLastTurn === 0 ? `gate (${kind})` : `reached the planner (${kind})`;
  // what the first turn cost: the first reply carries the planning conversation's usage
  const first = replies[0];
  out.turns = first?.turnStats?.modelCalls ?? 0;
  out.toolCalls = first?.turnStats?.catalogSearches ?? 0;
  out.tokensIn = first?.tokensUsed?.input ?? 0;
  out.tokensOut = first?.tokensUsed?.output ?? 0;
  out.costUsd = first?.tokensUsed?.costUsd ?? 0;
  out.sampleCalls = world.stats.served.length;
  const codes = failureCodesSince(logFrom);
  if (codes.length) out.extra = `validation sent back ${codes.length} time(s): ${codes.map((c) => c.join("+")).join(" | ")}`;
  if (kind === "plan" || planned.outputType === "propose_plan") {
    const quote = planned.planQuote;
    const item = quote.items[0];
    if (kind === "plan") out.kind = "plan";
    Object.assign(out, describeNewItem(item, quote));
    if (replies.indexOf(planned) === replies.length - 1 || c.followUps === undefined) await execute(item, quote, c, out);
    out.extra = [out.extra, `${quote.sampleRows?.rows?.length ?? 0} sample row(s) on the card`].filter(Boolean).join("; ");
  }
  return out;
}

const rows: Array<{ c: ReplayCase; old: Outcome; neu: Outcome }> = [];
let infoSpy: any;
/** The validation failure codes the planner logged for the turns since `from` (internal log lines: codes only, never a customer value). */
const failureCodesSince = (from: number): string[][] => infoSpy.mock.calls.slice(from).map((call: any[]) => { try { return JSON.parse(String(call[0])); } catch { return null; } }).filter((l: any) => l?.tag === "model_planner_turn").flatMap((l: any) => l.failureCodes ?? []);

describe("replay comparison: the hand-coded path against the model planner, same fixtures, zero real provider calls", () => {
  beforeEach(() => {
    process.env.CRON_SECRET = "replay-test-secret"; process.env.ENABLE_MOCK_PROVIDER = "true"; (process.env as any).NODE_ENV = "test"; process.env.VERCEL_ENV = "development"; process.env.TREG_LIVE = "true"; process.env.TREG_TOKEN = "replay-not-a-real-token";
    vi.stubEnv("JOB_MAX_POINTS_CAP", "");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-27T12:00:00Z"));
    resetProviderBalanceCacheForTesting(); setProviderBalanceForTesting(50); setProviderAdapterForTesting(defaultTregAdapter);
    resetExplorationMemoryForTesting();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    setRowAdvisorForTesting(async (given) => ({ verdicts: new Map(given.rows.map((row) => [row.index, { verdict: "match", reasonAr: "" }])) as any, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, model: "stub", latencyMs: 0 }, failure: null }));
  });
  afterEach(() => { setRowAdvisorForTesting(null); vi.useRealTimers(); setProviderAdapterForTesting(null); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); resetProviderBalanceCacheForTesting(); });

  for (const c of REPLAY_CASES) {
    it(`${c.id}: ${c.request}`, async () => {
      const old = await runOld(c);
      const neu = await runNew(c);
      rows.push({ c, old, neu });
      expect(world.stats.realCalls).toBe(0);
      if (LIVE) return;
      expect(neu.kind.startsWith(c.expectNew.kind) || (c.expectNew.kind === "gate" && neu.kind.startsWith("gate")), `${c.id}: ${neu.kind} ${neu.text}`).toBe(true);
      if (c.expectNew.endpoint) expect(neu.endpoint).toContain(c.expectNew.endpoint);
      if (c.expectNew.steps) expect(neu.endpoint.split(" → ")).toHaveLength(c.expectNew.steps);
      if (c.expectNew.noWindow) expect(neu.window).toBe("none");
      // what the customer reads: Arabic, no endpoint id, no USD, no markdown, no emoji
      expect(neu.text).not.toMatch(/\b[a-z0-9]+\.[a-z0-9_.-]{2,}\b|USD|\*\*|`|\p{Extended_Pictographic}/u);
    });
  }

  it("the table: written with REPLAY_COMPARISON_UPDATE=1, otherwise it must equal docs/proposals/agent-loop/REPLAY_COMPARISON.md", () => {
    const md = renderReport(rows);
    if (LIVE) { writeFileSync(process.env.REPLAY_REPORT_PATH || "/dev/null", md); return; }
    if (process.env.REPLAY_COMPARISON_UPDATE === "1") { writeFileSync(REPORT, md); return; }
    expect(readFileSync(REPORT, "utf-8")).toBe(md);
  });
});

/** PASS when the NEW path ended in an expected kind of outcome (and, for a plan, on the expected endpoint, with no period unless the case states one); FAIL otherwise. */
function verdictOf(c: ReplayCase, neu: Outcome): "PASS" | "FAIL" {
  const kinds: string[] = [c.expectNew.kind, ...(c.alsoOk ?? [])];
  const kindOk = kinds.some((k) => neu.kind === k || neu.kind.startsWith(`${k}`) || (k === "gate" && neu.kind.startsWith("gate")));
  if (!kindOk) return "FAIL";
  if (neu.kind === "plan") {
    if (c.expectNew.endpoint && !neu.endpoint.includes(c.expectNew.endpoint)) return "FAIL";
    if (c.expectNew.steps && neu.endpoint.split(" → ").length !== c.expectNew.steps) return "FAIL";
    if (c.expectNew.noWindow && neu.window !== "none") return "FAIL";
  }
  return "PASS";
}

const esc = (s: string) => s.replace(/\|/g, "/").replace(/\n/g, " ");
function renderReport(list: typeof rows): string {
  const L: string[] = [];
  L.push("# Replay comparison: hand-coded path against the model planner");
  L.push("");
  L.push("Generated by `tests/model-planner-replay-comparison.test.ts` (`REPLAY_COMPARISON_UPDATE=1`). Zero real provider calls: the sources are the stored fixtures of `tests/fixtures/replay/` (real rows read from a live job, or the catalog's trimmed example answer; the fixture kinds are in that folder's README).");
  L.push("");
  L.push("- **OLD** = the hand-coded chat path, then the worker. The old path's own planning model is forbidden in a replay: a case that needs it is reported «asks the old model» and nothing else is known about it.");
  L.push("- **NEW** = the model planner with a **recorded** model (scripted tool calls; NOT a real Haiku), sample calls served from the same fixtures, then the generic interpreter. Tokens are **estimates** (4 characters per token of what was sent and answered, no prompt cache) priced at 0.10 USD in and 0.50 USD out per million tokens.");
  L.push("- The row review of a topic request is stubbed to «match» for every row on both paths, so a delivered count on catalog-example rows shows the plumbing, not relevance.");
  L.push("- Prices are points per delivered record (fractional unit, the hold is `ceil(volume × unit × 1.15)`, the charge is `ceil(delivered × unit)` and never above the hold). Parameters on the new path carry their provenance in brackets; the old path records none.");
  L.push("- **Read the NEW unit prices with this in mind:** the new path prices a record as `cost per call / (rows per call × share of rows that pass the plan's filters)`, both MEASURED on the sample. A catalog-example sample has ONE row per call, so those prices (L2, L3, L4, L5, L6, P8, P9, P10, P13, A) are per-single-row and far above what a live sample of about twenty rows gives. Only L1 and P5 are priced on a real sample (ten live rows, three of them the account's own posts: 0.0005 USD per call / 0.3 passing = 0.9167 points against the old 0.11715, which assumed every row passes).");
  L.push("- A plan card shows up to three masked rows of a REAL sample call; a plan validated on the catalog's example shows none.");
  L.push("");
  L.push("| case | request | engine | outcome | endpoint | params (provenance) | window | unit | hold | delivered | charge | verdict | notes |");
  L.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const { c, old, neu } of list) {
    for (const o of [old, neu]) {
      const outcome = o.kind === "plan" ? "plan" : `${o.kind}${o.text ? `: ${o.text.slice(0, 70)}` : ""}`;
      L.push(`| ${c.id} | ${o.engine === "old" ? esc([c.request, ...(c.followUps ?? [])].join(" ⟶ ")) : ""} | ${o.engine} | ${esc(outcome)} | ${esc(o.endpoint)} | ${esc(o.params)} | ${esc(o.window)} | ${o.unit} | ${o.hold} | ${o.delivered} | ${o.charge} | ${o.engine === "new" ? verdictOf(c, o) : ""} | ${esc([o.extra, o.engine === "new" ? c.note ?? "" : ""].filter(Boolean).join("; "))} |`);
    }
  }
  L.push("");
  const verdicts = list.map(({ c, neu }) => verdictOf(c, neu));
  L.push(`**Verdicts of the NEW path: ${verdicts.filter((v) => v === "PASS").length} PASS, ${verdicts.filter((v) => v === "FAIL").length} FAIL of ${verdicts.length}.** PASS = an expected kind of outcome (a plan on the expected endpoint with no period unless the customer stated one, or an honest question or refusal where the catalog cannot serve the request as asked).`);
  L.push("");
  L.push(`## Model cost per planning conversation (NEW path, ${LIVE ? "LIVE model, the provider's token counts" : "recorded model, estimated tokens"})`);
  L.push("");
  L.push("| case | model turns | catalog tool calls | real sample calls | input tokens | output tokens | USD |");
  L.push("|---|---|---|---|---|---|---|");
  const planning = list.filter(({ neu }) => (neu.turns ?? 0) > 0);
  for (const { c, neu } of planning) L.push(`| ${c.id} | ${neu.turns} | ${neu.toolCalls} | ${neu.sampleCalls} | ${neu.tokensIn} | ${neu.tokensOut} | ${(neu.costUsd ?? 0).toFixed(6)} |`);
  const sum = (f: (o: Outcome) => number) => planning.reduce((s, { neu }) => s + f(neu), 0);
  const n = planning.length || 1;
  L.push(`| **mean of ${planning.length}** | ${(sum((o) => o.turns ?? 0) / n).toFixed(2)} | ${(sum((o) => o.toolCalls ?? 0) / n).toFixed(2)} | ${(sum((o) => o.sampleCalls ?? 0) / n).toFixed(2)} | ${Math.round(sum((o) => o.tokensIn ?? 0) / n)} | ${Math.round(sum((o) => o.tokensOut ?? 0) / n)} | ${(sum((o) => o.costUsd ?? 0) / n).toFixed(6)} |`);
  L.push("");
  L.push("The planner's recorded transcripts are short by construction; a real model may take more turns. Run the same file with `REPLAY_MODEL=live` to measure a real one (see the header of the test).");
  L.push("");
  return L.join("\n");
}
