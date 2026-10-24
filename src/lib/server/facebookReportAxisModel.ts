import { getLlmPricingSettings } from "../../functions/shared/llmClient";
import { resolveProviderKey } from "./providerKeys";
import { reviewThinkingFields } from "./rowReviewAdvisor";
import type { AxisModelCall, AxisModelResult } from "./facebookReportAdapter";

/**
 * The ONE model call of the report's judgment: which health axis a post belongs to, for the posts the rules could not place. One call per batch of up to 50 posts, a reply of
 * numbers only («{"axes":[{"i":0,"a":3}]}»), never a price, never a comment, never a decision about money. The worker pays for it out of the job's model budget (20% of its
 * revenue) and a post beyond the budget is «general» and flagged. The model string is the one every other review call uses (`ANTHROPIC_MODEL` / `LLM_MODEL`, default claude-haiku-5-5).
 */
export const AXIS_MODEL_TIMEOUT_MS = 25_000;
const MAX_TOKENS = 1500;

export function buildAxisPrompt(posts: Array<{ i: number; text: string; publisher: string }>, axes: Array<{ id: string; nameAr: string }>): string {
  const list = axes.map((axis, index) => `${index + 1}: ${axis.nameAr}`).join("\n");
  const rows = posts.map(({ i, text, publisher }) => ({ i, publisher: publisher.slice(0, 60), text: text.replace(/\s+/g, " ").slice(0, 220) }));
  return [
    "You place Arabic Facebook posts on health topic axes. Judge ONLY from each post's own text.",
    `Axes (number: name):\n${list}\n0: general health topics (none of the axes above fits)`,
    "For every post answer with the number of the ONE axis it is mainly about, or 0 when none fits or you cannot tell. Never guess an axis from a word that has another meaning in the text.",
    "Reply with ONLY this JSON on a single line, nothing before it or after it, one item per post: {\"axes\":[{\"i\":0,\"a\":3}]}",
    "Posts:",
    JSON.stringify(rows),
  ].join("\n");
}

/** The axis numbers of a reply, as axis ids; an unreadable item simply has no axis (the post stays unplaced). */
export function parseAxisReply(text: string, axes: Array<{ id: string }>, indexes: number[]): Record<number, string> {
  const out: Record<number, string> = {};
  const wanted = new Set(indexes);
  const body = String(text || "");
  const start = body.search(/\{\s*"axes"/);
  const items: unknown[] = [];
  try {
    const parsed = JSON.parse(/\{[\s\S]*\}/.exec(start >= 0 ? body.slice(start) : body)?.[0] ?? "");
    if (Array.isArray(parsed?.axes)) items.push(...parsed.axes);
  } catch {
    for (const m of body.matchAll(/\{[^{}]*\}/g)) { try { const raw = JSON.parse(m[0]); if (raw && "i" in raw && "a" in raw) items.push(raw); } catch { /* a damaged item has no axis */ } }
  }
  for (const raw of items as Array<Record<string, unknown>>) {
    const i = Number(raw?.i);
    const a = Number(raw?.a);
    if (!Number.isInteger(i) || !wanted.has(i) || !Number.isInteger(a) || a < 0 || a > axes.length) continue;
    out[i] = a === 0 ? "general" : axes[a - 1].id;
  }
  return out;
}

export const callClaudeAxisModel: AxisModelCall = async ({ posts, axes, timeoutMs }): Promise<AxisModelResult> => {
  const fail = (failure: string): AxisModelResult => ({ ok: false, axes: {}, failure });
  if (posts.length === 0) return { ok: true, axes: {} };
  if ((process.env.LLM_PROVIDER || "").trim().toLowerCase() === "fake" || (process.env.LLM_ENABLED || "").trim().toLowerCase() === "false" || (process.env.LLM_LIVE || "").trim().toLowerCase() === "false") return fail("disabled");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, Math.min(AXIS_MODEL_TIMEOUT_MS, Number(timeoutMs) || AXIS_MODEL_TIMEOUT_MS)));
  const started = Date.now();
  try {
    const key = (await resolveProviderKey("anthropic")).key;
    if (!key) return fail("no_key");
    const model = (process.env.ANTHROPIC_MODEL || process.env.LLM_MODEL || "claude-haiku-5-5").trim();
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      signal: controller.signal,
      body: JSON.stringify({ model, max_tokens: MAX_TOKENS, ...reviewThinkingFields(), messages: [{ role: "user", content: buildAxisPrompt(posts, axes) }] }),
    });
    if (!response.ok) return fail(`http_${response.status}`);
    const data: any = await response.json();
    const text = Array.isArray(data?.content) ? data.content.map((part: any) => (typeof part?.text === "string" ? part.text : "")).join("") : "";
    const inputTokens = Number(data?.usage?.input_tokens) || 0;
    const outputTokens = Number(data?.usage?.output_tokens) || 0;
    const pricing = getLlmPricingSettings("anthropic", model);
    const costUsd = (inputTokens * pricing.inputCostPerMillion + outputTokens * pricing.outputCostPerMillion) / 1_000_000;
    const placed = parseAxisReply(text, axes, posts.map((post) => post.i));
    const usage = { inputTokens, outputTokens, costUsd, model, latencyMs: Date.now() - started };
    return Object.keys(placed).length === 0 ? { ok: false, axes: {}, usage, failure: "bad_reply" } : { ok: true, axes: placed, usage };
  } catch (err: any) {
    return fail(err?.name === "AbortError" || controller.signal.aborted ? "timeout" : "network");
  } finally {
    clearTimeout(timer);
  }
};

let injected: AxisModelCall | null = null;
/** Test-only: replace the model call (null restores the production one). */
export function setAxisModelForTesting(model: AxisModelCall | null): void {
  injected = model;
}
export const getAxisModel = (): AxisModelCall => injected ?? callClaudeAxisModel;
