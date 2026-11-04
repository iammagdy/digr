import { readFileSync } from "node:fs";
import { loadTregCatalog } from "../../src/lib/treg/catalog";
import { createMemoryStore } from "../../agent/src/memoryStore";
import { planByCompiler } from "../../agent/src/compiled";
import { NO_ABOUT_OPTIONS_AR } from "../../src/lib/agentMission/foundation/topicChoice";
import { buildMissionFiles } from "../../agent/src/workbook";
import { reportedPlan, withPromiseCaps, withRepliesJudged } from "../../src/lib/agentMission/repliesCard";
import type { PricedPlan, PricedStage } from "../../src/lib/agentMission/plan";
import { replayGateway } from "./replayGateway";

/**
 * THE STORED REAL MISSIONS OF THE FIVE PLATFORMS (anonymised, tests/fixtures/live): the plan the current compiler writes on the stored real pages of a live mission, the rows of its stored `rows/*.json`, and the files the worker writes from them.
 * Round 32 reads the Excel of each and checks the customer's CSV against it.
 */
const catalog = loadTregCatalog();
const read = (m: string, rel: string): Array<Record<string, unknown>> => JSON.parse(readFileSync(new URL(`../fixtures/live/missions/${m}/${rel}.json`, import.meta.url), "utf8"));
const replay = JSON.parse(readFileSync(new URL("../fixtures/live/replay-missions.json", import.meta.url), "utf8")) as { missions: Array<{ id: string; request: string }> };

export const WORLDS = {
  tiktok: { id: "msn_5851abc92a1e6645a9cd", stages: ["videos", "comments", "comments_replies"] },
  instagram: { id: "msn_e3e7632e2fb2d42f9c19", stages: ["posts", "comments", "comments_replies"] },
  facebook: { id: "msn_6bb78c15d116268b0b9b", stages: ["posts", "comments", "comments_replies"] },
  youtube: { id: "msn_ee599cdbbde993073b15", stages: ["videos", "comments"] },
  x: { id: "msn_b060d3347ed7660f972e", stages: ["tweets"] },
} as const;
const TITLE_AR: Record<string, string> = { text: "النص", title: "العنوان", description: "الوصف", author: "الناشر", username: "اسم المستخدم", url: "الرابط", link: "الرابط", posted_at: "تاريخ النشر", date: "تاريخ النشر", likes: "الإعجابات", views: "المشاهدات", comments: "التعليقات", shares: "المشاركات", replies_count: "عدد الردود", followers: "المتابعون", is_reply: "رد", kind: "النوع", retweets: "إعادة النشر" };
const STAGE_TITLE_AR: Record<string, string> = { posts: "المنشورات", videos: "الفيديوهات", tweets: "التغريدات", comments: "التعليقات", comments_replies: "ردود التعليقات" };
/** The platforms whose live plan the replay does not rebuild without bespoke inputs (Facebook, YouTube, X): the stored REAL rows with a plan written from the rows' own keys. */
const HAND = new Set<WorldName>(["facebook", "youtube", "x"]);
export type WorldName = keyof typeof WORLDS;

export interface World { name: WorldName; plan: PricedPlan; rowsByStage: Record<string, Array<Record<string, unknown>>>; xlsx: Buffer; csv: string }

async function handWorld(name: WorldName): Promise<World> {
  const w = WORLDS[name];
  const rowsByStage: Record<string, Array<Record<string, unknown>>> = {};
  const stages: PricedStage[] = [];
  w.stages.forEach((key, i) => {
    let rows: Array<Record<string, unknown>> = [];
    try { rows = read(w.id, `rows/${key}`); } catch { rows = []; }
    if (rows.length === 0) return;
    rowsByStage[key] = rows;
    const keys = Object.keys(rows[0]).filter((k) => TITLE_AR[k]);
    stages.push({ key, title_ar: STAGE_TITLE_AR[key] ?? key, endpoint_id: "e", expected_rows: rows.length, planned_rows: rows.length, parent_key: i === 0 ? null : w.stages[i - 1], deliver: true, columns: keys.map((k) => ({ key: k, title_ar: TITLE_AR[k] })), sample_rows: [], measured_by: [] } as unknown as PricedStage);
  });
  const plan = { summary_ar: "x", stages, price: { deliveredRows: stages.reduce((n, s) => n + (rowsByStage[s.key] ?? []).length, 0) } } as unknown as PricedPlan;
  const built = await buildMissionFiles(plan, rowsByStage);
  return { name, plan, rowsByStage, xlsx: built.xlsx, csv: built.csv };
}

export async function worldOf(name: WorldName): Promise<World> {
  if (HAND.has(name)) return handWorld(name);
  const w = WORLDS[name];
  const request = replay.missions.find((m) => m.id === w.id)!.request;
  const store = createMemoryStore();
  const { gateway } = replayGateway(w.id, catalog, store, `msn_r32_${name}`);
  let planned = await planByCompiler({ mission: { id: `msn_r32_${name}`, request_text: request, answer_text: null, created_at: "2026-11-03T13:34:59Z" }, gateway, store, catalog, nowMs: Date.parse("2026-11-03T13:35:20Z") });
  if (planned.kind !== "plan") planned = await planByCompiler({ mission: { id: `msn_r32_${name}`, request_text: request, answer_text: NO_ABOUT_OPTIONS_AR.useAsIs, created_at: "2026-11-03T13:34:59Z" }, gateway, store, catalog, nowMs: Date.parse("2026-11-03T13:35:20Z") });
  if (planned.kind !== "plan") throw new Error(`no plan for ${name}: ${planned.kind}`);
  const rowsByStage: Record<string, Array<Record<string, unknown>>> = {};
  for (const s of planned.plan.stages) { try { rowsByStage[s.key] = read(w.id, `rows/${s.key}`); } catch { rowsByStage[s.key] = []; } }
  let plan = withPromiseCaps(planned.plan);
  plan = reportedPlan(plan, Object.fromEntries(plan.stages.map((s) => [s.key, (rowsByStage[s.key] ?? []).length])));
  plan = withRepliesJudged(plan, rowsByStage, () => true);
  const built = await buildMissionFiles(plan, rowsByStage, undefined, undefined, { repliesJudged: true });
  return { name, plan, rowsByStage, xlsx: built.xlsx, csv: built.csv };
}
