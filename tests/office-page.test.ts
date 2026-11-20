import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import nextConfig from "../next.config.mjs";
import robots from "../src/app/robots";
import sitemap from "../src/app/sitemap";
import { buildOfficeFeed, CANONICAL_BOTS, sanitizeText } from "../scripts/office-feed-updater.mjs";

const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

function createOfficeDomHarness(html: string, fetchImpl: (url: string) => Promise<any>) {
  const elements = new Map<string, any>();
  const makeEl = (tag = "div") => {
    const el: any = {
      tagName: tag.toUpperCase(),
      style: {},
      className: "",
      textContent: "",
      src: "",
      dataset: {},
      children: [] as any[],
      classList: {
        _set: new Set<string>(),
        add(c: string) { this._set.add(c); },
        remove(c: string) { this._set.delete(c); },
        contains(c: string) { return this._set.has(c); },
      },
      appendChild(child: any) { this.children.push(child); return child; },
      addEventListener() {},
      getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 540 }; },
      getContext() {
        return {
          save() {}, restore() {}, setTransform() {}, clearRect() {}, fillRect() {}, strokeRect() {},
          beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, arc() {}, ellipse() {}, fill() {}, stroke() {},
          setLineDash() {}, measureText(t: string) { return { width: t.length * 6 }; }, fillText() {}, drawImage() {},
          clip() {},
        };
      },
    };
    return el;
  };
  for (const id of [
    "office-canvas", "hover-tooltip", "bots-hotspots", "dock-scroll", "prs-bar", "feed-status",
    "btn-all", "btn-working", "btn-idle", "btn-stuck", "live-clock",
    "modal-overlay", "card-avatar-img", "card-name", "card-role", "card-task-id",
    "card-location-text", "card-task-desc", "card-task-step", "card-task-next",
    "card-progress-text", "card-progress-bar", "card-status-pill", "card-recent-list",
  ]) {
    elements.set(id, makeEl(id === "office-canvas" ? "canvas" : "div"));
  }
  const documentObj: any = {
    getElementById(id: string) { return elements.get(id) ?? null; },
    createElement(tag: string) { return makeEl(tag); },
    createTextNode(text: string) { return { nodeType: 3, textContent: text }; },
    querySelectorAll() { return []; },
    querySelector() { return makeEl("span"); },
  };
  const ctx: any = {
    window: {} as any,
    document: documentObj,
    Image: class { src = ""; complete = false; naturalWidth = 0; },
    fetch: fetchImpl,
    setInterval() { return 1; },
    setTimeout,
    requestAnimationFrame() { return 1; },
    performance: { now: () => 0 },
    Math,
    Date,
    Number,
    String,
    Array,
    Object,
    console,
  };
  ctx.window = ctx;
  const script = html.split("<script>")[1].split("</script>")[0];
  vm.runInNewContext(script, ctx);
  return { ctx, elements };
}

describe("DT-20261120-office: hidden noindex office routing and counter-cases", () => {
  it("rewrites /office to /office/index.html and applies X-Robots-Tag noindex without altering existing redirects or headers", async () => {
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

    const redirects = await nextConfig.redirects!();
    expect(redirects).toContainEqual({ source: "/terms", destination: "/legal/terms", permanent: true });
    expect(redirects).toContainEqual({ source: "/privacy", destination: "/legal/privacy", permanent: true });
    expect(headers.some((h: { source: string }) => h.source === "/dashboard/:path*")).toBe(true);
    expect(headers.some((h: { source: string }) => h.source === "/admin/:path*")).toBe(true);
  });

  it("excludes /office from sitemap.ts and robots.ts", () => {
    const urls = sitemap().map((e) => e.url);
    expect(urls.some((u) => u.includes("/office"))).toBe(false);
    const r = robots();
    const rule = Array.isArray(r.rules) ? r.rules[0] : r.rules;
    const disallow = Array.isArray(rule.disallow) ? rule.disallow : [rule.disallow];
    expect(disallow.some((d) => String(d).includes("/office"))).toBe(false);
  });
});

describe("DT-20261120-office: static office page uses live feed, real roles, noindex meta, and zero sample data", () => {
  const html = readFileSync("public/office/index.html", "utf8");

  it("includes robots noindex meta, 30s live poll, stale 45m rule, real roles, and zero sample text", () => {
    expect(html).toContain('<meta name="robots" content="noindex, nofollow">');
    expect(html).toContain("POLL_INTERVAL_MS = 30000");
    expect(html).toContain("STALE_AFTER_MS = 45 * 60 * 1000");
    for (const botId of CANONICAL_BOTS) {
      expect(html).toContain(`${botId}: { id: "${botId}"`);
    }
    for (const sampleText of [
      "Sprint 14",
      "Auth API",
      "Kubernetes",
      "PR #142",
      "تصليح المديرين",
      "خطة المعمارية",
      "إيميل الترحيب",
      "تجارب الواجهة",
      "Scrum Master",
      "Product Growth",
      "Senior Backend Engineer",
      "DevOps & SRE Engineer",
    ]) {
      expect(html).not.toContain(sampleText);
    }
  });

  it("renders live feed updates, marks >45m open-order bots as stuck, keeps last data with «آخر تحديث من X دقيقة» when feed fails, and opens/closes modal", async () => {
    let shouldFail = false;
    const nowIso = new Date().toISOString();
    const staleIso = new Date(Date.now() - 46 * 60 * 1000).toISOString();
    const payload = {
      version: 1,
      generated_at: nowIso,
      open_prs: [{ number: 601, title: "Add hidden live office page" }],
      bots: {
        elkebir: { bot: "elkebir", state: "working", task_id: "DT-20261120-office", task_title: "صفحة المكتب", step: "تنسيق", percent: 50, next: "بوابة ١", open_order: true, updated_at: nowIso, recent: ["DT-15d"] },
        salem: { bot: "salem", state: "working", task_id: "DT-20261120-office", task_title: "بناء", step: "جاري", percent: 30, next: "اختبار", open_order: true, updated_at: staleIso, recent: [] },
        fazza: { bot: "fazza", state: "idle", task_id: null, task_title: "", step: "", percent: 0, next: "", open_order: false, updated_at: staleIso, recent: [] },
      },
    };
    const { ctx, elements } = createOfficeDomHarness(html, async () => {
      if (shouldFail) throw new Error("network down");
      return { ok: true, status: 200, async json() { return payload; } };
    });

    await new Promise((r) => setTimeout(r, 20));
    expect(elements.get("btn-working").textContent).toContain("1");
    expect(elements.get("btn-stuck").textContent).toContain("1");
    expect(elements.get("btn-idle").textContent).toContain("7");
    expect(elements.get("prs-bar").children.map((c: any) => c.textContent).join(" ")).toContain("#601 Add hidden live office page");

    ctx.openBotModal("elkebir");
    expect(elements.get("modal-overlay").classList.contains("open")).toBe(true);
    expect(elements.get("card-task-desc").textContent).toBe("صفحة المكتب");
    ctx.closeModal({ target: elements.get("modal-overlay") });
    expect(elements.get("modal-overlay").classList.contains("open")).toBe(false);

    // Feed goes down -> preserves last data and shows "آخر تحديث من X دقيقة"
    shouldFail = true;
    await ctx.fetchLiveFeed();
    expect(elements.get("feed-status").textContent).toContain("آخر تحديث من ");
    expect(elements.get("btn-working").textContent).toContain("1");
    ctx.openBotModal("elkebir");
    expect(elements.get("card-task-desc").textContent).toBe("صفحة المكتب");
  });
});

describe("DT-20261120-office: non-AI feed updater handles 9 bots, 45m stale threshold, idle bots, and privacy sanitization", () => {
  it("marks open-order bot silent > 45 min as stuck, keeps idle bot idle with no invented task, and preserves recent completions", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "office-feed-"));
    tmpDirs.push(dir);
    const nowMs = Date.parse("2026-11-20T14:00:00Z");

    writeFileSync(
      path.join(dir, "nafady.jsonl"),
      [
        JSON.stringify({ bot: "nafady", state: "idle", task_id: "DT-15d", task_title: "خطة المديرين", step: "انتهت", percent: 100, open_order: false, updated_at: "2026-11-20T12:00:00Z" }),
        JSON.stringify({ bot: "nafady", state: "working", task_id: "DT-office", task_title: "صفحة المكتب", step: "كتابة الخطوات", percent: 75, next: "تسليم التقرير", open_order: true, updated_at: "2026-11-20T13:50:00Z" }),
      ].join("\n"),
    );
    writeFileSync(
      path.join(dir, "salem.jsonl"),
      JSON.stringify({ bot: "salem", state: "working", task_id: "DT-office", task_title: "تنفيذ", step: "بناء", percent: 40, open_order: true, updated_at: "2026-11-20T13:14:00Z" }),
    );
    writeFileSync(
      path.join(dir, "fazza.jsonl"),
      JSON.stringify({ bot: "fazza", state: "idle", task_id: "", task_title: "", step: "", percent: 0, open_order: false, updated_at: "2026-11-20T11:00:00Z" }),
    );

    const feed = buildOfficeFeed({
      statusDir: dir,
      openPrs: [{ number: 601, title: "Add hidden live office page" }],
      nowMs,
    });

    expect(Object.keys(feed.bots)).toEqual(CANONICAL_BOTS);
    expect(feed.bots.nafady.state).toBe("working");
    expect(feed.bots.nafady.percent).toBe(75);
    expect(feed.bots.nafady.recent).toEqual(["DT-15d — خطة المديرين"]);
    expect(feed.bots.salem.state).toBe("stuck");
    expect(feed.bots.fazza.state).toBe("idle");
    expect(feed.bots.fazza.task_title).toBe("");
    expect(feed.bots.ashraf.state).toBe("idle");
    expect(feed.bots.ashraf.task_title).toBe("");
    expect(feed.open_prs).toEqual([{ number: 601, title: "Add hidden live office page" }]);
  });

  it("strips secrets, emails, and private server paths from feed text", () => {
    const dirty = "Check /srv/diger-team/commander/.env sk-secret1234567890ab sb_secret_abcd123456 user@example.com Bearer eyJhbGciOiJIUzI1NiJ9.eyJhIjoxfQ.sig";
    const clean = sanitizeText(dirty, 200);
    expect(clean).not.toContain("/srv/");
    expect(clean).not.toContain("sk-secret");
    expect(clean).not.toContain("sb_secret_");
    expect(clean).not.toContain("user@example.com");
    expect(clean).not.toContain("eyJhbGciOi");
    expect(clean).toContain("[path]");
    expect(clean).toContain("[redacted]");
    expect(clean).toContain("[redacted-email]");
  });
});
