// usage: node shoot.cjs <label> <viewsJson> <outDir> [pageFilter]
const { chromium } = require("playwright");
const fs = require("fs");
const [BASE_ARG, label, viewsPath, latencyArg] = process.argv.slice(2);
const LATENCY = Number(latencyArg || 0);
const views = JSON.parse(fs.readFileSync(viewsPath, "utf8"));
const BASE = BASE_ARG;
const SUPA = "http://127.0.0.1:54321";
const http = require("http");
const uid = "u-0000-1111";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: uid, exp: Math.floor(Date.now() / 1000) + 36000, role: "authenticated" })}.sig`;
const user = { id: uid, aud: "authenticated", role: "authenticated", email: "magdy@example.com", email_confirmed_at: "2026-10-01T00:00:00Z", app_metadata: { provider: "email" }, user_metadata: { name: "مجدي", persona: "researcher", onboarded: true }, created_at: "2026-10-01T00:00:00Z" };
const session = { access_token: jwt, token_type: "bearer", expires_in: 36000, expires_at: Math.floor(Date.now() / 1000) + 36000, refresh_token: "r", user };
const iso = (minsAgo) => new Date(Date.now() - minsAgo * 60000).toISOString();

const notifications = Array.from({ length: 30 }, (_, i) => ({ id: `n${i}`, user_id: uid, kind: i % 6 === 0 ? "topup_rejected" : "job_done", title: "اكتمل طلبك", body: "ملفك جاهز في «طلباتي».", link: "/dashboard/requests", read: i % 10 === 9, created_at: iso(i * 7 + 1), updated_at: iso(i * 7 + 1) }));
const jobs = Array.from({ length: 4 }, (_, i) => ({ id: `job_demo0${i}`, user_id: uid, status: i === 3 ? "failed" : "completed", delivered_units: 50, reserved_credits: 230, charged_credits: i === 3 ? 0 : 200, target_volume_max: 50, endpoint_id: "model-plan", created_at: iso(60 * (i + 1)), updated_at: iso(60 * (i + 1)), params: "{}" }));
const requestsIndex = { success: true, counts: { all: 225, running: 1, done: 200, ended: 20, refunded: 4 }, rows: jobs.map((j) => ({ type: "job", id: j.id, createdAt: j.created_at, tab: j.status === "completed" ? "done" : "refunded", title: "٥٠ تغريدة عن القهوة خلال آخر ٣ أشهر" })), pending: [{ id: "p1", status: "plan_ready", stateAr: "خطة تنتظر اعتمادك", requestText: "منشورات حساب @tiktok خلال آخر ٣ شهور", createdAt: iso(5), cancellable: true, conversationId: "c1" }], hasMore: true, nextOffset: 20 };
const ledger = [];
for (let i = 0; i < 6; i++) { const t = 100 + i * 30; ledger.push({ id: `r${i}`, delta: 230, type: "release", kind: "release", labelAr: "حجز مؤقت مُحرَّر", jobId: `jx${i}`, missionLineAr: null, createdAt: iso(t), note: "" }, { id: `c${i}`, delta: -200, type: "charge", kind: "charge", labelAr: "خصم", jobId: `jx${i}`, missionLineAr: null, createdAt: iso(t + 1), note: "" }, { id: `s${i}`, delta: -230, type: "reserve", kind: "reserve", labelAr: "حجز", jobId: `jx${i}`, missionLineAr: null, createdAt: iso(t + 2), note: "" }); }
ledger.push({ id: "t1", delta: 5000, type: "topup", kind: "topup", labelAr: "شحن رصيد", jobId: null, missionLineAr: null, createdAt: iso(5000), note: "" });
const msgs = [
  { id: "mm1", conversation_id: "c1", user_id: uid, role: "user", content: "منشورات حساب @tiktok خلال آخر ٣ شهور", created_at: iso(10), status: "done" },
  { id: "mm2", conversation_id: "c1", user_id: uid, role: "assistant", content: "جهزت لك الخطة.", plan: { agentMissionId: "m1" }, created_at: iso(9), status: "done" },
];
let missionPhase = "plan";
const tables = { notifications, jobs, conversations: [{ id: "c1", user_id: uid, title: "تغريدات عن القهوة", updated_at: iso(9), created_at: iso(10) }], messages: msgs, missions: [{ id: "m1", job_id: "job_demo00", user_id: uid, status: "completed", delivered_units: 50, charged_points: 200, reserved_points: 230, request_text: "٥٠ تغريدة عن القهوة خلال آخر ٣ أشهر", created_at: iso(60), files: [] }], credit_ledger: ledger.map((l) => ({ id: l.id, user_id: uid, delta: l.delta, type: l.type, job_id: l.jobId, created_at: l.createdAt, note: "" })), settings_public: [{ key: "pricing", value: { ipa: "magdy@instapay", maxPendingTopups: 3 } }], topups: [], plans_quotes: [], artifact_versions: [], profiles: [{ id: uid }] };


const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const supaServer2 = http.createServer(async (req, res) => {
  const url = new URL(req.url, SUPA);
  if (LATENCY && !url.pathname.startsWith("/auth/v1/user")) await sleep(LATENCY);
  const h = { "access-control-allow-origin": req.headers.origin || "*", "access-control-allow-credentials": "true", "access-control-allow-headers": "*", "access-control-allow-methods": "*", "access-control-expose-headers": "content-range" };
  const send = (status, body, extra = {}) => { res.writeHead(status, { ...h, "content-type": "application/json", ...extra }); res.end(body === undefined ? "" : JSON.stringify(body)); };
  if (req.method === "OPTIONS") { res.writeHead(204, h); return res.end(); }
  if (url.pathname.startsWith("/auth/v1/user")) return send(200, user);
  if (url.pathname.startsWith("/auth/v1")) return send(200, session);
  const m = url.pathname.match(/\/rest\/v1\/([^/]+)/);
  if (m) {
    let rows = tables[m[1]] || [];
    for (const [k, v] of url.searchParams) {
      if (v.startsWith("eq.") && rows.some((r) => k in r)) rows = rows.filter((r) => String(r[k]) === v.slice(3));
      else if (v.startsWith("in.(") && rows.some((r) => k in r)) { const set = new Set(v.slice(4, -1).split(",").map((x) => x.replace(/^"|"$/g, ""))); rows = rows.filter((r) => set.has(String(r[k]))); }
      else if (k === "or") { const pairs = v.replace(/^\(|\)$/g, "").split(",").map((x) => x.split(".eq.")); rows = rows.filter((r) => pairs.some(([col, val]) => String(r[col]) === val)); }
    }
    const hdr = { "content-range": `0-${Math.max(0, rows.length - 1)}/${rows.length}` };
    if (req.method === "HEAD") { res.writeHead(200, { ...h, ...hdr }); return res.end(); }
    if ((req.headers["accept"] || "").includes("vnd.pgrst.object")) return send(rows.length ? 200 : 406, rows[0] || { message: "none" }, hdr);
    return send(200, rows, hdr);
  }
  return send(200, {});
});

(async () => {
  await new Promise((r) => supaServer2.listen(54321, "127.0.0.1", r));
  const browser = await chromium.launch();
  const out = { label, base: BASE, latencyMs: LATENCY, checks: [] };
  const rec = (name, value) => out.checks.push({ name, value });
  const mk = async (w, h) => {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, bypassCSP: true, locale: "ar-EG" });
    await ctx.addCookies([{ name: "sb-127-auth-token", value: "base64-" + b64(session), url: BASE }]);
    let phase = "plan"; const posts = [];
    await ctx.route(`${BASE}/api/**`, async (route) => {
      const u = new URL(route.request().url()); const p = u.pathname; const j = async (o, s = 200) => { if (LATENCY) await sleep(LATENCY); return route.fulfill({ status: s, contentType: "application/json", body: JSON.stringify(o) }); };
      if (p.startsWith("/api/calculator/")) return route.continue();
      if (route.request().method() === "POST" && p === "/api/chat") { posts.push(route.request().postDataJSON?.() ?? route.request().postData()); return j({ success: false, error: "mock" }, 500); }
      if (p === "/api/requests") return j(requestsIndex);
      if (p === "/api/wallet/history") return j({ success: true, rows: ledger });
      if (p === "/api/wallet/balance") return j({ success: true, balance: 4370, userId: uid });
      if (p === "/api/llm-enabled") return j({ enabled: true });
      if (/^\/api\/jobs\/[^/]+\/conversation$/.test(p)) return j({ success: true, conversationId: "c1" });
      if (/^\/api\/missions\/[^/]+$/.test(p)) { if (route.request().method() === "POST") { phase = "running"; return j({ success: true }); } return j({ success: true, status: phase, view: views[phase === "running" ? "running" : "plan"] }); }
      return j({ success: false }, 404);
    });
    return { ctx, posts };
  };

  // ---- warm-up: compile every page once so the measurements below are not first-compile times
  { const { ctx } = await mk(1280, 900); const p = await ctx.newPage();
    for (const path of ["/dashboard/chat", "/dashboard/chat?c=c1", "/dashboard/chat?jobId=job_demo00&c=c1", "/dashboard/requests", "/dashboard/requests/job_demo00", "/dashboard/topup", "/dashboard/settings", "/calculator", "/services", "/services/facebook", "/pricing", "/contact", "/legal/terms", "/legal/privacy", "/help", "/for/researchers"]) { await p.goto(BASE + path, { waitUntil: "domcontentloaded", timeout: 180000 }).catch(() => {}); await p.waitForTimeout(1500); }
    await ctx.close(); }

  // ---- A. chips and forms (desktop)
  { const { ctx, posts } = await mk(1280, 900); const p = await ctx.newPage(); await p.goto(BASE + "/dashboard/chat", { waitUntil: "domcontentloaded", timeout: 120000 }); await p.waitForTimeout(3000);
    const hasChips = await p.locator('[data-testid="example-chips"]').count();
    rec("A0 chips present", hasChips > 0);
    if (hasChips) {
      await p.click('[data-testid="example-chip-account_posts"]'); await p.waitForTimeout(400);
      rec("A1 chip click opens a form", await p.locator('[data-testid="template-form"]').isVisible());
      rec("A2 requests sent after chip click", posts.length);
      await p.click('[data-testid="template-form-send"]'); await p.waitForTimeout(500);
      rec("A3 requests sent after «أرسل» with an empty account", posts.length);
      rec("A4 error shown for the empty required field", await p.locator('[role="alert"]').first().isVisible().catch(() => false));
      await p.fill('input[id$="-account"]', "alahly"); await p.click('[data-testid="template-form-send"]'); await p.waitForTimeout(1500);
      rec("A5 requests sent after a filled form + «أرسل»", posts.length);
      rec("A6 the text sent", JSON.stringify(posts[0] ?? null).slice(0, 220));
    }
    await ctx.close(); }

  // ---- B. help links
  { const { ctx } = await mk(1280, 900); const p = await ctx.newPage(); await p.goto(BASE + "/dashboard/chat", { waitUntil: "domcontentloaded", timeout: 120000 }); await p.waitForTimeout(2500);
    await p.getByRole("link", { name: "مركز المساعدة" }).click().catch(() => {}); await p.waitForTimeout(2500);
    rec("B1 «مركز المساعدة» goes to", new URL(p.url()).pathname); rec("B1 page heading", (await p.locator("h1").first().textContent().catch(() => "")) || "");
    await p.goto(BASE + "/dashboard/chat", { waitUntil: "domcontentloaded" }); await p.waitForTimeout(2500);
    await p.getByRole("link", { name: "تواصل مع الدعم" }).click().catch(() => {}); await p.waitForTimeout(2500);
    rec("B2 «تواصل مع الدعم» goes to", new URL(p.url()).pathname); rec("B2 page heading", (await p.locator("h1").first().textContent().catch(() => "")) || "");
    await ctx.close(); }

  // ---- C. after «اعتمد»
  { const { ctx } = await mk(380, 900); const p = await ctx.newPage(); await p.goto(BASE + "/dashboard/chat?c=c1", { waitUntil: "domcontentloaded", timeout: 120000 }); await p.waitForSelector('[data-testid="agent-approve"]', { timeout: 20000 }).catch(() => {});
    if (await p.locator('[data-testid="agent-approve"]').count()) {
      const t0 = Date.now(); await p.click('[data-testid="agent-approve"]');
      await p.waitForSelector('[data-testid="agent-approving"], [data-testid="agent-started"]', { timeout: 10000 }).catch(() => {});
      rec("C1 ms until a status line is on the page after «اعتمد»", Date.now() - t0);
      await p.waitForSelector('[data-testid="agent-started"]', { timeout: 15000 }).catch(() => {});
      rec("C2 ms until the running status (started line + close notice)", Date.now() - t0);
      rec("C3 started line", (await p.locator('[data-testid="agent-started-line"]').textContent().catch(() => "")) || "");
      rec("C4 close notice visible", (await p.locator('[data-testid="agent-close-notice"]').isVisible().catch(() => false)));
    } else rec("C0 approve button", "absent");
    await ctx.close(); }

  // ---- D. opening a request's details (latency)
  { const { ctx } = await mk(1280, 900); const p = await ctx.newPage(); await p.goto(BASE + "/dashboard/requests", { waitUntil: "domcontentloaded", timeout: 120000 }); await p.waitForSelector('[data-testid="request-row"]', { timeout: 30000 }).catch(() => {}); await p.waitForTimeout(800);
    const btn = p.locator('[data-testid="request-row"]').filter({ hasText: "مكتمل" }).getByRole("button", { name: "التفاصيل" }).first();
    const t0 = Date.now(); await btn.click();
    const first = await Promise.race([
      p.waitForSelector('[data-testid="details-title"]', { timeout: 30000 }).then(() => "details-title"),
      p.waitForSelector('[data-testid="agent-card"]', { timeout: 30000 }).then(() => "agent-card"),
      p.getByText("ستستلم ملف إكسل").first().waitFor({ timeout: 30000 }).then(() => "chat-text"),
    ]).catch(() => "none");
    rec("D1 first thing on screen after «التفاصيل»", first); rec("D1 ms to it", Date.now() - t0); rec("D1 url", new URL(p.url()).pathname);
    await p.waitForSelector('[data-testid="agent-card"]', { timeout: 30000 }).catch(() => {});
    rec("D2 ms until the mission card (heavy part) is on screen", Date.now() - t0);
    await ctx.close(); }

  // ---- E. header, logo and menu on each customer page
  for (const [w, h, tag] of [[1280, 900, "desktop"], [380, 900, "m380"]]) {
    const { ctx } = await mk(w, h); const p = await ctx.newPage();
    for (const path of ["/calculator", "/services", "/services/facebook", "/pricing", "/contact", "/legal/terms", "/legal/privacy", "/help", "/for/researchers", "/dashboard/requests", "/dashboard/topup", "/dashboard/settings", "/dashboard/chat"]) {
      await p.goto(BASE + path, { waitUntil: "domcontentloaded", timeout: 120000 }).catch(() => {}); await p.waitForTimeout(1800);
      const r = await p.evaluate(() => ({ logo: document.querySelectorAll('img[alt="ديجر"]').length > 0, menu: Boolean(document.querySelector('aside[aria-label="القائمة الرئيسية"]')) || Boolean(document.querySelector('button[aria-label="القائمة"]')), header: Boolean(document.querySelector("header")) }));
      rec(`E ${tag} ${path}`, r.logo && r.menu && r.header ? "header+logo+menu" : `MISSING ${JSON.stringify(r)}`);
    }
    await ctx.close();
  }
  await browser.close(); supaServer2.close();
  console.log(JSON.stringify(out, null, 1));
})();
