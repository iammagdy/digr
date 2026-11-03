import { readFileSync } from "node:fs";
import ExcelJS from "exceljs";
import { loadTregCatalog } from "../../src/lib/treg/catalog";
import { createMemoryStore } from "../../agent/src/memoryStore";
import { planByCompiler } from "../../agent/src/compiled";
import { NO_ABOUT_OPTIONS_AR } from "../../src/lib/agentMission/foundation/topicChoice";
import { buildMissionFiles } from "../../agent/src/workbook";
import { buildAsk } from "../../src/lib/agentMission/foundation/ask";
import { compilePlan, parentInputs } from "../../src/lib/agentMission/foundation/compilePlan";
import { cardOf, mapPage } from "../../src/lib/agentMission/foundation/toolCards";
import { customerPlanView, type PricedPlan } from "../../src/lib/agentMission/plan";
import { reportedPlan, withPromiseCaps, withRepliesJudged } from "../../src/lib/agentMission/repliesCard";
import { replayGateway } from "./replayGateway";

/**
 * THE TIKTOK AND X WORLDS of round 11 (the stored real pages of M12, M14 and msn_50e3b83c44e7ebd7f577, anonymised): the compiled plan, its customer view, and the file (every cell of every sheet) that each platform's replay produces.
 * Round 11 changes the file (a counter the source does not give reads «غير متاح») and the parent sheet (the topic mark is always there): `tests/round11-tiktok-x-invariance.test.ts` pins what these worlds produce and states the diff.
 */
const catalog = loadTregCatalog();
const read = (m: string, rel: string) => JSON.parse(readFileSync(new URL(`../fixtures/live/missions/${m}/${rel}.json`, import.meta.url), "utf8"));

export async function cellsOf(xlsx: Buffer): Promise<Record<string, string[][]>> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(xlsx as unknown as ArrayBuffer);
  const out: Record<string, string[][]> = {};
  wb.eachSheet((ws) => {
    const rows: string[][] = [];
    ws.eachRow({ includeEmpty: false }, (row) => { const cells: string[] = []; row.eachCell({ includeEmpty: true }, (c) => { const v = c.value; cells.push(v === null || v === undefined ? "" : typeof v === "object" && "text" in (v as object) ? String((v as { text: unknown }).text) : v instanceof Date ? v.toISOString() : String(v)); }); rows.push(cells); });
    out[ws.name] = rows;
  });
  return out;
}

export async function tiktokWorld(): Promise<{ plan: PricedPlan; view: unknown; cells: Record<string, string[][]> }> {
  const M12 = "msn_5851abc92a1e6645a9cd";
  const request = "هات فيديوهين تيك توك بالعربي عن الذكاء الاصطناعي من مصر، أكتر فيديوهات عليها تعليقات، و٢٠ تعليق من كل فيديو مع ردودهم";
  const store = createMemoryStore();
  const { gateway } = replayGateway(M12, catalog, store, "msn_r11_tt");
  const planned = await planByCompiler({ mission: { id: "msn_r11_tt", request_text: request, answer_text: NO_ABOUT_OPTIONS_AR.useAsIs, created_at: "2026-11-02T11:35:00Z" }, gateway, store, catalog, nowMs: Date.parse("2026-11-02T11:36:00Z") });
  if (planned.kind !== "plan") throw new Error(`no plan: ${planned.kind}`);
  const videos = read(M12, "rows/videos").map((r: Record<string, unknown>) => ({ ...r }));
  const all = read(M12, "rows/comments") as Array<Record<string, unknown>>;
  const comments = videos.flatMap((v: Record<string, unknown>) => all.filter((c) => c.parent_id === v.id).slice(0, 20));
  const ids = new Set(comments.map((c: Record<string, unknown>) => String(c.id)));
  const replies = (read(M12, "rows/comments_replies") as Array<Record<string, unknown>>).filter((r) => ids.has(String(r.parent_id)));
  const rowsByStage: Record<string, Array<Record<string, unknown>>> = { videos, comments, comments_replies: replies };
  let p = withPromiseCaps(planned.plan);
  p = reportedPlan(p, Object.fromEntries(p.stages.map((s) => [s.key, rowsByStage[s.key].length])));
  const judged = withRepliesJudged(p, rowsByStage, () => true);
  const built = await buildMissionFiles(judged, rowsByStage, undefined, undefined, { repliesJudged: true });
  return { plan: planned.plan, view: customerPlanView(planned.plan), cells: await cellsOf(built.xlsx) };
}

export async function xWorld(): Promise<{ plan: PricedPlan; view: unknown; cells: Record<string, string[][]> }> {
  const M14 = "msn_b060d3347ed7660f972e";
  const request = "هات ٢٠ تغريدة على X فيها «العاصمة الإدارية» بالعربي في شهر أكتوبر ٢٠٢٦، مع الردود";
  const page = read(M14, "raw/call_0003");
  const searchCard = cardOf("anyapi.x.search.posts")!;
  const ask = buildAsk(request, null, Date.parse("2026-11-03T08:31:29Z"));
  const r = compilePlan({ ask, pool: { card: searchCard, params: parentInputs(searchCard, ask), pages: [{ callId: "call_0001", page }] }, exposure: () => undefined, capabilityOf: (id) => catalog.byId.get(id)?.capability ?? null, catalogOnly: true });
  if (!r.ok) throw new Error(r.reason);
  const counters = [23, 5, 3, 1, 1];
  const delivered = [16, 4, 1, 2, 2];
  // the rows the run delivers are the plan's own chosen rows (with the marks the plan put on them), as the engine keeps them
  const pinned = (r.plan.stages[0].pinned_rows ?? []) as Array<Record<string, unknown>>;
  const chosen = pinned.length > 0 ? pinned : mapPage(searchCard, page).filter((t) => r.chosen.includes(String(t.id)));
  const tweets = chosen.slice(0, 20).map((t, i): Record<string, any> => ({ ...t, replies_count: counters[i] ?? 0, __marks: { reply: false, repost: false, lang: "ar", inPeriod: true, named: null } }));
  const replies = tweets.flatMap((t, i) => Array.from({ length: delivered[i] ?? 0 }, (_, k) => ({ id: `r_${i}_${k}`, parent_id: String(t.id), text: `نص ${k}`, author: "a", posted_at: "2026-10-05T10:00:00.000Z", likes: 0, replies_count: 0, language: "ar" })));
  const built = await buildMissionFiles(r.plan as PricedPlan, { tweets, replies } as never);
  return { plan: r.plan as PricedPlan, view: customerPlanView(r.plan as PricedPlan), cells: await cellsOf(built.xlsx) };
}
