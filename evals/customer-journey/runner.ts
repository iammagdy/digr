import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createMemoryDb } from "../../tests/helpers/memoryDb";
import { agentChatTurn } from "../../src/lib/agentMission/chatTurn";
import { publicPlanOf } from "../../src/lib/agentMission/overLimit";
import { GENERIC_REPLIES, ORIGINAL_REQUEST, SUBJECT, type JourneyCase } from "./corpus";

/**
 * Runs one journey case through the product's own chat turn (`agentChatTurn`, production configuration: research-brief mode OFF) over an in-memory database seeded with the 13 Nov state.
 * The chat model is whatever `setChatModelForTesting` installed (the real one through the spending guard in the live evaluation; a scripted one offline). Pure apart from that call.
 */
export const JOURNEY_USER = "00000000-0000-4000-8000-0000000000c7";
export const OPEN_ID = "msn_c0sm3t1c5000000000";
const here = path.dirname(fileURLToPath(import.meta.url));
export const COSMETICS_PLAN = JSON.parse(readFileSync(path.resolve(here, "../../tests/fixtures/cosmetics-plan-r57.json"), "utf8"));

export function journeyWorld() {
  const db: any = createMemoryDb();
  const t0 = Date.parse("2026-11-13T10:12:24Z");
  db.seed("conversations", [{ id: "conv1", user_id: JOURNEY_USER, title: "شركات مستحضرات التجميل", status: "active" }]);
  db.seed("credit_ledger", [{ user_id: JOURNEY_USER, delta: 3281 }]);
  db.seed("agent_settings", []);
  db.seed("mission_events", []);
  db.seed("messages", [
    { id: "u0", conversation_id: "conv1", user_id: JOURNEY_USER, role: "user", content_ar: ORIGINAL_REQUEST, request_status: "planning", created_at: new Date(t0).toISOString() },
    { id: "a0", conversation_id: "conv1", user_id: JOURNEY_USER, role: "assistant", content_ar: "بدأ الوكيل دراسة طلبك؛ تابع خطة المهمة هنا.", plan: { agentMissionId: OPEN_ID }, created_at: new Date(t0 + 1).toISOString() },
  ]);
  const plan = JSON.parse(JSON.stringify(COSMETICS_PLAN));
  db.seed("missions", [{ id: OPEN_ID, user_id: JOURNEY_USER, created_by: JOURNEY_USER, request_text: ORIGINAL_REQUEST, status: "plan_ready", plan, plan_public: publicPlanOf(plan), reserved_points: plan.price.reservePoints, unit_price_points: plan.price.unitPricePoints, created_at: new Date(t0 + 5000).toISOString(), updated_at: new Date(t0 + 200_000).toISOString() }]);
  const base = db.from;
  db.from = (name: string) => { const b = base(name); if (name === "missions") { const ins = b.insert; b.insert = (row: any) => ins(row.created_at ? row : { ...row, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }); } return b; };
  return db;
}

export interface JourneyTurn {
  turn: number; message: string; reply: string; ok: boolean; log: Record<string, unknown> | null;
  openStatus: string; newMissions: Array<{ id: string; status: string; request: string }>;
  checks: { planKept: boolean; noFragment: boolean; notGeneric: boolean; mentionOk: boolean | null; newMissionOk: boolean; arabic: boolean; noLatinDigit: boolean; noProviderName: boolean };
}

const PROVIDER = /claude|anthropic|haiku|\btreg\b|firecrawl|context\.?dev|openai|\bgpt\b|tomba|google maps api/i;
const arabic = (t: string) => { const ar = (t.match(/[؀-ۿ]/g) ?? []).length; const lat = (t.match(/[A-Za-z]/g) ?? []).length; return ar > 0 && ar >= lat * 3; };

export async function runJourneyCase(c: JourneyCase, infos: string[], onTurn?: (turn: number) => void): Promise<JourneyTurn[]> {
  const db = journeyWorld();
  const out: JourneyTurn[] = [];
  for (let i = 0; i < c.turns.length; i += 1) {
    onTurn?.(i + 1);
    const message = c.turns[i];
    const at = Date.parse("2026-11-13T10:14:37Z") + i * 12_000;
    db.rows("messages").push(
      { id: `u${i + 1}`, conversation_id: "conv1", user_id: JOURNEY_USER, role: "user", content_ar: message, request_status: "planning", created_at: new Date(at).toISOString() },
      { id: `a${i + 1}`, conversation_id: "conv1", user_id: JOURNEY_USER, role: "assistant", content_ar: "…", created_at: new Date(at + 1).toISOString() },
    );
    const before = infos.length;
    let r: Awaited<ReturnType<typeof agentChatTurn>>;
    try { r = await agentChatTurn({ sb: db, userId: JOURNEY_USER, conversationId: "conv1", userMsgId: `u${i + 1}`, assistantMsgId: `a${i + 1}`, message, conversationTitle: "شركات مستحضرات التجميل" }); }
    catch (e) { r = { ok: false, contentAr: `THREW: ${String((e as Error)?.message ?? e).slice(0, 160)}`, status: 500 }; }
    const line = infos.slice(before).reverse().find((l) => l.includes("chat_message_type"));
    const log = line ? JSON.parse(line) : null;
    const missions = db.rows("missions") as Array<{ id: string; status: string; request_text: string }>;
    const open = missions.find((m) => m.id === OPEN_ID)!;
    const fresh = missions.filter((m) => m.id !== OPEN_ID).map((m) => ({ id: m.id, status: m.status, request: m.request_text }));
    const live = fresh.filter((m) => m.status !== "cancelled");
    const reply = String(r.contentAr ?? "");
    const mention = c.expect.mention?.[i] ?? null;
    out.push({
      turn: i + 1, message, reply, ok: r.ok, log, openStatus: open.status, newMissions: fresh,
      checks: {
        planKept: !c.expect.keepPlan || open.status === "plan_ready",
        // a new mission must carry the research subject unless the case IS a new subject (E)
        noFragment: c.kind === "E_new" || live.every((m) => SUBJECT.test(m.request)),
        notGeneric: !GENERIC_REPLIES.some((g) => g.test(reply.trim())),
        mentionOk: mention ? mention.test(reply) : null,
        newMissionOk: c.expect.newMission === "never" ? live.length === 0 : c.expect.newMission === "required" ? live.length > 0 : true,
        arabic: arabic(reply), noLatinDigit: !/[0-9]/.test(reply), noProviderName: !PROVIDER.test(reply),
      },
    });
  }
  return out;
}

export function scoreJourney(results: Array<{ id: string; turns: JourneyTurn[] }>) {
  const turns = results.flatMap((r) => r.turns);
  const rate = (k: keyof JourneyTurn["checks"]) => { const xs = turns.map((t) => t.checks[k]).filter((v) => v !== null); return { pass: xs.filter(Boolean).length, n: xs.length }; };
  const passed = (t: JourneyTurn) => Object.values(t.checks).every((v) => v !== false);
  return {
    turns: turns.length, turnsAllChecks: turns.filter(passed).length,
    cases: results.length, casesAllChecks: results.filter((r) => r.turns.every(passed)).length,
    planKept: rate("planKept"), noFragment: rate("noFragment"), notGeneric: rate("notGeneric"), mentionOk: rate("mentionOk"), newMissionOk: rate("newMissionOk"),
    arabic: rate("arabic"), noLatinDigit: rate("noLatinDigit"), noProviderName: rate("noProviderName"),
    modelSource: turns.filter((t) => t.log?.source === "model").length,
    failures: turns.filter((t) => t.log?.failure).map((t) => String(t.log?.failure)),
  };
}
