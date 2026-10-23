/**
 * Redesign guardrails — static honesty and trust-boundary checks for the
 * Diger complete-UI-redesign branch.
 *
 * These tests read source files (no DOM rendering, no new dependencies) and
 * verify the non-negotiable product rules:
 *  - no literal UI placeholder text leaking into research parameters
 *  - no fabricated statistics, customers, or coverage claims
 *  - no internal provider identifiers or margins in customer-facing code
 *  - the clarification trust boundary holds (never "server-validated" defaults)
 *  - reduced-motion support is present in global styles
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();

/** Landing copy lives across the landing components (design V7). */
function landingSrc(): string {
  return ["src/app/page.tsx", "src/components/landing/Sections.tsx", "src/components/landing/HeroLens.tsx", "src/components/landing/data.ts"]
    .map((f) => src(f))
    .join("\n");
}

function src(relativePath: string): string {
  const full = join(ROOT, relativePath);
  if (!existsSync(full)) throw new Error(`missing source file: ${relativePath}`);
  return readFileSync(full, "utf-8");
}

describe("no placeholder text as research parameters", () => {
  it("chat page never shows the literal skip placeholder as an answer value", () => {
    const page = src("src/app/dashboard/chat/page.tsx");
    // The fixed summary maps skipped answers to the resolved value or an
    // explicit "will be asked" note — never the raw UI placeholder.
    expect(page).not.toMatch(/\?\s*"استخدم الافتراضي"/);
  });

  it("DetailsBlanks never submits the literal placeholder as a value", () => {
    const card = src("src/app/dashboard/chat/components/DetailsBlanks.tsx");
    expect(card).not.toContain('"استخدم الافتراضي"');
  });

  it("server formatter never emits the literal placeholder", () => {
    const fmt = src("src/functions/shared/clarification.ts");
    expect(fmt).not.toContain('"استخدم الافتراضي"');
  });
});

describe("no fabricated marketing claims", () => {
  it("landing page labels the demo as illustrative", () => {
    const landing = landingSrc();
    expect(landing).toContain("مثال توضيحي");
  });

  it("landing page contains no invented customer counts or success rates", () => {
    const landing = landingSrc();
    expect(landing).not.toMatch(/\d+\s*عميل/);
    // CSS percentages (masks, widths) are fine; marketing claims live in the copy module.
    expect(src("src/components/landing/data.ts").replace(/translate[XY]?\([^)]*\)/g, "")).not.toMatch(/\d+\s*%/);
    expect(landing).not.toContain("ضمان التغطية");
    expect(landing).not.toMatch(/\+?\d{3,}\s*(مستخدم|باحث)/);
  });
});

describe("no internal identifiers in customer-facing code", () => {
  const FORBIDDEN = ["TREG", "TikHub", "SerpApi", "OpenAI", "GPT-", "هامش الربح", "internal markup"];

  it("PlanQuoteCard exposes no provider internals or margins", () => {
    const card = src("src/app/dashboard/chat/components/PlanQuoteCard.tsx");
    for (const word of FORBIDDEN) expect(card).not.toContain(word);
  });

  it("landing pricing section shows no provider costs", () => {
    const landing = landingSrc();
    for (const word of FORBIDDEN) expect(landing).not.toContain(word);
  });
});

describe("honest financial presentation", () => {
  it("wallet page derives balance from the ledger, never hardcodes it", () => {
    const topup = src("src/app/dashboard/topup/page.tsx");
    expect(topup).toContain("CREDIT_LEDGER_COLLECTION");
    // No hardcoded demo balance.
    expect(topup).not.toMatch(/useState<number \| null>\(\d{3,}\)/);
  });

  it("quote expiry is displayed from real server data", () => {
    const card = src("src/app/dashboard/chat/components/PlanQuoteCard.tsx");
    expect(card).toContain("expiresAt");
    expect(card).toContain("formatExpiry");
  });
});

describe("accessibility foundations", () => {
  it("global styles respect prefers-reduced-motion", () => {
    const css = src("src/app/globals.css");
    expect(css).toContain("prefers-reduced-motion");
  });

  it("interactive discovery options expose checked state", () => {
    const card = src("src/app/dashboard/chat/components/DetailsBlanks.tsx");
    expect(card).toContain("aria-pressed");
  });

  it("root layout keeps Arabic RTL", () => {
    const layout = src("src/app/layout.tsx");
    expect(layout).toContain('lang="ar"');
    expect(layout).toContain('dir="rtl"');
  });
});

describe("data-honesty corrections (PR #11 fixes)", () => {
  const BALANCE_FILES = [
    "src/hooks/useBalance.tsx",
  ];

  it("no failed balance fetch presents as a fake zero", () => {
    for (const f of BALANCE_FILES) {
      const code = src(f);
      expect(code, f).not.toMatch(/set(Balance|UserBalance)\(0\)/);
      expect(code, f).not.toMatch(/\(balance \?\? 0\)/);
      expect(code, f).not.toMatch(/\(userBalance \?\? 0\)/);
    }
  });

  it("the chat and wallet read the shared ledger balance instead of their own copy", () => {
    expect(src("src/app/dashboard/chat/page.tsx")).toContain("useBalance()");
    const wallet = src("src/app/dashboard/topup/page.tsx");
    expect(wallet).toContain("useBalance()");
    expect(wallet).toContain("balanceText(balance)");
    expect(wallet).not.toMatch(/set(Balance|UserBalance)\(0\)/);
  });

  it("balance displays route through the honest-display helpers", () => {
    for (const f of BALANCE_FILES) {
      expect(src(f), f).toContain("balanceFailed()");
      expect(src(f), f).toContain("@/lib/honestDisplay");
    }
  });

  it("the running-jobs badge comes from the response total, not the page length", () => {
    const shell = src("src/components/app/AppShell.tsx");
    expect(shell).toContain("setRunning(res.total)");
  });

  it("activity timeline never marks stages complete from assumptions", () => {
    const tl = src("src/app/dashboard/chat/components/ActivityTerminal.tsx");
    expect(tl).not.toMatch(/done:\s*true/);
    expect(tl).toContain("timelineWaitingText");
    expect(tl).toContain("eventLimit");
  });

  it("methodology success never hardcodes a charge amount", () => {
    const chat = src("src/app/dashboard/chat/page.tsx");
    expect(chat).not.toContain("اقتطاع 10 نقاط");
    // The browser alert was replaced by an in-page confirmation and message (owner rule: no browser alerts).
    expect(chat).not.toMatch(/(?:window\.)?alert\(/);
    expect(chat).toContain("methodologyMessageText(data.chargedPoints");
  });

  it("event histories are fetched latest-first and scope-labeled", () => {
    const chat = src("src/app/dashboard/chat/page.tsx");
    expect(chat).toContain("orderDesc");
    expect(chat).toContain("EVENT_HISTORY_LIMIT");
    expect(chat).toContain("chronological(");
  });

});
