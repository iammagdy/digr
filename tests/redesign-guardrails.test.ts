/**
 * Redesign guardrails — static honesty and trust-boundary checks for the
 * Digr complete-UI-redesign branch.
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

  it("DiscoveryCard never submits the literal placeholder as a value", () => {
    const card = src("src/app/dashboard/chat/components/DiscoveryCard.tsx");
    expect(card).not.toContain('"استخدم الافتراضي"');
  });

  it("server formatter never emits the literal placeholder", () => {
    const fmt = src("src/functions/shared/clarification.ts");
    expect(fmt).not.toContain('"استخدم الافتراضي"');
  });
});

describe("no fabricated marketing claims", () => {
  it("landing hero submits a real question and does not show a simulated completed job", () => {
    const landing = src("src/app/page.tsx");
    const hero = src("src/app/components/HeroLens.tsx");
    expect(landing).toContain("<HeroLens />");
    expect(hero).toContain("savePendingQuestion");
    expect(hero).not.toContain("تم تسليم");
    expect(hero).not.toContain("مكتمل");
  });

  it("landing page contains no invented customer counts or success rates", () => {
    const landing = src("src/app/page.tsx");
    expect(landing).not.toMatch(/\d+\s*عميل/);
    expect(landing).not.toMatch(/\d+\s*%/);
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
    const landing = src("src/app/page.tsx");
    for (const word of FORBIDDEN) expect(landing).not.toContain(word);
  });
});

describe("honest financial presentation", () => {
  it("wallet page derives balance from the ledger, never hardcodes it", () => {
    const topup = src("src/app/dashboard/topup/page.tsx");
    expect(topup).toContain("credit_ledger");
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
    const card = src("src/app/dashboard/chat/components/DiscoveryCard.tsx");
    expect(card).toContain("aria-checked");
  });

  it("root layout keeps Arabic RTL", () => {
    const layout = src("src/app/layout.tsx");
    expect(layout).toContain('lang="ar"');
    expect(layout).toContain('dir="rtl"');
  });
});

describe("redesign wiring stays on existing routes", () => {
  it("landing question is preserved through auth and prefilled in chat without auto-sending", () => {
    const hero = src("src/app/components/HeroLens.tsx");
    const chat = src("src/app/dashboard/chat/page.tsx");
    expect(hero).toContain("savePendingQuestion");
    expect(chat).toContain("takePendingQuestion");
    expect(chat).toContain("setInputText((current) => current || initialQuestion)");
    expect(chat).not.toMatch(/initialQuestion[\s\S]{0,240}handleSendMessage/);
    expect(src("src/components/AuthLayout.tsx")).not.toContain("سؤالك محفوظ");
  });

  it("chat retains official branding and the existing theme control", () => {
    const chat = src("src/app/dashboard/chat/page.tsx");
    expect(chat).toContain("<BrandLogo size=\"small\" />");
    expect(chat).toContain("<ThemeToggle className=\"h-10 w-10\" />");
    expect(chat).toContain("chat-workspace__header");
  });

  it("lens reveals only the text clipped by the visible magnifier and keeps words in a flow", () => {
    const css = src("src/app/globals.css");
    const hero = src("src/app/components/HeroLens.tsx");
    expect(css).toContain("mask-image: radial-gradient(circle var(--lens-radius)");
    expect(css).toContain("--lens-diameter: 170px");
    expect(css).toContain("--lens-radius: 85px");
    expect(css).toContain("--lens-diameter: 112px; --lens-radius: 56px");
    expect(hero).toContain("mobile ? 80 + Math.sin");
    expect(css).not.toContain("circle 172px");
    expect(hero).not.toContain("record.x");
    expect(hero).toContain("RECORD_TERMS");
  });
});

describe("data-honesty corrections (PR #11 fixes)", () => {
  const BALANCE_FILES = [
    "src/app/dashboard/page.tsx",
    "src/app/dashboard/layout.tsx",
    "src/app/dashboard/topup/page.tsx",
    "src/app/dashboard/chat/page.tsx",
  ];

  it("no failed balance fetch presents as a fake zero", () => {
    for (const f of BALANCE_FILES) {
      const code = src(f);
      expect(code, f).not.toMatch(/set(Balance|UserBalance)\(0\)/);
      expect(code, f).not.toMatch(/\(balance \?\? 0\)/);
      expect(code, f).not.toMatch(/\(userBalance \?\? 0\)/);
    }
  });

  it("balance displays route through the honest-display helpers", () => {
    for (const f of BALANCE_FILES) {
      expect(src(f), f).toContain("balanceFailed()");
      expect(src(f), f).toContain("@/lib/honestDisplay");
    }
  });

  it("dashboard job total comes from the response total, not the page length", () => {
    const page = src("src/app/dashboard/page.tsx");
    expect(page).toContain("jobsRes.total");
    expect(page).toContain("jobTotalFromResponse");
    expect(page).not.toMatch(/إجمالي طلبات البحث[\s\S]{0,400}recentJobs\.length/);
  });

  it("activity timeline never marks stages complete from assumptions", () => {
    const tl = src("src/app/dashboard/chat/components/ActivityTimeline.tsx");
    expect(tl).not.toMatch(/done:\s*true/);
    expect(tl).toContain("timelineWaitingText");
    expect(tl).toContain("eventLimit");
  });

  it("methodology success never hardcodes a charge amount", () => {
    const chat = src("src/app/dashboard/chat/page.tsx");
    expect(chat).not.toContain("اقتطاع 10 نقاط");
    expect(chat).toContain("methodologyAlertText(data.chargedPoints)");
    expect(chat).toContain("methodologyMessageText(data.chargedPoints");
  });

  it("event histories are fetched latest-first and scope-labeled", () => {
    const jobs = src("src/app/dashboard/jobs/page.tsx");
    expect(jobs).toContain("orderDesc");
    expect(jobs).toContain("eventHistoryScopeLabel");
    const chat = src("src/app/dashboard/chat/page.tsx");
    expect(chat).toContain("EVENT_HISTORY_LIMIT");
    expect(chat).toContain("chronological(");
  });
});
