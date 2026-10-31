// usage: node shoot.cjs <label> <viewsJson> <outDir> [pageFilter]
const { chromium } = require("playwright");
const fs = require("fs");
const [label, viewsPath, outDir, only] = process.argv.slice(2);
const views = JSON.parse(fs.readFileSync(viewsPath, "utf8"));
const BASE = "http://localhost:3100";
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

const pages = [
  { name: "chat-empty", path: "/dashboard/chat", wait: 2500 },
  { name: "chat-form-open", path: "/dashboard/chat?template=account_posts", wait: 3000 },
  { name: "chat-plan", path: "/dashboard/chat?c=c1", wait: 4000 },
  { name: "chat-approved", path: "/dashboard/chat?c=c1", wait: 3500, action: async (p) => { const b = p.locator('[data-testid="agent-approve"]'); if (await b.count()) { await b.click(); await p.waitForTimeout(2500); } } },
  { name: "requests", path: "/dashboard/requests", wait: 3500 },
  { name: "wallet", path: "/dashboard/topup", wait: 3500 },
  { name: "calculator", path: "/calculator", wait: 2500 },
  { name: "services", path: "/services", wait: 2500 },
  { name: "pricing", path: "/pricing", wait: 2000 },
  { name: "contact", path: "/contact", wait: 2000 },
  { name: "settings", path: "/dashboard/settings", wait: 2500 },
  { name: "help", path: "/help", wait: 2000 },
  { name: "request-details", path: "/dashboard/requests/job_demo00", wait: 3000 },
];


const supaServer = http.createServer((req, res) => {
  if (process.env.MOCKLOG) console.error("MOCK", req.method, req.url.slice(0, 80), (req.headers.authorization || "").slice(0, 20));
  const url = new URL(req.url, SUPA);
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
  await new Promise((r) => supaServer.listen(54321, "127.0.0.1", r));
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch();
  const report = [];
  { // warm-up pass: compile every page once (dev server) so the real pass is fast
    const wctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, bypassCSP: true });
    await wctx.addCookies([{ name: "sb-127-auth-token", value: "base64-" + b64(session), url: BASE }]);
    await wctx.route(`${BASE}/api/**`, (route) => route.fulfill({ status: 404, contentType: "application/json", body: "{}" }));
    const wp = await wctx.newPage();
    for (const pg of pages) { await wp.goto(BASE + pg.path, { waitUntil: "domcontentloaded", timeout: 180000 }).catch(() => null); await wp.waitForTimeout(1500); }
    await wctx.close();
  }
  for (const [vw, vh, tag] of [[1280, 900, "desktop"], [380, 1500, "m380"]]) {
    for (const scheme of ["light", "dark"]) {
      if (scheme === "dark" && tag === "m380" && false) continue;
      const ctx = await browser.newContext({ viewport: { width: vw, height: vh }, colorScheme: scheme, locale: "ar-EG", bypassCSP: true });
      await ctx.addCookies([{ name: "sb-127-auth-token", value: "base64-" + b64(session), url: BASE }]);
      await ctx.route(`${BASE}/api/**`, async (route) => {
        const u = new URL(route.request().url()); const p = u.pathname; if (p.startsWith("/api/calculator/")) return route.continue(); const j = (o, s = 200) => route.fulfill({ status: s, contentType: "application/json", body: JSON.stringify(o) });
        if (p === "/api/requests") return j(requestsIndex);
        if (p === "/api/wallet/history") return j({ success: true, rows: ledger });
        if (p === "/api/wallet/balance") return j({ success: true, balance: 4370, userId: uid });
        if (p === "/api/llm-enabled") return j({ enabled: true });
        if (/^\/api\/missions\/[^/]+$/.test(p)) {
          if (route.request().method() === "POST") { missionPhase = "running"; return j({ success: true }); }
          return j({ success: true, status: missionPhase, view: views[missionPhase === "running" ? "running" : "plan"] });
        }
        if (p.startsWith("/api/requests/")) return j({ success: true, request: { id: "job_demo00", title: "٥٠ تغريدة عن القهوة خلال آخر ٣ أشهر", status: "completed", createdAt: iso(60), delivered: 50, requested: 50, chargedPoints: 200, reservedPoints: 230, conversationId: "c1", missionId: "m1" }, view: views.running });
        return j({ success: false }, 404);
      });
      const page = await ctx.newPage();
      page.on("pageerror", (e) => report.push({ tag, scheme, error: String(e).slice(0, 160) }));
      for (const pg of pages) {
        if (only && pg.name !== only) continue;
        if (scheme === "dark" && !["chat-empty", "chat-plan", "wallet", "requests"].includes(pg.name)) continue;
        missionPhase = "plan";
        const resp = await page.goto(BASE + pg.path, { waitUntil: "domcontentloaded", timeout: 120000 }).catch((e) => null);
        await page.waitForTimeout(pg.wait);
        if (pg.action) await pg.action(page);
        const status = resp ? resp.status() : 0;
        const overflow = await page.evaluate(() => { const els = [document.documentElement, document.body, ...document.querySelectorAll("[data-shell-scroll]")]; return Math.max(...els.map((e) => e.scrollWidth - e.clientWidth)); });
        const file = `${outDir}/${pg.name}-${tag}-${scheme}.png`;
        await page.screenshot({ path: file, fullPage: false });
        report.push({ page: pg.name, tag, scheme, status, overflowPx: overflow, file: file.split("/").pop() });
      }
      await ctx.close();
    }
  }
  await browser.close(); supaServer.close();
  console.log(JSON.stringify(report, null, 1));
})();
