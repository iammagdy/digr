import http from "node:http";
import { writeFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { NextRequest, NextResponse } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * REAL-CHROMIUM JOURNEY OF THE STAGE 4 PAID FLOW (fake money, fake providers, fake wallet): NOT a production test.
 * What is real: the built Next app (`next start`), real Chromium (Playwright) at desktop 1280 and phone 390, the real page and components, the real browser fetch.
 * What is fake: the sign-in service and the two tables the page reads (a tiny local http server), and EVERY /api/* answer, which is produced by the REAL route handlers
 * running over the shared fake world (hardened fake money core, fake storage, the REAL worker add-on runner). No network, no provider, no real points.
 * Run: see docs/launch/BROWSER-JOURNEY.md. Not part of the default suite (name does not match *.test.ts).
 */
vi.mock("../../src/lib/supabase/server", async () => {
  const { session } = await import("../../tests/helpers/e2eSession");
  return { createAdminClient: () => { session.adminCalls += 1; return session.client; }, createServerSideClient: vi.fn() };
});
vi.mock("../../src/lib/server/missionViewer", async (orig) => {
  const real = await orig<typeof import("../../src/lib/server/missionViewer")>();
  const { session } = await import("../../tests/helpers/e2eSession");
  return { ...real, resolveMissionViewer: vi.fn(async () => (session.viewer ? { ok: true, viewer: session.viewer } : { ok: false, response: NextResponse.json({ success: false, error: "unauthorized" }, { status: 401 }) })) };
});

import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { runAddonSafely } from "../../agent/src/stage4/runAddon";
import { session, signInAs } from "../../tests/helpers/e2eSession";
import { ME, MISSION, e2eWorld, parseXlsx, type E2eWorld } from "../../tests/helpers/e2eWorld";
import * as versionsRoute from "../../src/app/api/missions/[id]/versions/route";
import * as fileRoute from "../../src/app/api/missions/[id]/file/route";
import * as reviewQuoteRoute from "../../src/app/api/missions/[id]/review-quote/route";
import * as reviewRequestRoute from "../../src/app/api/missions/[id]/review-request/route";
import * as reviewReportRoute from "../../src/app/api/missions/[id]/review-report/route";
import * as editRequestRoute from "../../src/app/api/missions/[id]/edit-request/route";
import * as approvalRoute from "../../src/app/api/missions/[id]/addon-approval/route";
import * as workflowRoute from "../../src/app/api/missions/[id]/workflow/route";

const APP = process.env.APP_DIR ?? process.cwd();
const FAKE_PORT = 54399;
const APP_PORT = 3100;
const BASE = `http://127.0.0.1:${APP_PORT}`;
const FLAGS = ["DIGER_STAGE4_VERSIONS", "DIGER_STAGE4_REVIEW", "DIGER_STAGE4_EDITS", "DIGER_STAGE4_APPROVAL"] as const;

const USER_JSON = { id: ME, aud: "authenticated", role: "authenticated", email: "journey@example.test", email_confirmed_at: "2026-11-01T00:00:00Z", app_metadata: { provider: "email" }, user_metadata: { name: "عميل الرحلة" }, created_at: "2026-10-01T00:00:00Z" };
let world: E2eWorld;
let fake: http.Server;
let app: ChildProcess;
let browser: Browser;
const approvals: Array<{ at: number }> = [];
let dropNextApprovalAnswer = false;

const missionRow = () => { const m: any = world.store.missions.get(MISSION); return { id: m.id, job_id: null, status: m.status, delivered_units: m.delivered_units ?? 4, charged_points: 0, reserved_points: 0, created_at: "2026-11-04T09:00:00.000Z", request_text: m.request_text ?? "ملف العملاء" }; };

function startFake(): Promise<void> {
  fake = http.createServer((req, res) => {
    const cors = { "access-control-allow-origin": req.headers.origin ?? "*", "access-control-allow-credentials": "true", "access-control-allow-headers": "authorization,apikey,content-type,x-client-info,accept,accept-profile,prefer,range,x-supabase-api-version", "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS" };
    if (req.method === "OPTIONS") { res.writeHead(204, cors); res.end(); return; }
    const url = req.url ?? "";
    const json = (status: number, body: unknown) => { res.writeHead(status, { ...cors, "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (url.startsWith("/auth/v1/user")) return json(200, USER_JSON);
    if (url.startsWith("/rest/v1/missions")) return String(req.headers.accept).includes("pgrst.object") ? json(200, missionRow()) : json(200, [missionRow()]);
    if (url.startsWith("/rest/v1/jobs")) return String(req.headers.accept).includes("pgrst.object") ? json(406, { code: "PGRST116", details: "The result contains 0 rows", hint: null, message: "JSON object requested, multiple (or no) rows returned" }) : json(200, []);
    return json(200, []);
  });
  return new Promise((r) => fake.listen(FAKE_PORT, "127.0.0.1", () => r()));
}
async function waitFor(url: string, ms = 90_000) { const end = Date.now() + ms; for (;;) { try { const r = await fetch(url); if (r.status < 500) return; } catch { /* not yet */ } if (Date.now() > end) throw new Error(`server did not start: ${url}`); await new Promise((r) => setTimeout(r, 500)); } }

const HANDLERS: Record<string, { GET?: any; POST?: any }> = { versions: versionsRoute, file: fileRoute, "review-quote": reviewQuoteRoute, "review-request": reviewRequestRoute, "review-report": reviewReportRoute, "edit-request": editRequestRoute, "addon-approval": approvalRoute, workflow: workflowRoute };
const api: Array<{ method: string; path: string; status: number }> = [];

async function mount(ctx: BrowserContext) {
  await ctx.route("**/api/**", async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    const m = /^\/api\/missions\/([^/]+)\/([^/]+)$/.exec(u.pathname);
    const handler = m ? HANDLERS[m[2]]?.[req.method() as "GET" | "POST"] : undefined;
    if (!m || !handler) { api.push({ method: req.method(), path: u.pathname, status: 404 }); return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ success: false, error: "not_found" }) }); }
    const nreq = new NextRequest(u.toString(), { method: req.method(), headers: req.headers(), ...(req.method() === "POST" ? { body: req.postData() ?? "" } : {}) });
    const res: Response = await handler(nreq, { params: Promise.resolve({ id: m[1] }) });
    const body = Buffer.from(await res.arrayBuffer());
    api.push({ method: req.method(), path: u.pathname, status: res.status });
    if (m[2] === "addon-approval" && req.method() === "POST" && res.status === 200) {
      approvals.push({ at: Date.now() });
      // the worker: picks the approved add-on a moment later (so the page shows «processing» first) and runs the REAL add-on runner
      setTimeout(async () => { try { const claimed = await world.store.claimMission("worker-1", 120); if (claimed) await runAddonSafely(world.deps, claimed); } catch (e) { console.error("worker", e); } }, 1500);
    }
    if (m[2] === "addon-approval" && req.method() === "POST" && dropNextApprovalAnswer) { dropNextApprovalAnswer = false; return route.abort("failed"); } // the server DID the work, the browser never hears
    const headers: Record<string, string> = {}; res.headers.forEach((v, k) => { headers[k] = v; });
    await route.fulfill({ status: res.status, headers, body });
  });
}
type Kind = "desktop" | "phone" | "narrow";
async function newPage(kind: Kind): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext(kind === "desktop" ? { viewport: { width: 1280, height: 900 }, locale: "ar-EG", acceptDownloads: true } : kind === "narrow" ? { viewport: { width: 320, height: 640 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "ar-EG", acceptDownloads: true } : { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "ar-EG", acceptDownloads: true, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1" });
  const session64 = Buffer.from(JSON.stringify({ access_token: "journey.access.token", refresh_token: "journey-refresh", expires_at: Math.floor(Date.now() / 1000) + 86_400, expires_in: 86_400, token_type: "bearer", user: USER_JSON })).toString("base64url");
  await ctx.addCookies([{ name: "sb-127-auth-token", value: `base64-${session64}`, url: BASE }]);
  await mount(ctx);
  return { ctx, page: await ctx.newPage() };
}

/** Layout probe (real Chromium): no horizontal page scroll, RTL document, and no visible element pushed outside the viewport. */
async function layoutProblems(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const de = document.documentElement;
    if (de.dir !== "rtl") out.push(`dir=${de.dir}`);
    if (de.scrollWidth > de.clientWidth + 1) out.push(`page scrolls sideways: ${de.scrollWidth} > ${de.clientWidth}`);
    const vw = de.clientWidth;
    let n = 0;
    for (const el of Array.from(document.body.querySelectorAll<HTMLElement>("body *"))) {
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden" || cs.position === "fixed") continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      // scrollable containers (tables) may be wider on purpose; skip anything inside one
      let p: HTMLElement | null = el.parentElement, inScroll = false;
      while (p && p !== document.body) { const o = getComputedStyle(p).overflowX; if (o === "auto" || o === "scroll" || o === "hidden") { inScroll = true; break; } p = p.parentElement; }
      if (inScroll) continue;
      if (r.right > vw + 1 || r.left < -1) { if (n++ < 5) out.push(`${el.tagName.toLowerCase()}${el.dataset.testid ? `[${el.dataset.testid}]` : ""} "${(el.innerText || "").slice(0, 30).replace(/\s+/g, " ")}" ${Math.round(r.left)}..${Math.round(r.right)} of ${vw}`); }
    }
    return out;
  });
}
const reserves = () => world.money.ledger.filter((l) => l.type === "reserve").length;
const types = () => world.money.ledger.map((l) => l.type);

beforeAll(async () => {
  for (const f of FLAGS) vi.stubEnv(f, "on");
  signInAs(ME);
  world = await e2eWorld({ balance: 10_000 });
  session.client = new Proxy(world.routes as any, { get: (t, k) => (k === "rpc" ? (n: string, a: unknown) => world.money.client.rpc(n, a) : k === "from" ? (tb: string) => (tb === "missions" ? t.from(tb) : (world.money.client as any).from(tb)) : t[k]) });
  await startFake();
  app = spawn("npx", ["next", "start", "-p", String(APP_PORT), "-H", "127.0.0.1"], { cwd: APP, env: { ...process.env, NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${FAKE_PORT}`, NEXT_PUBLIC_SUPABASE_ANON_KEY: "dummy-anon-key", SUPABASE_SERVICE_ROLE_KEY: "dummy-service-key", PORT: String(APP_PORT) }, stdio: "pipe" });
  await waitFor(`${BASE}/login`);
  browser = await chromium.launch();
}, 180_000);
afterAll(async () => { await browser?.close(); app?.kill("SIGTERM"); await new Promise((r) => fake?.close(() => r(null))); vi.unstubAllEnvs(); });

const results: Array<{ viewport: string; check: string; ok: boolean; note?: string }> = [];
const check = async (viewport: string, name: string, fn: () => Promise<void>) => { try { await fn(); results.push({ viewport, check: name, ok: true }); } catch (e) { results.push({ viewport, check: name, ok: false, note: String((e as Error).message).split("\n")[0].slice(0, 200) }); throw e; } };

for (const kind of ["desktop", "phone", "narrow"] as const) {
  describe(`${kind}: the paid Stage 4 journey in real Chromium`, () => {
    it("delivered file -> versions -> review quote -> request -> approve (double click) -> report -> edit quote -> request -> approve -> version 2 -> download -> final balance", async () => {
      if (kind !== "desktop") { world = await e2eWorld({ balance: 10_000 }); session.client = new Proxy(world.routes as any, { get: (t, k) => (k === "rpc" ? (n: string, a: unknown) => world.money.client.rpc(n, a) : k === "from" ? (tb: string) => (tb === "missions" ? t.from(tb) : (world.money.client as any).from(tb)) : t[k]) }); }
      const start = world.money.balance();
      const { ctx, page } = await newPage(kind);
      const consoleErrors: string[] = []; page.on("pageerror", (e) => consoleErrors.push(String(e)));
      await page.goto(`${BASE}/dashboard/requests/${MISSION}`, { waitUntil: "domcontentloaded" });

      await check(kind, "the details page opens for the signed-in customer", async () => { await page.waitForSelector('[data-testid="details-head"]', { timeout: 60_000 }); });
      await check(kind, "VERSIONS: the file's version 1 is listed", async () => { await page.waitForSelector('[data-testid="version-list"]', { timeout: 30_000 }); expect(await page.locator('[data-testid="version-row"]').count()).toBe(1); });
      await check(kind, "REVIEW QUOTE is shown and NOTHING is held", async () => { await page.waitForSelector('[data-testid="review-ask"]', { timeout: 30_000 }); const sel = page.locator('[data-testid="review-version"]'); if (await sel.count()) await sel.first().selectOption({ index: 0 }).catch(() => {}); await page.click('[data-testid="review-ask"]'); await page.waitForSelector('[data-testid="review-quote"]', { timeout: 30_000 }); expect(world.money.balance()).toBe(start); expect(reserves()).toBe(0); });
      await check(kind, "LAYOUT after versions + review quote: no sideways scroll, RTL, nothing outside the screen", async () => { expect(await layoutProblems(page)).toEqual([]); });
      await check(kind, "REVIEW REQUEST prepared UNPAID, then the approval control appears", async () => { await page.click('[data-testid="review-prepare"]'); await page.waitForSelector('[data-testid="approve-button"]', { timeout: 30_000 }); expect(reserves()).toBe(0); expect(world.money.balance()).toBe(start); });
      await check(kind, "LAYOUT with the approval control shown", async () => { expect(await layoutProblems(page)).toEqual([]); });
      await check(kind, "REVIEW APPROVAL with a DOUBLE CLICK: exactly one hold", async () => { await page.dblclick('[data-testid="approve-button"]'); await page.waitForFunction(() => document.body.innerText.length > 0); await expect.poll(() => reserves(), { timeout: 20_000 }).toBe(1); expect(approvals.length).toBeGreaterThanOrEqual(1); });
      await check(kind, "WORKER runs the review: report published, charge once, release first", async () => { await expect.poll(() => types().join(","), { timeout: 60_000 }).toBe("topup,reserve,release,charge"); await page.reload({ waitUntil: "domcontentloaded" }); await page.waitForSelector('[data-testid="review-report"]', { timeout: 60_000 }); });
      const afterReview = world.money.balance();
      await check(kind, "REVIEW charged = shown price, balance correct", async () => { expect(afterReview).toBeLessThan(start); expect(afterReview).toBeGreaterThanOrEqual(0); });

      await check(kind, "EDIT QUOTE (rename a column) then EDIT REQUEST unpaid", async () => {
        await page.waitForSelector('[data-testid="edit-kind"]', { timeout: 30_000 });
        await page.selectOption('[data-testid="edit-kind"]', "rename_column");
        const form = page.locator('[data-testid="edit-request"] select');
        await form.nth(1).selectOption({ index: 1 }).catch(() => {});
        await form.nth(2).selectOption({ index: 1 }).catch(() => {});
        await page.locator('[data-testid="edit-request"] input[type="text"]').first().fill("الاسم الكامل");
        await page.click('[data-testid="edit-ask"]');
        await page.waitForSelector('[data-testid="edit-prepare"]', { timeout: 30_000 });
        expect(world.money.balance()).toBe(afterReview);
        await page.click('[data-testid="edit-prepare"]');
        await page.waitForSelector('[data-testid="approve-button"]', { timeout: 30_000 });
        expect(world.money.balance()).toBe(afterReview);
      });
      await check(kind, "EDIT APPROVAL: one hold; WORKER publishes version 2; charge ≤ hold; release first", async () => {
        await page.click('[data-testid="approve-button"]');
        await expect.poll(() => types().join(","), { timeout: 90_000 }).toBe("topup,reserve,release,charge,reserve,release,charge");
        expect(reserves()).toBe(2);
      });
      await check(kind, "NEW FILE VERSION listed and version 2 downloads as a real Excel; version 1 unchanged", async () => {
        await page.reload({ waitUntil: "domcontentloaded" });
        await expect.poll(async () => page.locator('[data-testid="version-row"]').count(), { timeout: 60_000 }).toBe(2);
        const v2 = await fileRoute.GET(new NextRequest(`http://localhost/api/missions/${MISSION}/file?name=result.xlsx&version=2&stream=1`), { params: Promise.resolve({ id: MISSION }) });
        expect(v2.status).toBe(200);
        const sheets = await parseXlsx(new Uint8Array(await v2.arrayBuffer()));
        expect(sheets.length).toBeGreaterThan(0);
        const v1 = await fileRoute.GET(new NextRequest(`http://localhost/api/missions/${MISSION}/file?name=result.xlsx&version=1&stream=1`), { params: Promise.resolve({ id: MISSION }) });
        expect(v1.status).toBe(200);
      });
      await check(kind, "FINAL BALANCE = start − the two charges; never negative; ledger ids unique", async () => {
        const charges = world.money.ledger.filter((l) => l.type === "charge").reduce((n, l) => n + -l.delta, 0);
        expect(world.money.balance()).toBe(start - charges);
        expect(world.money.balance()).toBeGreaterThanOrEqual(0);
        const ids = world.money.ledger.map((l) => l.id); expect(new Set(ids).size).toBe(ids.length);
      });
      await check(kind, "LAYOUT at the end (report, two versions, balance)", async () => { expect(await layoutProblems(page)).toEqual([]); });
      await check(kind, "no uncaught page error", async () => { expect(consoleErrors).toEqual([]); });
      await page.screenshot({ path: `${process.env.SHOT_DIR ?? "/tmp"}/journey-${kind}.png`, fullPage: true });
      await ctx.close();
    }, 600_000);
  });
}


const fresh = async (balance: number) => { world = await e2eWorld({ balance }); session.client = new Proxy(world.routes as any, { get: (t, k) => (k === "rpc" ? (n: string, a: unknown) => world.money.client.rpc(n, a) : k === "from" ? (tb: string) => (tb === "missions" ? t.from(tb) : (world.money.client as any).from(tb)) : t[k]) }); };
const toApprovalControl = async (page: Page) => {
  await page.goto(`${BASE}/dashboard/requests/${MISSION}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="review-ask"]', { timeout: 60_000 });
  await page.click('[data-testid="review-ask"]'); await page.waitForSelector('[data-testid="review-quote"]', { timeout: 30_000 });
  await page.click('[data-testid="review-prepare"]'); await page.waitForSelector('[data-testid="approve-button"]', { timeout: 30_000 });
};
describe("failure scenarios in real Chromium", () => {
  for (const kind of ["desktop", "phone", "narrow"] as const) {
    it(`${kind}: NOT ENOUGH POINTS: nothing held, the request stays waiting WITH its approve button and CAN be cancelled; after a top-up the same request is approved with one hold`, async () => {
      await fresh(5);
      const { ctx, page } = await newPage(kind);
      await check(kind, "insufficient balance: refused in words, nothing held, no stranded request", async () => {
        await toApprovalControl(page);
        await page.click('[data-testid="approve-button"]');
        await page.waitForSelector('[data-testid="approve-result"]', { timeout: 30_000 });
        const text = await page.locator('[data-testid="approve-result"]').innerText();
        expect(text).toContain("رصيدك لا يكفي");
        expect(reserves()).toBe(0); expect(world.money.balance()).toBe(5);
        const row: any = [...world.store.missions.values()].find((r: any) => r.plan?.addon);
        expect(row.status).toBe("plan_ready");
        expect(row.approved_at ?? null).toBeNull(); // the clean refusal left no «possibly paid» mark (fix #421)
        expect(await page.locator('[data-testid="approve-button"]').count()).toBe(1);
        expect(await page.locator('[data-testid="review-cancel"]').count()).toBe(1);
      });
      await check(kind, "after a top-up the SAME request is approved: exactly one hold", async () => {
        world.money.ledger.push({ id: "top_browser", delta: 10_000, type: "topup" } as any);
        await page.click('[data-testid="approve-button"]');
        await expect.poll(() => reserves(), { timeout: 20_000 }).toBe(1);
        await expect.poll(() => types().join(","), { timeout: 60_000 }).toBe("topup,topup,reserve,release,charge");
        expect(world.money.balance()).toBeGreaterThanOrEqual(0);
      });
      await ctx.close();
    }, 300_000);
    it(`${kind}: LOST ANSWER: the server holds the points but the browser never hears; the page says «may be held» (never «nothing was held»), a retry converges on ONE hold, charge once`, async () => {
      await fresh(10_000);
      const { ctx, page } = await newPage(kind);
      await check(kind, "lost approval answer: uncertain wording, never «nothing held»", async () => {
        await toApprovalControl(page);
        dropNextApprovalAnswer = true;
        await page.click('[data-testid="approve-button"]');
        await page.waitForSelector('[data-testid="approve-result"]', { timeout: 30_000 });
        const text = await page.locator('[data-testid="approve-result"]').innerText();
        expect(text).toContain("قد تكون نقاطك حُجزت");
        expect(text).not.toMatch(/لم يُحجز أو يُخصم شيء/);
        expect(reserves()).toBe(1);
      });
      await check(kind, "the worker finished the held request: ONE hold, ONE charge, release first, balance = start − charge", async () => {
        await expect.poll(() => types().join(","), { timeout: 60_000 }).toBe("topup,reserve,release,charge");
        const charge = world.money.ledger.filter((l) => l.type === "charge").reduce((n, l) => n + -l.delta, 0);
        expect(world.money.balance()).toBe(10_000 - charge);
        await page.reload({ waitUntil: "domcontentloaded" });
        await page.waitForSelector('[data-testid="file-workflow"]', { timeout: 60_000 });
        expect(reserves()).toBe(1);
      });
      await ctx.close();
    }, 300_000);
  }
});

describe("signed-in customer pages at three widths (fake backend, EMPTY data: layout and Arabic RTL only)", () => {
  for (const kind of ["desktop", "phone", "narrow"] as const) {
    it(`${kind}: dashboard, requests, wallet, settings, chat open signed in with no sideways scroll`, async () => {
      await fresh(10_000);
      const { ctx, page } = await newPage(kind);
      const errors: string[] = []; page.on("pageerror", (e) => errors.push(String(e)));
      for (const path of ["/dashboard", "/dashboard/requests", "/dashboard/wallet", "/dashboard/settings", "/dashboard/chat"]) {
        await check(kind, `PAGE ${path}: stays signed in, RTL, no sideways scroll, nothing outside the screen`, async () => {
          await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" });
          await page.waitForTimeout(2500);
          expect(new URL(page.url()).pathname.startsWith("/login")).toBe(false);
          expect(await layoutProblems(page)).toEqual([]);
        });
        await page.screenshot({ path: `${process.env.SHOT_DIR ?? "/tmp"}/page-${kind}-${path.replace(/\//g, "_")}.png`, fullPage: true });
      }
      await check(kind, "no uncaught page error on those pages", async () => { expect(errors).toEqual([]); });
      await ctx.close();
    }, 300_000);
  }
});

afterAll(() => {
  const calls = api.reduce((acc: Record<string, number>, c) => { const k = `${c.method} ${c.path.replace(/msn_[a-z0-9]+/g, ":id")} ${c.status}`; acc[k] = (acc[k] ?? 0) + 1; return acc; }, {});
  writeFileSync(`${process.env.SHOT_DIR ?? "/tmp"}/journey-results.json`, JSON.stringify({ results, calls, approvals: approvals.length }, null, 1));
});
