import http from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { NextRequest, NextResponse } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * SIMULATED — REAL-CHROMIUM JOURNEY OF THE LIVE SHEET (DIGER_STAGE2_LIVE_SHEET in «test» mode). NOT a production test, NOT production acceptance.
 * What is real: the Next app (`next dev`, compiled from this tree), real Chromium (Playwright) at desktop 1280, phone 390 and narrow phone 320, the REAL chat page and request page, the real
 * mission card, live panel, grid, cards and work log, the browser's real fetch and timers; the REAL live route handler (`/api/missions/<id>/live`: viewer, ownership, the «test»-mode marker,
 * newest-snapshot listing, poll contract); snapshots written by the REAL worker code (`createLiveWriter`, `writeDoneSnapshot`, `buildLiveSnapshot`) from the STORED REAL rows of M12
 * (msn_5851abc92a1e6645a9cd, anonymised), and the final file built by the REAL `buildMissionFiles`, so the rows on screen are compared with the rows of the workbook.
 * What is fake: the sign-in service and the tables the pages read (a tiny local http server), storage (in memory), the mission GET answer (the REAL `customerMissionView` over a row this
 * harness moves through plan_ready → approved → executing → completed), and the approval POST (no money: it only moves the row). No network, no provider, no points.
 * Run: `npx vitest run --config scripts/browser-journey/vitest.browser.mts scripts/browser-journey/live-sheet-journey.browser.ts` (not part of the default suite).
 */
const admin = { client: null as unknown };
vi.mock("../../src/lib/supabase/server", () => ({ createAdminClient: () => admin.client, createServerSideClient: vi.fn() }));
vi.mock("../../src/lib/server/missionViewer", async (orig) => {
  const real = await orig<typeof import("../../src/lib/server/missionViewer")>();
  return { ...real, resolveMissionViewer: vi.fn(async (req: NextRequest) => (req.headers.get("authorization") === "Bearer journey.access.token" ? { ok: true, viewer: { userId: ME, isGuest: false, emailVerified: true } } : { ok: false, response: NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 }) })) };
});

import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { createMemoryStore } from "../../agent/src/memoryStore";
import { planByCompiler } from "../../agent/src/compiled";
import { ItemStore, type Op } from "../../agent/src/items/itemStore";
import { buildMissionFiles } from "../../agent/src/workbook";
import { createLiveWriter, writeDoneSnapshot } from "../../agent/src/stage2/liveWriter";
import { missionFactsOf } from "../../agent/src/methodology";
import { reportedPlan, withPromiseCaps, withRepliesJudged } from "../../src/lib/agentMission/repliesCard";
import { customerMissionView } from "../../src/lib/agentMission/customerView";
import { customerPlanView, type PricedPlan } from "../../src/lib/agentMission/plan";
import { NO_ABOUT_OPTIONS_AR } from "../../src/lib/agentMission/foundation/topicChoice";
import { stage2FlagForMission } from "../../src/lib/agentMission/stage2/askEditAction";
import { STAGE2_TEST_MARKER } from "../../src/lib/agentMission/stage2/flags";
import { loadTregCatalog } from "../../src/lib/treg/catalog";
import { replayGateway } from "../../tests/helpers/replayGateway";
import { cellsOf } from "../../tests/helpers/round11Worlds";
import * as liveRoute from "../../src/app/api/missions/[id]/live/route";
import { SUMMARY_SHEET_AR } from "../../src/lib/modelPlanner/missionWorkbook";
import { toArabicDigits } from "../../src/lib/arabicDigits";

const ME = "0b1c2d3e-4f50-4617-8899-aabbccddeeff";
const OTHER = "11111111-2222-4333-8444-555555555555";
const APP = process.env.APP_DIR ?? process.cwd();
const FAKE_PORT = 54399;
const APP_PORT = 3101;
const BASE = `http://127.0.0.1:${APP_PORT}`;
const M12 = "msn_5851abc92a1e6645a9cd";
const REQUEST = "هات فيديوهين تيك توك بالعربي عن الذكاء الاصطناعي من مصر، أكتر فيديوهات عليها تعليقات، و٢٠ تعليق من كل فيديو مع ردودهم";
const USER_JSON = { id: ME, aud: "authenticated", role: "authenticated", email: "journey@example.test", email_confirmed_at: "2026-11-01T00:00:00Z", app_metadata: { provider: "email" }, user_metadata: { name: "عميل الرحلة" }, created_at: "2026-10-01T00:00:00Z" };
type Row = Record<string, unknown>;
const stored = (k: string): Row[] => JSON.parse(readFileSync(`tests/fixtures/live/missions/${M12}/rows/${k}.json`, "utf8"));

// ------------------------------------------------------------------------------------------------ the world: missions, storage, the worker
interface MissionState { id: string; owner: string; status: string; conversation: string; items: ItemStore; writer: ReturnType<typeof createLiveWriter>; clock: number; delivered: number | null }
const files = new Map<string, string>(); // `${missionId}/${path}` → body (the private bucket)
const missions = new Map<string, MissionState>();
let plan: PricedPlan;
const putNew = async (missionId: string, path: string, body: string) => { const k = `${missionId}/${path}`; if (files.has(k)) throw new Error("exists"); files.set(k, body); };
const liveCalls: Array<{ id: string; at: number; status: number; query: string }> = [];
let failLive = 0;
let holdLiveMs = 0;

function fakeAdmin() {
  return {
    from: () => ({ select: () => ({ eq: (_c: string, id: string) => ({ maybeSingle: async () => { const m = missions.get(id); return { data: m ? { id: m.id, user_id: m.owner, addon: null } : null, error: null }; } }) }) }),
    storage: {
      from: () => ({
        list: async (prefix: string, opts?: { limit?: number; sortBy?: { order?: string } }) => {
          const names = [...files.keys()].filter((k) => k.startsWith(`${prefix}/`)).map((k) => k.slice(prefix.length + 1)).filter((n) => !n.includes("/")).sort();
          if (opts?.sortBy?.order === "desc") names.reverse();
          return { data: names.slice(0, opts?.limit ?? 100).map((name) => ({ name })), error: null };
        },
        download: async (p: string) => (files.has(p) ? { data: new Blob([files.get(p)!]), error: null } : { data: null, error: { message: "not found" } }),
      }),
    },
  };
}

async function newMission(id: string, conversation: string, owner = ME, status = "plan_ready"): Promise<MissionState> {
  const items = await ItemStore.open(createMemoryStore(), id);
  const m: MissionState = { id, owner, status, conversation, items, clock: Date.parse("2026-11-06T08:00:00Z"), delivered: null, writer: null as never };
  m.writer = createLiveWriter({ store: { putNew } as never, missionId: id, plan, items, writerId: "w1", now: () => m.clock });
  missions.set(id, m);
  // the worker marks a test account's mission while it plans («test» mode; agent/src/stage2/testMarker.ts)
  if (owner === ME) files.set(`${id}/${STAGE2_TEST_MARKER}`, JSON.stringify({ v: 1 }));
  return m;
}
const op = (stage: string, row: Row): Op => ({ t: "item", stage, id: String(row.id), state: "accepted", by: "rule", row });
/** The worker saves rows (the engine's commit) and emits its progress event: the REAL live writer stores a snapshot (throttled by its own 5 s rule on the mission's clock). */
async function workerSaves(m: MissionState, stage: string, rows: Row[], counts: Record<string, unknown>): Promise<void> {
  if (rows.length) await m.items.commit(rows.map((r) => op(stage, r)));
  m.clock += 6_000;
  await m.writer.addEvent({ kind: "progress", message_ar: "x", counts } as never, async () => undefined);
  await m.writer.flush();
}
async function workerFinishes(m: MissionState): Promise<void> {
  m.clock += 6_000;
  const snap = m.items.snapshotOfMemory();
  const ok = await writeDoneSnapshot({ store: { putNew } as never, missionId: m.id, plan, snap, writerId: "w1", facts: missionFactsOf({ requestText: REQUEST, plan, snap, reviewStop: null }), nowMs: m.clock });
  if (!ok) throw new Error("done snapshot not written");
  m.status = "completed";
  m.delivered = (["videos", "comments", "comments_replies"] as const).reduce((n, k) => n + snap.acceptedRows(k, 10_000).length, 0);
}
/** The file runMission.ts builds at finalize, from the same log (as tests/stage2-live-equality.test.ts builds it). */
async function fileOf(m: MissionState): Promise<Record<string, string[][]>> {
  const snap = m.items.snapshotOfMemory();
  let p = withPromiseCaps(plan);
  const rowsByStage: Record<string, Row[]> = {};
  for (const s of p.stages) rowsByStage[s.key] = snap.acceptedRows(s.key, s.planned_rows);
  p = reportedPlan(p, Object.fromEntries(p.stages.map((s) => [s.key, rowsByStage[s.key].length])));
  const open = p.stages.some((s) => s.replies_open || s.children_open);
  if (open) p = withRepliesJudged(p, rowsByStage, (k) => { const st = snap.stage(k).stop; return !st || st === "source_exhausted"; });
  const built = await buildMissionFiles(p, rowsByStage, missionFactsOf({ requestText: REQUEST, plan: p, snap, reviewStop: null }), undefined, { ...(open ? { repliesJudged: true } : {}), approvedPlan: plan });
  return cellsOf(built.xlsx);
}

function missionAnswer(m: MissionState) {
  const row = { id: m.id, status: m.status, question_ar: null, plan_public: customerPlanView(plan), reserved_points: 450, unit_price_points: 1, delivered_units: m.delivered, charged_points: m.delivered, summary_ar: m.status === "completed" ? "تم تسليم طلبك." : null, files: m.status === "completed" ? [{ name: "result.xlsx", kind: "xlsx" }] : null, created_at: "2026-11-06T07:59:00Z" };
  return customerMissionView({ mission: row as never, events: [] as never, queue: { ahead: 0, running: 0, workerAlive: true }, now: m.clock });
}

// ------------------------------------------------------------------------------------------------ the fake sign-in service and tables
let fake: http.Server;
function startFake(): Promise<void> {
  fake = http.createServer((req, res) => {
    const cors = { "access-control-allow-origin": req.headers.origin ?? "*", "access-control-allow-credentials": "true", "access-control-allow-headers": "authorization,apikey,content-type,x-client-info,accept,accept-profile,prefer,range,x-supabase-api-version", "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS" };
    if (req.method === "OPTIONS") { res.writeHead(204, cors); res.end(); return; }
    const url = decodeURIComponent(req.url ?? "");
    const one = String(req.headers.accept).includes("pgrst.object");
    const json = (status: number, body: unknown) => { res.writeHead(status, { ...cors, "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    const none = () => (one ? json(406, { code: "PGRST116", details: "The result contains 0 rows", hint: null, message: "JSON object requested, multiple (or no) rows returned" }) : json(200, []));
    if (url.startsWith("/auth/v1/user")) return json(200, USER_JSON);
    if (url.startsWith("/rest/v1/profiles")) { const p = { id: ME, full_name: "عميل الرحلة", credits: 5000, role: "user" }; return one ? json(200, p) : json(200, [p]); }
    if (url.startsWith("/rest/v1/missions")) {
      const m = [...missions.values()].find((x) => url.includes(x.id) && x.owner === ME);
      if (!m) return none();
      const r = { id: m.id, job_id: null, status: m.status, delivered_units: m.delivered, charged_points: m.delivered, reserved_points: 450, created_at: "2026-11-06T07:59:00Z", request_text: REQUEST };
      return one ? json(200, r) : json(200, [r]);
    }
    if (url.startsWith("/rest/v1/conversations")) {
      const m = [...missions.values()].find((x) => url.includes(x.conversation));
      const c = m ? { id: m.conversation, user_id: ME, title: "فيديوهات الذكاء الاصطناعي", updated_at: "2026-11-06T08:00:00Z", created_at: "2026-11-06T07:58:00Z" } : null;
      return one ? (c ? json(200, c) : none()) : json(200, c ? [c] : []);
    }
    if (url.startsWith("/rest/v1/messages")) {
      const m = [...missions.values()].find((x) => url.includes(x.conversation));
      if (!m) return json(200, []);
      return json(200, [
        { id: `${m.conversation}_u`, conversation_id: m.conversation, user_id: ME, role: "user", content: REQUEST, status: "done", created_at: "2026-11-06T07:58:00Z" },
        { id: `${m.conversation}_a`, conversation_id: m.conversation, user_id: ME, role: "assistant", content: "جهزنا لك خطة المهمة.", status: "done", plan: { agentMissionId: m.id }, created_at: "2026-11-06T07:59:00Z" },
      ]);
    }
    return none();
  });
  return new Promise((r) => fake.listen(FAKE_PORT, "127.0.0.1", () => r()));
}

// ------------------------------------------------------------------------------------------------ the browser: every /api answer
async function mount(ctx: BrowserContext) {
  await ctx.route("**/api/**", async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    const live = /^\/api\/missions\/([^/]+)\/live$/.exec(u.pathname);
    const card = /^\/api\/missions\/([^/]+)$/.exec(u.pathname);
    if (live) {
      if (holdLiveMs > 0) await new Promise((r) => setTimeout(r, holdLiveMs));
      if (failLive > 0) { failLive -= 1; liveCalls.push({ id: live[1], at: Date.now(), status: 503, query: u.search }); return route.fulfill({ status: 503, contentType: "text/plain", body: "upstream unavailable" }); }
      const res: Response = await liveRoute.GET(new NextRequest(u.toString(), { headers: req.headers() }), { params: Promise.resolve({ id: live[1] }) });
      liveCalls.push({ id: live[1], at: Date.now(), status: res.status, query: u.search });
      const headers: Record<string, string> = {}; res.headers.forEach((v, k) => { headers[k] = v; });
      return route.fulfill({ status: res.status, headers, body: Buffer.from(await res.arrayBuffer()) });
    }
    if (card && missions.has(card[1])) {
      const m = missions.get(card[1])!;
      if (req.headers()["authorization"] !== "Bearer journey.access.token" || m.owner !== ME) return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ success: false, error: "not_found" }) });
      if (req.method() === "POST") {
        const body = JSON.parse(req.postData() ?? "{}");
        if (body.action === "approve" && m.status === "plan_ready") { m.status = "approved"; return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ success: true }) }); }
        return route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ success: false, error: "لا يمكن الآن." }) });
      }
      const liveSheet = await stage2FlagForMission(admin.client, "DIGER_STAGE2_LIVE_SHEET", m.id);
      return route.fulfill({ status: 200, contentType: "application/json", headers: { "cache-control": "no-store" }, body: JSON.stringify({ success: true, isGuest: false, status: m.status, requestText: REQUEST, view: missionAnswer(m), ...(liveSheet ? { liveSheet: true } : {}) }) });
    }
    return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ success: false, error: "not_found" }) });
  });
}

type Kind = "desktop" | "phone" | "narrow";
let browser: Browser;
let app: ChildProcess;
async function newPage(kind: Kind): Promise<{ ctx: BrowserContext; page: Page; errors: string[] }> {
  const ctx = await browser.newContext(kind === "desktop" ? { viewport: { width: 1280, height: 900 }, locale: "ar-EG" } : kind === "narrow" ? { viewport: { width: 320, height: 640 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, locale: "ar-EG" } : { viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, locale: "ar-EG", userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1" });
  const session64 = Buffer.from(JSON.stringify({ access_token: "journey.access.token", refresh_token: "journey-refresh", expires_at: Math.floor(Date.now() / 1000) + 86_400, expires_in: 86_400, token_type: "bearer", user: USER_JSON })).toString("base64url");
  await ctx.addCookies([{ name: "sb-127-auth-token", value: `base64-${session64}`, url: BASE }]);
  await mount(ctx);
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e.message).slice(0, 200)));
  return { ctx, page, errors };
}

/** Layout probe (real Chromium): no horizontal page scroll, RTL document, and no visible element pushed outside the viewport (tables inside their own scroll box excepted). */
async function layoutProblems(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const de = document.documentElement;
    if (de.dir !== "rtl") out.push(`dir=${de.dir}`);
    if (de.scrollWidth > de.clientWidth + 1) out.push(`page scrolls sideways: ${de.scrollWidth} > ${de.clientWidth}`);
    const vw = de.clientWidth;
    let n = 0;
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("[data-testid='agent-live'] *"))) {
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      let p: HTMLElement | null = el.parentElement, inScroll = false;
      while (p && p !== document.body) { const o = getComputedStyle(p).overflowX; if (o === "auto" || o === "scroll") { inScroll = true; break; } p = p.parentElement; }
      if (inScroll) continue;
      if (r.right > vw + 1 || r.left < -1) { if (n++ < 5) out.push(`${el.tagName.toLowerCase()}${el.dataset.testid ? `[${el.dataset.testid}]` : ""} "${(el.innerText || "").slice(0, 30).replace(/\s+/g, " ")}" ${Math.round(r.left)}..${Math.round(r.right)} of ${vw}`); }
    }
    return out;
  });
}
async function waitFor(url: string, ms = 240_000) { const end = Date.now() + ms; for (;;) { try { const r = await fetch(url); if (r.status < 500) return; } catch { /* not yet */ } if (Date.now() > end) throw new Error(`server did not start: ${url}`); await new Promise((r) => setTimeout(r, 1000)); } }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The rows shown now: desktop grid ids (the «المعرّف» cells) or phone card ids (from «كل الحقول»). */
async function shownIds(page: Page, kind: Kind): Promise<string[]> {
  if (kind === "desktop") return page.$$eval("[data-testid='agent-live'] [data-testid='live-grid-row']", (trs) => trs.map((tr) => { const tds = Array.from(tr.querySelectorAll("td")); const head = Array.from(tr.closest("table")!.querySelectorAll("th")).map((th) => th.textContent); return (tds[head.indexOf("المعرّف")]?.textContent ?? "").trim(); }));
  return page.$$eval("[data-testid='agent-live'] [data-testid='live-card']", (cards) => cards.map((c) => { const dts = Array.from(c.querySelectorAll("dt")); const i = dts.findIndex((d) => d.textContent === "المعرّف"); return i >= 0 ? (c.querySelectorAll("dd")[i]?.textContent ?? "").trim() : ""; }));
}
async function shownCells(page: Page): Promise<string[][]> {
  return page.$$eval("[data-testid='agent-live'] [data-testid='live-grid-row']", (trs) => trs.map((tr) => Array.from(tr.querySelectorAll("td")).map((td) => (td.textContent ?? "").trim())));
}
const visible = (page: Page, testid: string) => page.locator(`[data-testid='agent-live'] [data-testid='${testid}']:visible`);
const results: Array<{ viewport: string; page: string; check: string; ok: boolean; note?: string; evidence: "SIMULATED" }> = [];
async function check(viewport: string, where: string, name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ viewport, page: where, check: name, ok: true, evidence: "SIMULATED" }); } catch (e) { results.push({ viewport, page: where, check: name, ok: false, note: String((e as Error).message).split("\n")[0].slice(0, 240), evidence: "SIMULATED" }); throw e; }
}

beforeAll(async () => {
  vi.stubEnv("DIGER_STAGE2_LIVE_SHEET", "test");
  admin.client = fakeAdmin();
  const store = createMemoryStore();
  const { gateway } = replayGateway(M12, loadTregCatalog(), store, "msn_journey_plan");
  const planned = await planByCompiler({ mission: { id: "msn_journey_plan", request_text: REQUEST, answer_text: NO_ABOUT_OPTIONS_AR.useAsIs, created_at: "2026-11-02T11:35:00Z" }, gateway, store, catalog: loadTregCatalog(), nowMs: Date.parse("2026-11-02T11:36:00Z") });
  if (planned.kind !== "plan") throw new Error(planned.kind);
  plan = planned.plan;
  await startFake();
  app = spawn("npx", ["next", "dev", "-p", String(APP_PORT), "-H", "127.0.0.1"], { cwd: APP, env: { ...process.env, NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${FAKE_PORT}`, NEXT_PUBLIC_SUPABASE_ANON_KEY: "dummy-anon-key", SUPABASE_SERVICE_ROLE_KEY: "dummy-service-key", PORT: String(APP_PORT), NEXT_TELEMETRY_DISABLED: "1" }, stdio: "pipe" });
  await waitFor(`${BASE}/login`);
  browser = await chromium.launch();
  // compile the two pages once (dev mode compiles on first visit)
  const warm = await browser.newPage();
  for (const p of ["/dashboard/chat", "/dashboard/requests/msn_warmup0000000001"]) await warm.goto(`${BASE}${p}`, { waitUntil: "load", timeout: 240_000 }).catch(() => undefined);
  await warm.close();
}, 600_000);
afterAll(async () => {
  writeFileSync(process.env.JOURNEY_OUT ?? "live-sheet-journey-results.json", JSON.stringify({ evidence: "SIMULATED (real Chromium, local app, fake sign-in, real live route and worker snapshot code, stored M12 rows); NOT production", results }, null, 1));
  await browser?.close(); app?.kill("SIGTERM"); await new Promise((r) => fake?.close(() => r(null))); vi.unstubAllEnvs();
});

const KINDS: Kind[] = ["desktop", "phone", "narrow"];
const videos = stored("videos");
const comments = stored("comments");
const replies = stored("comments_replies");

describe("SIMULATED live sheet journey (real Chromium; NOT production)", () => {
  for (const kind of KINDS) {
    it(`${kind}: conversation → approval → rows arrive → pages/sheets → failures → hidden tab → final = file; request page: navigation, reload, fast mission, ownership`, async () => {
      const id = `msn_journey${kind}00000001`.slice(0, 30);
      const conv = `conv_${kind}`;
      const m = await newMission(id, conv);
      const { ctx, page, errors } = await newPage(kind);
      const callsOf = () => liveCalls.filter((c) => c.id === id);

      // 1. BEFORE APPROVAL: the plan card, no live sheet, and the live route is never asked
      await page.goto(`${BASE}/dashboard/chat?c=${conv}`, { waitUntil: "load", timeout: 240_000 });
      await check(kind, "chat", "1 before approval: plan card, no live sheet, no live request", async () => {
        await page.locator("[data-testid='agent-card'][data-phase='plan']").first().waitFor({ timeout: 60_000 });
        await sleep(3000);
        expect(await page.locator("[data-testid='agent-live']").count()).toBe(0);
        expect(callsOf()).toHaveLength(0);
      });

      // 2. IMMEDIATELY AFTER APPROVAL: the panel appears, the route answers «no snapshot yet»: one waiting line, no table, no number
      await check(kind, "chat", "2 after approval: waiting line, nothing invented", async () => {
        await page.getByRole("button", { name: "اعتمد" }).first().click();
        await visible(page, "live-waiting").waitFor({ timeout: 30_000 });
        expect(await page.locator("[data-testid='agent-live'] table").count()).toBe(0);
        expect(callsOf().every((c) => c.status === 200)).toBe(true);
      });
      // the waiting state lasts longer than three polls: the loop does not give up while the mission works
      await sleep(16_000);
      await check(kind, "chat", "2b still asking while the mission works and has no snapshot", async () => {
        expect(callsOf().length).toBeGreaterThanOrEqual(3);
        await visible(page, "live-waiting").waitFor({ timeout: 5_000 });
      });

      // 3. ZERO ROWS: the worker read a page and saved nothing yet (a real snapshot with no rows)
      m.status = "executing";
      await workerSaves(m, "videos", [], { pages: 1 });
      await check(kind, "chat", "3 zero rows: the counter says ٠ of the promised total", async () => {
        const counter = kind === "desktop" ? visible(page, "live-grid-counter") : visible(page, "live-counter");
        await counter.waitFor({ timeout: 40_000 });
        expect(await counter.innerText()).toContain("٠");
        expect(await shownIds(page, kind)).toEqual([]);
      });

      // 4. FIRST ROW
      await workerSaves(m, "videos", videos.slice(0, 1), { stage: 1, saved: 1, planned: 2 });
      await check(kind, "chat", "4 first row: exactly the stored video", async () => {
        await expect.poll(() => shownIds(page, kind), { timeout: 40_000, interval: 1000 }).toEqual([String(videos[0].id)]);
      });

      // 5. SEVERAL ROWS (both videos, then the comments and their replies: the thread sheet passes 100 rows)
      await workerSaves(m, "videos", videos.slice(1, 2), { stage: 1, saved: 2, planned: 2 });
      await workerSaves(m, "comments", comments, { stage: 2, saved: comments.length, planned: 40 });
      await workerSaves(m, "comments_replies", replies, { stage: 3, saved: replies.length, planned: 30 });
      await check(kind, "chat", "5 several rows: the videos sheet shows both stored videos; the work-log line is the newest event", async () => {
        await expect.poll(() => shownIds(page, kind), { timeout: 40_000, interval: 1000 }).toEqual(videos.slice(0, 2).map((v) => String(v.id)));
        await expect.poll(async () => (await visible(page, "live-work-latest").innerText()), { timeout: 40_000 }).toContain("أضفنا");
      });

      // 6. PAGINATION AND SHEET SWITCHING
      await check(kind, "chat", "6 sheet switch and next page: the comments in the stored order", async () => {
        await page.locator("[data-testid='agent-live'] [role='tab']:visible").nth(1).click();
        const firstPage = await (async () => { await expect.poll(async () => (await shownIds(page, kind)).length, { timeout: 30_000, interval: 500 }).toBe(50); return shownIds(page, kind); })();
        const all = JSON.parse(files.get([...files.keys()].filter((k) => k.startsWith(`${id}/live/`)).sort().at(-1)!)!).sheets.find((s: { stageKey: string }) => s.stageKey === "comments").rows.map((r: { id: string }) => r.id);
        expect(firstPage).toEqual(all.slice(0, 50));
        await page.locator("[data-testid='agent-live'] button:visible").filter({ hasText: kind === "desktop" ? "التالي" : "عرض المزيد" }).first().click();
        await expect.poll(() => shownIds(page, kind), { timeout: 30_000, interval: 500 }).toEqual(all.slice(50, 100));
        if (kind === "desktop") {
          const cells = await shownCells(page);
          expect(cells.every((r) => r.length >= 2)).toBe(true);
        } else {
          const more = page.locator("[data-testid='agent-live'] [data-testid='live-card-more']:visible").first();
          await more.locator("summary").click();
          expect(await more.locator("[data-testid='live-card-rest']").innerText()).toContain("المعرّف");
        }
        expect(await layoutProblems(page)).toEqual([]);
        // back to the first page for the rest of the journey
        await page.locator("[data-testid='agent-live'] [role='tab']:visible").nth(0).click();
        await expect.poll(async () => (await shownIds(page, kind)).length, { timeout: 30_000 }).toBe(2);
      });

      // 11. TEMPORARY NETWORK FAILURE: three 503s; the rows stay, the line says it will try again, then the next answer arrives
      await check(kind, "chat", "11 temporary failure: rows kept, reconnect line, then recovery", async () => {
        failLive = 3;
        // the next news the worker has: a page read (a new work-log line, a new cursor)
        await workerSaves(m, "videos", [], { pages: 4 });
        await visible(page, "live-reconnect").waitFor({ timeout: 60_000 });
        expect((await shownIds(page, kind)).length).toBe(2);
        await expect.poll(() => visible(page, "live-reconnect").count(), { timeout: 90_000, interval: 1000 }).toBe(0);
        expect(callsOf().some((c) => c.status === 503)).toBe(true);
      });

      // 12. HIDDEN TAB: no live request while hidden; one at once when visible again
      await check(kind, "chat", "12 hidden tab asks nothing; restored tab asks at once", async () => {
        await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" }); document.dispatchEvent(new Event("visibilitychange")); });
        await sleep(6_000);
        const before = callsOf().length;
        await sleep(20_000);
        expect(callsOf().length).toBe(before);
        await page.evaluate(() => { Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" }); document.dispatchEvent(new Event("visibilitychange")); });
        await expect.poll(() => callsOf().length, { timeout: 5_000, interval: 250 }).toBeGreaterThan(before);
      });

      // 7/8. COMPLETION: the done snapshot; the final rows ARE the file's rows; polling stops
      await workerFinishes(m);
      const file = await fileOf(m);
      await check(kind, "chat", "8 final result: titled final, said to be the file's data, rows = the workbook's rows", async () => {
        await visible(page, "live-final").waitFor({ timeout: 60_000 });
        const videoSheet = Object.keys(file).filter((n) => n !== SUMMARY_SHEET_AR)[0];
        const [head, ...body] = file[videoSheet];
        expect(await shownIds(page, kind)).toEqual(body.map((r) => r[head.indexOf("المعرّف")]));
        if (kind === "desktop") {
          // every rendered cell is the workbook's cell: the same text, or the same number in Arabic-Indic digits; a date cell shows the file's Cairo text of the same instant (checked by the equality test)
          const cells = await shownCells(page);
          expect(cells).toHaveLength(body.length);
          cells.forEach((r, i) => r.forEach((text, k) => {
            const want = body[i][k] ?? "";
            if (/^\d{4}-\d{2}-\d{2}T/.test(want)) { expect(text.length, `${head[k]} row ${i + 1}`).toBeGreaterThan(0); return; }
            expect([want, toArabicDigits(want)], `${head[k]} row ${i + 1}`).toContain(text);
          }));
        }
        expect(await visible(page, "live-work-latest").innerText()).toContain("الملف جاهز للتنزيل");
        const n = callsOf().length;
        await sleep(15_000);
        expect(callsOf().length).toBe(n);
        expect(await layoutProblems(page)).toEqual([]);
      });

      // 9. RETURNING AFTER NAVIGATION: to the request page and back (client navigation): the final sheet is there at once, before any new answer
      await check(kind, "requests", "9 request page shows the same final sheet; back to the chat shows it at once", async () => {
        await page.goto(`${BASE}/dashboard/requests/${id}`, { waitUntil: "load", timeout: 240_000 });
        await visible(page, "live-final").waitFor({ timeout: 60_000 });
        expect(await shownIds(page, kind)).toEqual(videos.slice(0, 2).map((v) => String(v.id)));
        // client navigation (no reload): to «طلباتي» and back; the live route is slowed to 8 s, so a sheet visible within 5 s comes from what the tab already held, not from a new answer
        await page.getByTestId("details-back").click();
        await page.waitForURL(/\/dashboard\/requests$/, { timeout: 60_000 });
        holdLiveMs = 8_000;
        const t0 = Date.now();
        await page.goBack();
        await visible(page, "live-final").waitFor({ timeout: 5_000 });
        expect(Date.now() - t0).toBeLessThan(8_000);
        expect(await shownIds(page, kind)).toEqual(videos.slice(0, 2).map((v) => String(v.id)));
        await sleep(9_000);
        holdLiveMs = 0;
        expect(await layoutProblems(page)).toEqual([]);
      });

      // 10. RELOAD
      await check(kind, "requests", "10 reload: the final sheet again from the route", async () => {
        await page.goto(`${BASE}/dashboard/requests/${id}`, { waitUntil: "load" });
        await page.reload({ waitUntil: "load" });
        await visible(page, "live-final").waitFor({ timeout: 60_000 });
        expect(await shownIds(page, kind)).toEqual(videos.slice(0, 2).map((v) => String(v.id)));
      });

      // 7. FAST MISSION: finished before the first poll; the request page shows the final sheet, never a «so far» title, one live request in all
      const fastId = `msn_fast${kind}000000000001`.slice(0, 30);
      const fast = await newMission(fastId, `conv_fast_${kind}`, ME, "approved");
      await fast.items.commit([...videos.slice(0, 2).map((r) => op("videos", r)), ...comments.slice(0, 5).map((r) => op("comments", r))]);
      await workerFinishes(fast);
      await check(kind, "requests", "7 fast mission: final at once, one request, no progressive claim", async () => {
        await page.goto(`${BASE}/dashboard/requests/${fastId}`, { waitUntil: "load" });
        await visible(page, "live-final").waitFor({ timeout: 60_000 });
        expect(await page.locator("[data-testid='agent-live']").innerText()).not.toContain("ما جمعناه حتى الآن");
        await sleep(12_000);
        // ONE ask per mount: `next dev` runs React StrictMode, which mounts every effect twice (mount, unmount, mount), so up to two asks land in the first moment and none after the done answer
        const calls = liveCalls.filter((c) => c.id === fastId);
        expect(calls.length).toBeGreaterThanOrEqual(1);
        expect(calls.length).toBeLessThanOrEqual(2);
        expect(calls.at(-1)!.at - calls[0].at).toBeLessThan(3_000);
      });
      await check(kind, "chat", "7b fast mission in the conversation: the same final sheet", async () => {
        await page.goto(`${BASE}/dashboard/chat?c=conv_fast_${kind}`, { waitUntil: "load" });
        await visible(page, "live-final").waitFor({ timeout: 60_000 });
        expect(await shownIds(page, kind)).toEqual(videos.slice(0, 2).map((v) => String(v.id)));
        expect(await layoutProblems(page)).toEqual([]);
      });

      // OWNERSHIP: another customer's mission (no marker, not this viewer): the live route answers 404, nothing is drawn
      const foreign = `msn_foreign${kind}0000000001`.slice(0, 30);
      await newMission(foreign, `conv_foreign_${kind}`, OTHER, "executing");
      await check(kind, "api", "ownership: another customer's mission is not found", async () => {
        const status = await page.evaluate(async (fid) => (await fetch(`/api/missions/${fid}/live`, { headers: { Authorization: "Bearer journey.access.token" } })).status, foreign);
        expect(status).toBe(404);
        const anon = await page.evaluate(async (mid) => (await fetch(`/api/missions/${mid}/live`)).status, id);
        expect(anon).toBe(401);
      });
      await check(kind, "all", "no uncaught page error", async () => { expect(errors).toEqual([]); });
      await ctx.close();
    }, 900_000);
  }
});
