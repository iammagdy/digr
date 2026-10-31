import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Phase 4: the mobile audit WITHOUT a browser (390 x 844). These tests read the CSS and the class names; they prove the rules a page must follow to fit a
 * phone, not how it looks. What only a real device can show is listed in the phase report.
 */
const src = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const isAdmin = (file: string) => /\/admin\/|^src\/app\/admin|components\/admin\//.test(file);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.tsx$/.test(name)) out.push(path);
  }
  return out;
}
const customerFiles = walk("src").filter((file) => !isAdmin(file));

describe("audit phase 4: the page never widens past the phone", () => {
  it("every table of a customer page sits inside an overflow-x-auto container (a wide table scrolls, the page does not)", () => {
    const unwrapped: string[] = [];
    for (const file of customerFiles) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, index) => {
        if (!line.includes("<table")) return;
        const before = lines.slice(Math.max(0, index - 8), index).join("\n");
        if (!/overflow-x-auto/.test(before)) unwrapped.push(`${file}:${index + 1}`);
      });
    }
    expect(unwrapped).toEqual([]);
  });

  it("a table that can have many columns has a minimum width so it scrolls instead of squeezing the text (live preview, price tables, sample)", () => {
    expect(src("src/app/dashboard/chat/components/ActivityTerminal.tsx")).toContain('<table className="w-full min-w-[420px]');
    expect(src("src/app/pricing/page.tsx")).toContain("min-w-[640px]");
    expect(src("src/components/landing/Sections.tsx")).toContain("min-w-[560px]");
  });

  it("the results table: wide table in a focusable scroll region, cells that wrap, headers that do not", () => {
    const canvas = src("src/app/dashboard/chat/components/ResultsCanvas.tsx");
    expect(canvas).toContain('role="region" tabIndex={0}');
    expect(canvas).toContain("min-w-28 max-w-64 whitespace-normal break-words");
    expect(canvas).toContain('scope="col" className="whitespace-nowrap');
    expect(canvas).toContain('data-testid="table-scroll-hint"');
  });

  it("no customer page fixes a width above 360px for a phone (max-w-* with w-full, a variant like lg:w-[460px], or min-w on a scrolling table)", () => {
    const offenders: string[] = [];
    for (const file of customerFiles) {
      readFileSync(file, "utf8").split("\n").forEach((line, index) => {
        for (const match of line.matchAll(/(?<![-\w:])(?:min-)?w-\[(\d{3,})px\]/g)) {
          const px = Number(match[1]);
          if (px > 360 && !/<table/.test(line)) offenders.push(`${file}:${index + 1} w-[${px}px]`);
        }
        if (/(?:^|[^-\w])(?:width|minWidth):\s*(?:3[6-9]\d|[4-9]\d\d)\b/.test(line)) offenders.push(`${file}:${index + 1} inline width`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it("body wraps a pasted link or a long handle instead of widening the page, and the chat bubbles break words", () => {
    expect(src("src/app/globals.css")).toMatch(/body \{[^}]*overflow-wrap: break-word/);
    const chat = src("src/app/dashboard/chat/page.tsx");
    expect(chat).toContain("w-fit max-w-full break-words rounded-[18px] bg-sf2");
    expect(chat).toContain("whitespace-pre-wrap break-words");
  });

  it("the minimum-height of a public page follows the visible viewport (dvh), not the tall 100vh of a phone with a URL bar", () => {
    for (const file of customerFiles) expect(readFileSync(file, "utf8"), file).not.toMatch(/\bmin-h-screen\b|\bh-screen\b|100vh/);
    expect(src("src/app/page.tsx")).toContain("min-h-dvh");
    // the prices page sits inside the shared site frame (UI pass 1, item 12): the frame is as tall as the visible viewport and the page fills it
    expect(src("src/app/pricing/page.tsx")).toContain("min-h-full");
    expect(src("src/components/app/AppShell.tsx")).toContain('height: "var(--vvh, 100dvh)"');
  });
});

describe("audit phase 4: the header and the grids fit 390", () => {
  it("the landing header drops «خدماتنا» below 480px (logo, theme, login and sign-up already fill 390 with it)", () => {
    const header = src("src/components/landing/GlassHeader.tsx");
    expect(header).toMatch(/href="\/services" className="hidden [^"]*min-\[480px\]:flex/);
    expect(header).toContain('href="/login"');
    expect(header).toContain('href="/register"');
  });

  it("the wallet capacity chips wrap, so they never run past a 390 phone", () => {
    expect(src("src/app/dashboard/topup/page.tsx")).toContain('<div className="flex flex-wrap gap-1.5">');
  });

  it("no customer grid has three or more fixed columns without a responsive step, except the audited small ones", () => {
    const allowed = [/ActivityTerminal\.tsx/, /SubmittedCard\.tsx/, /requests\/page\.tsx/]; // 4 short KPI cells, 3 step dots, 3 short stat labels: checked by hand at 390
    const offenders: string[] = [];
    for (const file of customerFiles) {
      if (allowed.some((pattern) => pattern.test(file))) continue;
      readFileSync(file, "utf8").split("\n").forEach((line, index) => {
        if (line.includes('data-testid="topup-presets"')) return; // the five top-up amounts are ONE row by design, checked at 390
        for (const match of line.matchAll(/(?<![:\w-])grid-cols-([3-9])\b/g)) offenders.push(`${file}:${index + 1} grid-cols-${match[1]}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it("an Arabic sentence is never left-aligned: text-left stays on the left-to-right fields only", () => {
    const offenders: string[] = [];
    for (const file of customerFiles) {
      readFileSync(file, "utf8").split("\n").forEach((line, index) => {
        if (!/\btext-left\b/.test(line)) return;
        if (/dir="ltr"|authInput|type="email"|type="password"|<input/.test(line)) return;
        offenders.push(`${file}:${index + 1}`);
      });
    }
    expect(offenders).toEqual([]);
    expect(src("src/app/dashboard/chat/components/PlanQuoteCard.tsx")).toContain("text-start text-[13px] font-light leading-[1.9] text-mut min-[520px]:text-end");
    expect(src("src/app/dashboard/chat/components/RevisionQuoteCard.tsx")).toContain('className="text-start min-[520px]:text-end"');
  });
});

describe("audit phase 4: touch targets and text size", () => {
  it("every field is at least 16px (no iOS zoom on focus): the global rule is unlayered, so it wins over utility classes", () => {
    const css = src("src/app/globals.css");
    expect(css).toContain("input, textarea, select { font-size: max(16px, 1em); }");
    expect(css).not.toMatch(/@layer[^{]*\{[^}]*input, textarea, select \{ font-size/);
    expect(css).not.toMatch(/@layer base/);
  });

  it("no button or link of a customer page is shorter than 44px (hit-area helpers count)", () => {
    const BIG = /min-h-(?:11|12|14)\b|\bh-(?:11|12|14)\b|(?:min-)?h-\[(?:4[4-9]|[5-9]\d)px\]|\bhit\b|after:-inset-/;
    const SMALL = /\b(?:h|min-h)-(?:[4-9]|10)\b|\b(?:h|min-h)-\[(?:[1-3]\d|4[0-3])px\]/;
    const offenders: string[] = [];
    for (const file of customerFiles) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(/<(button|Link|a)\b/g)) {
        const className = /className=(?:"([^"]*)"|\{`([^`]*)`)/.exec(text.slice(match.index!, match.index! + 600));
        const classes = className?.[1] ?? className?.[2] ?? "";
        if (SMALL.test(classes) && !BIG.test(classes)) offenders.push(`${file}:${text.slice(0, match.index).split("\n").length}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the keyboard never covers the composer: viewport resizes content, the shell follows the visual viewport, the composer keeps the safe area", () => {
    const layout = src("src/app/layout.tsx");
    expect(layout).toContain('interactiveWidget: "resizes-content"');
    expect(layout).toContain('viewportFit: "cover"');
    const shell = src("src/components/app/AppShell.tsx");
    expect(shell).toContain("window.visualViewport");
    expect(shell).toContain('height: "var(--vvh, 100dvh)"');
    expect(src("src/app/dashboard/chat/components/Composer.tsx")).toContain('paddingBottom: "max(16px, env(safe-area-inset-bottom))"');
  });

  it("the results sheet keeps its buttons above the home indicator", () => {
    expect(src("src/app/dashboard/chat/page.tsx")).toContain("pb-[env(safe-area-inset-bottom)] shadow-2xl motion-reduce:animate-none lg:pb-0");
  });
});

describe("audit phase 4: the sidebar drawer", () => {
  const shell = src("src/components/app/AppShell.tsx");
  it("opens from the inline start (the right in Arabic), at most 320px and 86% wide, with an overlay that closes it", () => {
    expect(shell).toContain('insetInlineStart: 0');
    expect(shell).toContain('width: mobile ? "min(86%,320px)"');
    expect(shell).toContain('onClick={() => setDrawer(false)} aria-hidden="true" className="absolute inset-0 z-40"');
    expect(src("src/app/globals.css")).toContain("@keyframes drawer { from { transform: translateX(100%) } to { transform: none } }");
  });
  it("closes on navigation, on its close button (44px) and on Escape", () => {
    expect(shell).toContain("setDrawer(false); setAcctOpen(false); setNotifsOpen(false); }, [pathname]");
    expect(shell).toContain('aria-label="إغلاق القائمة" className="h-11 w-11');
    expect(shell).toContain('event.key === "Escape"');
  });
  it("the notifications panel and the account menu stay inside the screen on a phone", () => {
    expect(shell).toContain('width: "min(380px,calc(100% - 24px))"');
    expect(shell).toContain('maxHeight: "min(520px,calc(100% - 80px))"');
    expect(shell).toContain('width: "min(240px, calc(100vw - 88px))"');
  });
});
