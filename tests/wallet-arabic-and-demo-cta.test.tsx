import { createElement } from "react";
import { readFileSync, readdirSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: any) => createElement("a", { href, ...rest }, children) }));

const ledger = vi.hoisted(() => ({
  rows: [] as any[],
}));
vi.mock("../src/lib/server/userAuth", () => ({ authenticateUser: vi.fn(async () => ({ ok: true, user: { id: "u1" } })) }));
vi.mock("../src/lib/server/typedLedger", () => ({ fetchTypedLedger: vi.fn(async () => ledger.rows), fetchNewestLedgerRows: vi.fn(async () => [...ledger.rows].reverse()) }));
vi.mock("../src/lib/supabase/server", () => ({ createAdminClient: vi.fn(() => ({})) }));

import { GET as historyGet } from "../src/app/api/wallet/history/route";
import { walletDisplayText, walletNoteForDisplay } from "../src/lib/walletText";
import { DemoConversations } from "../src/components/landing/Sections";
import { buildLandingDemos } from "../src/lib/landingDemos";

const OLD_NOTE = "شراء صياغة المنهجية الأكاديمية للطلب job_quote_5f4dcc3b5aa765d61d8327deb882cf99";

describe("wallet text is Arabic only", () => {
  it("an old ledger note with an internal id reads as plain Arabic", () => {
    expect(walletNoteForDisplay(OLD_NOTE)).toBe("شراء صياغة المنهجية الأكاديمية لطلبك");
    expect(walletNoteForDisplay("شراء صياغة المنهجية الأكاديمية للطلب 123e4567-e89b-12d3-a456-426614174000")).toBe("شراء صياغة المنهجية الأكاديمية لطلبك");
    expect(walletNoteForDisplay("استرداد res_ab12cd34ef")).toBe("استرداد");
    expect(walletNoteForDisplay(OLD_NOTE)).not.toMatch(/job_quote|[A-Za-z0-9_]{12,}/);
  });

  it("a plain Arabic note is kept; an empty or foreign-language note shows nothing (the row keeps its Arabic label)", () => {
    expect(walletNoteForDisplay("شحن رصيد")).toBe("شحن رصيد");
    expect(walletNoteForDisplay("")).toBe("");
    expect(walletNoteForDisplay(null)).toBe("");
    expect(walletNoteForDisplay(undefined)).toBe("");
    expect(walletNoteForDisplay("manual adjustment by support")).toBe("");
  });

  it("product names in Latin letters get their Arabic spelling: ديجر، إنستاباي، الدفع اللحظي", () => {
    expect(walletDisplayText("اشحن عبر Instapay")).toBe("اشحن عبر إنستاباي");
    expect(walletDisplayText("شحن عبر انستاباي")).toBe("شحن عبر إنستاباي");
    expect(walletDisplayText("عنوان الدفع اللحظي (IPA) · منصة Diger")).toBe("عنوان الدفع اللحظي · منصة ديجر");
    expect(walletDisplayText("IPA")).toBe("الدفع اللحظي");
    expect(walletNoteForDisplay("شحن عبر Instapay إلى Diger")).toBe("شحن عبر إنستاباي إلى ديجر");
  });

  it("the wallet screens have no Latin product name in any visible Arabic string", () => {
    const dir = "src/app/dashboard/topup";
    for (const file of readdirSync(dir).filter((name) => name.endsWith(".tsx") || name.endsWith(".ts"))) {
      for (const [index, line] of readFileSync(`${dir}/${file}`, "utf8").split("\n").entries()) {
        const code = line.trim();
        if (code.startsWith("//") || code.startsWith("/*") || code.startsWith("*")) continue;
        if (/[؀-ۿ]/.test(code) && /Instapay|\bIPA\b|\bDiger\b/i.test(code)) throw new Error(`${file}:${index + 1}: ${code}`);
      }
    }
    const form = readFileSync("src/app/dashboard/topup/TopupForm.tsx", "utf8");
    expect(form).toContain("اشحن عبر إنستاباي");
    expect(form).toContain("عنوان الدفع اللحظي · منصة ديجر");
  });

  it("the history the customer is sent shows the clean note and label, and the stored row is never rewritten", async () => {
    const stored = { id: "chg_1", userId: "u1", delta: -50, type: "charge", kind: "charge", jobId: "job_quote_5f4dcc3b5aa765d61d8327deb882cf99", topupId: null, note: OLD_NOTE, createdAt: "2026-10-20T10:00:00Z", actorId: null };
    const topup = { id: "top_1", userId: "u1", delta: 500, type: "topup", kind: "topup_instapay", jobId: null, topupId: "t1", note: "Instapay top-up", createdAt: "2026-10-19T10:00:00Z", actorId: null };
    ledger.rows = [topup, stored];
    const snapshot = JSON.stringify(ledger.rows);
    const response = await historyGet({} as any);
    const body: any = await response.json();
    expect(body.success).toBe(true);
    const charge = body.rows.find((row: any) => row.id === "chg_1");
    expect(charge.note).toBe("شراء صياغة المنهجية الأكاديمية لطلبك");
    const topupRow = body.rows.find((row: any) => row.id === "top_1");
    expect(topupRow.labelAr).toBe("شحن عبر إنستاباي");
    expect(topupRow.note).toBe("");
    for (const row of body.rows) {
      expect(`${row.labelAr} ${row.note}`).not.toMatch(/[A-Za-z]/);
    }
    expect(JSON.stringify(ledger.rows)).toBe(snapshot);
  });

  it("the wallet page cleans notes and labels at render, whichever way the history was loaded", () => {
    const page = readFileSync("src/app/dashboard/topup/page.tsx", "utf8");
    expect(page).toContain("walletNoteForDisplay(l.note)");
    expect(page).toContain("walletDisplayText(row.labelAr ||");
  });
});

describe("the chat's own wording never prints «Diger» in Latin letters", () => {
  it("the provider-name replacement and the fixed answer say «منصة ديجر»", () => {
    for (const file of ["src/app/dashboard/chat/components/discoveryQuestions.ts", "src/functions/shared/clarification.ts", "src/functions/shared/personaConfigs.ts", "src/functions/shared/llmClient.ts"]) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toContain("منصة Diger");
      expect(source, file).toContain("منصة ديجر");
    }
  });
});

describe("landing demos: each static example has a sign-up button", () => {
  const html = renderToStaticMarkup(createElement(DemoConversations));
  const demos = buildLandingDemos();

  it("four demos, four «ابدأ مهمتك» buttons to sign up, one inside each card", () => {
    expect(demos).toHaveLength(4);
    const cards = html.split('data-testid="landing-demo"').slice(1);
    expect(cards).toHaveLength(4);
    for (const card of cards) {
      const body = card.split("</article>")[0];
      expect(body).toMatch(/<a href="\/register"[^>]*data-testid="demo-cta"[^>]*>ابدأ مهمتك<\/a>/);
    }
  });

  it("the demos stay static: no model, no provider, no network from the landing sources", () => {
    const sections = readFileSync("src/components/landing/Sections.tsx", "utf8");
    const demosSource = readFileSync("src/lib/landingDemos.ts", "utf8");
    for (const source of [sections, demosSource]) {
      expect(source).not.toMatch(/fetch\(|XMLHttpRequest|executeTurn|llmClient|tregAdapter|supabase/i);
    }
  });
});
