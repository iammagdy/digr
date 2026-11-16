/**
 * REAL-MODEL EVALUATION OF THE LLM-FIRST PLANNER'S UNDERSTANDING AND TOOL CHOICE (no provider call: nothing is probed, nothing is spent but the model's tokens).
 * Run where the worker's model key is (a one-off worker dyno): EVAL_REQUESTS = base64 of a JSON array of { id, words: string[] }. Prints one line per request: «EVAL <json>».
 * The understanding and the options are checked by the same code the worker runs (checkUnderstanding, checkOptions).
 */
import { loadTregCatalog } from "../../src/lib/treg/catalog";
import { anthropicPlannerModel } from "../src/llmPlanner/model";
import { LLM_PLANNER_MODEL } from "../src/llmPlanner/run";
import { chooseTools, understandRequest } from "../src/llmPlanner/planner";
import { cairoDayOf } from "../../src/lib/agentMission/cairoTime";
import { directWebEndpoints } from "../src/llmPlanner/catalogView";

async function main(): Promise<void> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) { console.log("EVAL {\"error\":\"no model key\"}"); return; }
  const requests = JSON.parse(Buffer.from(process.env.EVAL_REQUESTS ?? "", "base64").toString("utf8")) as Array<{ id: string; words: string[]; earlier?: string[] }>;
  const maxUsd = Number(process.env.EVAL_MAX_USD ?? "1");
  const catalog = loadTregCatalog();
  const model = anthropicPlannerModel(key, process.env.EVAL_MODEL || LLM_PLANNER_MODEL, { log: (l) => console.log(`EVALLOG ${l}`) });
  const deps = { model, catalog, access: null, today: cairoDayOf(Date.now()), webTools: directWebEndpoints({ firecrawl: true, contextdev: true }) };
  let total = 0;
  for (const r of requests) {
    if (total >= maxUsd) { console.log(`EVAL ${JSON.stringify({ id: r.id, skipped: "budget" })}`); continue; }
    const cost = { usd: 0 };
    const t0 = Date.now();
    const u = await understandRequest({ words: r.words, earlier: r.earlier ?? [], request: "" }, deps, cost);
    const out: Record<string, unknown> = { id: r.id };
    if (!u.ok) { out.error = u.error; } else {
      out.decision = u.value.decision;
      out.understanding = u.value.understanding_ar;
      if (u.value.question_ar) out.question = u.value.question_ar;
      if (u.value.cannot_ar) out.cannot = u.value.cannot_ar;
      out.assumptions = u.value.assumptions_ar;
      out.steps = [];
      for (const s of u.value.steps) {
        const { candidates, options } = await chooseTools(s, s.parent ? [] : null, deps, cost);
        (out.steps as unknown[]).push({ key: s.key, platform: s.platform, capability: s.capability, parent: s.parent, count: s.count, source: s.source, topic: s.topic, terms: s.search_terms, period: s.period, language: s.language, country: s.country, order: s.order,
          candidates: candidates.length, options: options.map((o) => ({ id: o.endpoint.id, params: o.params, cursor: o.cursor, parent: o.parent, more: o.more })) });
      }
    }
    out.usd = Number(cost.usd.toFixed(4));
    out.ms = Date.now() - t0;
    total += cost.usd;
    console.log(`EVAL ${JSON.stringify(out)}`);
  }
  console.log(`EVAL ${JSON.stringify({ done: true, totalUsd: Number(total.toFixed(4)) })}`);
}

void main().catch((e) => { console.log(`EVAL ${JSON.stringify({ fatal: String((e as Error)?.message ?? e).slice(0, 300) })}`); });
