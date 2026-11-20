import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import nextConfig from "../next.config.mjs";
import robots from "../src/app/robots";
import sitemap from "../src/app/sitemap";

const EXPECTED_ROLES: Record<string, string> = {
  elkebir: "المدير التقني وقائد الفريق",
  johnny: "المعماري (خطط وكود الفلوس)",
  nafady: "المعماري التاني (الشغل اللي مش فلوس)",
  hagras: "المنفّذ الأول",
  salem: "المنفّذ التاني",
  fazza: "صائد الأخطاء (الفلوس والمشاكل الخطيرة)",
  ashraf: "صائد الأخطاء التاني",
  marbouha: "الجودة والاختبار",
  hazalqom: "المصمم",
};

function createMegzOfficeHarness(
  html: string,
  fetchImpl: (url: string, init?: any) => Promise<any>,
  opts: { width: number; height: number; stackedPortrait?: boolean; reducedMotion?: boolean },
) {
  const elements = new Map<string, any>();
  const consoleErrors: unknown[] = [];

  const makeEl = (tag = "div", id = "") => ({
    id,
    tagName: tag.toUpperCase(),
    style: {} as Record<string, string>,
    className: "",
    textContent: "",
    src: "",
    clientWidth: opts.width,
    clientHeight: opts.height,
    addEventListener() {},
    getBoundingClientRect() {
      return { left: 0, top: 0, width: opts.width, height: opts.height };
    },
    getContext() {
      return {
        save() {}, restore() {}, setTransform() {}, clearRect() {}, fillRect() {}, strokeRect() {},
        rect() {}, beginPath() {}, moveTo() {}, lineTo() {}, arcTo() {}, closePath() {}, arc() {}, ellipse() {},
        fill() {}, stroke() {}, setLineDash() {}, measureText(t: string) { return { width: t.length * 6 }; },
        fillText() {}, drawImage() {}, clip() {}, translate() {}, scale() {},
        createRadialGradient() { return { addColorStop() {} }; },
      };
    },
  });

  elements.set("stage-wrapper", makeEl("div", "stage-wrapper"));
  elements.set("office-canvas", makeEl("canvas", "office-canvas"));

  const ctx: any = {
    window: {} as any,
    document: {
      getElementById(id: string) { return elements.get(id) ?? null; },
      addEventListener() {},
    },
    innerWidth: opts.width,
    innerHeight: opts.height,
    devicePixelRatio: 1,
    matchMedia(q: string) {
      if (q.includes("prefers-reduced-motion")) return { matches: opts.reducedMotion ?? true };
      if (q.includes("orientation: portrait")) return { matches: Boolean(opts.stackedPortrait) };
      return { matches: false };
    },
    Image: class { src = ""; complete = false; naturalWidth = 0; },
    fetch: fetchImpl,
    setInterval() { return 1; },
    setTimeout,
    requestAnimationFrame() { return 1; },
    performance: { now: () => 10000 },
    Math,
    Date,
    Number,
    String,
    Array,
    Object,
    console: {
      log: () => {},
      warn: () => {},
      error: (...args: unknown[]) => consoleErrors.push(args),
    },
  };
  ctx.window = ctx;

  const vmCtx = vm.createContext(ctx);
  const script = html.split("<script>")[1].split("</script>")[0];
  vm.runInContext(script, vmCtx);
  return { ctx: vmCtx, elements, consoleErrors };
}

describe("DT-20261120-office-megz: hidden noindex office routing and counter-cases", () => {
  it("keeps next.config.mjs /office rewrite + noindex headers and excludes /office from sitemap/robots", async () => {
    const rewrites = await nextConfig.rewrites!();
    expect(rewrites).toContainEqual({ source: "/office", destination: "/office/index.html" });

    const headers = await nextConfig.headers!();
    expect(headers).toContainEqual({
      source: "/office",
      headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }],
    });
    expect(headers).toContainEqual({
      source: "/office/:path*",
      headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }],
    });

    const urls = sitemap().map((e) => e.url);
    expect(urls.some((u) => u.includes("/office"))).toBe(false);
    const r = robots();
    const rule = Array.isArray(r.rules) ? r.rules[0] : r.rules;
    const disallow = Array.isArray(rule.disallow) ? rule.disallow : [rule.disallow];
    expect(disallow.some((d) => String(d).includes("/office"))).toBe(false);
  });
});

describe("DT-20261120-office-megz v2: Megz pure fullscreen office page", () => {
  const html = readFileSync("public/office/index.html", "utf8");

  it("has noindex meta, live feed + 30s poll + cache-bust, exact 9 Arabic roles, no secrets, and no click card/cheer/notice", () => {
    expect(html).toContain('<meta name="robots" content="noindex, nofollow" />');
    expect(html).toContain("https://pfinlfaqwnytesedchik.supabase.co/storage/v1/object/public/office-status/status.json");
    expect(html).toContain("FEED_URL + '?t=' + Date.now()");
    expect(html).toContain("POLL_INTERVAL_MS = 30000");
    expect(html).not.toMatch(/\b(sb_secret_|sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,})\b/);
    expect(html).not.toContain("bot-modal-overlay");
    expect(html).not.toContain("bot-card");
    expect(html).not.toContain("شجّعه");
    expect(html).not.toContain("feed-notice");
    for (const [id, role] of Object.entries(EXPECTED_ROLES)) {
      expect(html).toContain(`${id}: { id: "${id}", name:`);
      expect(html).toContain(`title: "${role}", role: "${role}"`);
    }
  });

  it.each([
    { label: "1920x1080 desktop", width: 1920, height: 1080, stackedPortrait: false },
    { label: "390x844 portrait", width: 390, height: 844, stackedPortrait: true },
  ])("polls cache-busted feed, updates bot state cleanly, and produces 0 console errors at $label", async ({ width, height, stackedPortrait }) => {
    let mode: "fresh" | "fail" = "fresh";
    const fetched: Array<{ url: string; cache?: string }> = [];
    const nowIso = new Date().toISOString();

    const payload = {
      version: 1,
      generated_at: nowIso,
      open_prs: [],
      bots: {
        elkebir: { bot: "elkebir", state: "working", task_id: "DT-20261120-office-megz", task_title: "صفحة مكتب ميجز", step: "تنسيق الدمج", percent: 70, next: "مراجعة أشرف", open_order: true, updated_at: nowIso, recent: [] },
        hagras: { bot: "hagras", state: "idle", task_id: null, task_title: "", step: "", percent: 0, next: "", open_order: false, updated_at: nowIso, recent: [] },
      },
    };

    const { ctx, consoleErrors } = createMegzOfficeHarness(
      html,
      async (url, init) => {
        fetched.push({ url, cache: init?.cache });
        if (mode === "fail") throw new Error("network down");
        return { ok: true, status: 200, async json() { return payload; } };
      },
      { width, height, stackedPortrait, reducedMotion: true },
    );

    await new Promise((r) => setTimeout(r, 20));
    expect(fetched.length).toBeGreaterThanOrEqual(1);
    expect(fetched[0].url).toMatch(/^https:\/\/pfinlfaqwnytesedchik\.supabase\.co\/storage\/v1\/object\/public\/office-status\/status\.json\?t=\d+$/);
    expect(fetched[0].cache).toBe("no-store");
    expect(vm.runInContext("BOTS.elkebir.status", ctx)).toBe("working");
    expect(vm.runInContext("BOTS.elkebir.shortTask", ctx)).toBe("صفحة مكتب ميجز 70%");
    expect(vm.runInContext("BOTS.hagras.status", ctx)).toBe("idle");

    ctx.gameLoop(10020);
    mode = "fail";
    await ctx.fetchLiveFeed();
    expect(vm.runInContext("BOTS.elkebir.status", ctx)).toBe("working");
    expect(consoleErrors).toEqual([]);
  });
});
