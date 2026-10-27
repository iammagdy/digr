import { z } from "zod";
import { maskText } from "../server/rawCapture";
import { MANAGER_CALL_TIMEOUT_MS } from "./constants";
import { createAnthropicTransport, plannerCostUsd, type ContentBlock, type PlannerTransport } from "./transport";

/**
 * THE MODEL AS MANAGER OF AN APPROVED MISSION. The model is not asked on every page: only at the decision points of a mission, and only with what it needs to decide.
 *
 *  - first_page : the first page of a stage came back: do these rows match the request?
 *  - bad_page   : a page was empty, failed or all off-topic (and the sources the plan carries are the only alternatives): switch to another source, or stop this stage.
 *  - transition : a stage finished a page of rows that the next stage runs for: which of them are worth running it for?
 *  - final      : the mission is done: does what was collected answer the request (one Arabic note for the customer's summary)?
 *
 * What the model can DO is closed and bounded by code: continue, switch to one of the numbered alternatives the approved plan already carries (no dearer per call than the approved
 * ceiling), stop a stage, choose which rows of a stage the next stage runs for, write a note. It can never raise a price, a volume, a ceiling or the reserve, and a manager that fails,
 * times out or is out of budget changes nothing: the mission continues as approved.
 */
export type ManagerRequest =
  | { kind: "first_page" | "bad_page"; request: string; stageNumber: number; stageCount: number; stageTitlesAr: string[]; reason: "ok_page" | "empty" | "failed" | "off_topic"; seen: number; kept: number; sampleRows: Array<Record<string, unknown>>; alternatives: number }
  | { kind: "transition"; request: string; fromStage: number; toStage: number; stageTitlesAr: string[]; rows: Array<{ index: number; row: Record<string, unknown> }> }
  | { kind: "final"; request: string; stages: Array<{ titleAr: string; collected: number; delivered: number; stopped?: string }>; sampleRows: Array<Record<string, unknown>> };

export type ManagerDecision =
  | { action: "continue" }
  | { action: "switch"; alternate: number; reasonAr: string }
  | { action: "stop"; reasonAr: string }
  | { action: "expand"; keep: number[] }
  | { action: "final"; ok: boolean; noteAr: string };

export interface ManagerUsage { inputTokens: number; outputTokens: number; costUsd: number; model: string; latencyMs: number; failure?: string; reason: string }
export interface ManagerResult { decision: ManagerDecision; usage: ManagerUsage | null }

export interface MissionManager {
  decide(request: ManagerRequest, timeoutMs?: number): Promise<ManagerResult>;
}

/** An estimate of what one management call costs (for the budget check BEFORE the call); the real cost is read from the usage afterwards. */
export const MANAGER_CALL_ESTIMATE_USD = 0.0025;

const SYSTEM = `You manage a data-collection mission for an Arabic-speaking customer, at one decision point. You see the customer's request and a few REAL rows. Decide with the tool «decide», in one call, nothing else.
- first_page / bad_page: «continue» when the rows are about what the customer asked for; «stop» when they are clearly not and no alternative is listed; «switch» (with the alternative's number) only when alternatives are listed and the rows are unsuitable or the page failed or was empty. Judge only what the sample shows: a thin sample that looks plausible means «continue».
- transition: keep the rows (by index) that are really what the customer asked for and worth spending the next stage on; drop the rest (for example companies outside the industry, videos not about the subject). Keep all when unsure.
- final: ok = true when the collected rows answer the request; noteAr is ONE short Arabic sentence for the customer about what was collected (and, if relevant, what was not). No markdown, no emoji, no English words, no provider or technical names, no money; Arabic-Indic digits.
reasonAr (when stopping or switching): ONE short Arabic sentence for the customer, same rules.`;

const decideTool = (kind: ManagerRequest["kind"]): Record<string, unknown> => {
  const base: Record<string, unknown> = { type: "object" };
  if (kind === "transition") return { name: "decide", description: "Which rows to run the next stage for.", input_schema: { ...base, properties: { keep: { type: "array", items: { type: "integer" } }, reasonAr: { type: "string" } }, required: ["keep"] } };
  if (kind === "final") return { name: "decide", description: "The final review.", input_schema: { ...base, properties: { ok: { type: "boolean" }, noteAr: { type: "string" } }, required: ["ok", "noteAr"] } };
  return { name: "decide", description: "What to do with this stage.", input_schema: { ...base, properties: { action: { type: "string", enum: ["continue", "switch", "stop"] }, alternate: { type: "integer", minimum: 1 }, reasonAr: { type: "string" } }, required: ["action"] } };
};

const SwitchSchema = z.object({ action: z.enum(["continue", "switch", "stop"]), alternate: z.number().int().min(1).optional(), reasonAr: z.string().max(300).optional() });
const KeepSchema = z.object({ keep: z.array(z.number().int().min(0)).max(400) });
const FinalSchema = z.object({ ok: z.boolean(), noteAr: z.string().max(400) });

const clip = (v: unknown, n: number): string => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const maskRow = (row: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(row).slice(0, 10).map(([k, v]) => [k, typeof v === "string" ? maskText(clip(v, 140)) : v]));

/** The user message of a decision point: the request, the stage, the counts and the real sample rows (masked). Never an endpoint id, a provider name or a price. */
export function managerPrompt(req: ManagerRequest): string {
  const lines: string[] = [`Customer request (Arabic): ${clip(req.request, 400)}`, `Decision point: ${req.kind}`];
  if (req.kind === "final") {
    lines.push(`Stages: ${JSON.stringify(req.stages)}`, `Sample rows: ${JSON.stringify(req.sampleRows.slice(0, 6).map(maskRow))}`);
  } else if (req.kind === "transition") {
    lines.push(`Stage ${req.fromStage} just listed rows; stage ${req.toStage} (${clip(req.stageTitlesAr[req.toStage - 1] ?? "", 80)}) will run once for each row you keep.`, `Rows: ${JSON.stringify(req.rows.slice(0, 60).map((r) => ({ i: r.index, ...maskRow(r.row) })))}`);
  } else {
    lines.push(`Stage ${req.stageNumber} of ${req.stageCount}: ${clip(req.stageTitlesAr[req.stageNumber - 1] ?? "", 80)}`, `Page result: ${req.reason}. Rows seen ${req.seen}, rows kept by the rules ${req.kept}.`, `Alternatives available: ${req.alternatives} (numbered 1..${req.alternatives}; each is the same job at another source).`, `Sample rows: ${JSON.stringify(req.sampleRows.slice(0, 5).map(maskRow))}`);
  }
  return lines.join("\n");
}

/** What the tool call of the model means, checked; anything unreadable is «continue» (the mission goes on as approved). */
export function parseManagerReply(req: ManagerRequest, blocks: ContentBlock[]): ManagerDecision {
  const use = blocks.find((b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use" && b.name === "decide");
  if (!use) return { action: "continue" };
  if (req.kind === "transition") {
    const parsed = KeepSchema.safeParse(use.input);
    if (!parsed.success) return { action: "continue" };
    const valid = new Set(req.rows.map((r) => r.index));
    return { action: "expand", keep: [...new Set(parsed.data.keep.filter((i) => valid.has(i)))] };
  }
  if (req.kind === "final") {
    const parsed = FinalSchema.safeParse(use.input);
    return parsed.success ? { action: "final", ok: parsed.data.ok, noteAr: parsed.data.noteAr } : { action: "continue" };
  }
  const parsed = SwitchSchema.safeParse(use.input);
  if (!parsed.success) return { action: "continue" };
  if (parsed.data.action === "switch") {
    const alt = parsed.data.alternate ?? 0;
    if (alt < 1 || alt > req.alternatives) return { action: "continue" }; // an alternative that is not offered cannot be chosen
    return { action: "switch", alternate: alt, reasonAr: parsed.data.reasonAr ?? "" };
  }
  if (parsed.data.action === "stop") return { action: "stop", reasonAr: parsed.data.reasonAr ?? "" };
  return { action: "continue" };
}

/** The real manager, on the planning model's transport (or a recorded one in tests). */
export function createMissionManager(transport: PlannerTransport): MissionManager {
  return {
    async decide(req, timeoutMs = MANAGER_CALL_TIMEOUT_MS) {
      const started = Date.now();
      try {
        const response = await transport.send({ system: SYSTEM, messages: [{ role: "user", content: managerPrompt(req) }], tools: [decideTool(req.kind)], timeoutMs });
        const usage: ManagerUsage = { inputTokens: response.usage.inputTokens + response.usage.cacheReadTokens + response.usage.cacheWriteTokens, outputTokens: response.usage.outputTokens, costUsd: plannerCostUsd(response.usage), model: response.model, latencyMs: Date.now() - started, reason: `mission_manager_${req.kind}` };
        return { decision: parseManagerReply(req, response.content), usage };
      } catch (err) {
        return { decision: { action: "continue" }, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, model: transport.model, latencyMs: Date.now() - started, failure: clip((err as Error)?.message, 60) || "failed", reason: `mission_manager_${req.kind}` } };
      }
    },
  };
}

/** The manager of a production worker: the real transport, unless the owner switched management off (MISSION_MANAGER=off). */
export function getMissionManager(env: Record<string, string | undefined> = process.env): MissionManager | undefined {
  if (String(env.MISSION_MANAGER || "").trim().toLowerCase() === "off") return undefined;
  return createMissionManager(createAnthropicTransport());
}
