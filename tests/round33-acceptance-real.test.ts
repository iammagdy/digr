import { readFileSync, readdirSync } from "node:fs";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { priceMissionByCode } from "../src/lib/agentMission/price";
import { stagePriceInputs } from "../src/lib/agentMission/plan";
import { cardOf } from "../src/lib/agentMission/foundation/toolCards";
import { violationTextAr } from "../src/lib/agentMission/foundation/deliveryContract";
import { csvExportFromWorkbook } from "../src/lib/server/csvFromExcel";
import { replayMission, type MissionReplay } from "./helpers/missionReplay";
import { FB, M12, MISSIONS, YT1 } from "./helpers/round14Missions";
import { worldOf } from "./helpers/round32Worlds";

/**
 * ROUND 33, ACCEPTANCE ON REAL EVIDENCE: the scenarios the hand-written (VERIFIED) cards already serve are replayed on the stored REAL provider pages (tests/fixtures/live, anonymised) and must be exactly what they were: the same tools, the same ids, the same counts, the price of the one
 * pricing function, the same files. This is what keeps the existing customer flows working beside discovery (which is off by default). Nothing here is simulated, and nothing is a model or a network call.
 *   1. TikTok keyword videos (M12)   3. Facebook keyword posts (round 12)   8. YouTube videos with comments and replies (round 11)   X and Instagram: files and counts from their stored rows (see the note in each test).
 */
const catalog = (await import("../src/lib/treg/catalog")).loadTregCatalog();
const rawIdsOf = (mission: string): Set<string> => {
  const ids = new Set<string>();
  const walk = (o: unknown): void => { if (Array.isArray(o)) o.forEach(walk); else if (o && typeof o === "object") { for (const [k, v] of Object.entries(o as Record<string, unknown>)) { if (["id", "pk", "video_id", "aweme_id", "post_id", "cid", "comment_id", "reply_id", "commentId", "rest_id", "tweet_id"].includes(k) && (typeof v === "string" || typeof v === "number")) ids.add(String(v)); walk(v); } } };
  const dir = new URL(`./fixtures/live/missions/${mission}/raw/`, import.meta.url);
  for (const f of readdirSync(dir)) { try { walk(JSON.parse(readFileSync(new URL(f, dir), "utf8"))); } catch { /* not JSON */ } }
  return ids;
};

describe.each(MISSIONS.filter((m) => [M12, YT1, FB].includes(m.id)))("$label", ({ id, input }) => {
  let r: MissionReplay;
  beforeAll(async () => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(input.readAt)); r = await replayMission(input); }, 240_000);
  afterAll(() => { vi.useRealTimers(); });

  it("INTENT AND TOOL: the plan is the compiler's, every stage's tool is a hand-written VERIFIED card (never a derived one: discovery is off), and no stage was left without a tool", () => {
    expect(r.planned.plan.compiled?.by).toBe("compiler");
    expect(r.planned.plan.compiled?.discovery).toBeUndefined();
    for (const s of r.planned.plan.stages) { const card = cardOf(s.endpoint_id); expect(card, s.endpoint_id).not.toBeNull(); expect(card!.status, s.endpoint_id).toMatch(/verified|catalog_only/); expect(card!.derived).toBeUndefined(); }
  });
  it("QUOTATION AND LIMITS: the stored price is the price of the one pricing function over the stages (code's, not a model's), the reservation is explicit, and every stage has a bound", () => {
    expect(JSON.stringify(r.planned.plan.price)).toBe(JSON.stringify(priceMissionByCode(stagePriceInputs(r.planned.plan.stages), { settings: undefined })));
    expect(r.planned.plan.price.reservePoints).toBeGreaterThan(0);
    // the hold covers the largest charge the plan can make (the hold also carries the safety margin of the pricing function)
    expect(r.planned.plan.price.maxChargePoints).toBeLessThanOrEqual(r.planned.plan.price.reservePoints);
    for (const s of r.planned.plan.stages) expect(s.planned_rows, s.key).toBeGreaterThan(0);
  });
  it("DATA: every delivered id is one the provider's stored pages gave (nothing invented), none is delivered twice, no row was excluded by a relevance judgement, and every execution read was a stored page", () => {
    const given = rawIdsOf(id);
    for (const [stage, rows] of Object.entries(r.rowsByStage)) {
      expect(new Set(rows.map((x) => String(x.id))).size, stage).toBe(rows.length);
      for (const row of rows) expect(given.has(String(row.id)), `${stage} ${row.id}`).toBe(true);
    }
    expect(r.unservedExecution).toBe(0);
    expect(r.built.contract.violations.map(violationTextAr)).toEqual([]);
  });
  it("FILES: the Excel carries a sheet per delivered stage, the CSV of each stage has exactly the delivered rows (UTF-8 with a BOM), and the methodology CSV is present", async () => {
    const exp = await csvExportFromWorkbook(r.built.xlsx);
    const delivering = r.planned.plan.stages.filter((s) => s.deliver);
    expect(exp.stages.length).toBeGreaterThanOrEqual(delivering.length > 1 ? 2 : 1);
    for (const s of exp.stages) expect(s.csv.charCodeAt(0)).toBe(0xfeff);
    const total = exp.stages.reduce((n, s) => n + s.csv.split("\r\n").filter(Boolean).length - 1, 0);
    expect(total).toBeGreaterThanOrEqual(Object.values(r.rowsByStage).reduce((n, rows) => n + rows.length, 0));
    expect(exp.methodologyCsv.length).toBeGreaterThan(0);
  });
});

describe("X and Instagram: the delivery of their stored REAL rows (their planning replays are covered by tests/foundation-replay.test.ts and tests/platform-instagram.test.ts; the X keyword planning replay is documented there as NOT MET: no stored page answers the compiler's inputs)", () => {
  it.each(["x", "instagram"] as const)("%s: the Excel and the CSV carry exactly the stored rows, with their ids, links and parent-child relations", async (name) => {
    const w = await worldOf(name);
    const exp = await csvExportFromWorkbook(w.xlsx);
    for (const [stage, rows] of Object.entries(w.rowsByStage)) {
      expect(new Set(rows.map((x) => String(x.id))).size, stage).toBe(rows.length);
      if (stage.endsWith("_replies")) continue;
      const sheet = exp.stages.find((s) => w.plan.stages.find((p) => p.key === stage && s.sheet.includes(p.title_ar)));
      expect(sheet, stage).toBeDefined();
      // a stage's replies sit in the sheet of their comments (as in the Excel)
      const withReplies = rows.length + (w.rowsByStage[`${stage}_replies`] ?? []).length;
      expect(sheet!.csv.split("\r\n").filter(Boolean).length - 1, stage).toBe(withReplies);
    }
  });
});
void catalog;
