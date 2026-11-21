import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/hooks/useUser", () => ({ useUser: () => ({ user: { id: "u1", email: "a@b.test", user_metadata: {} }, loading: false }) }));
vi.mock("../src/lib/supabase/client", () => ({ createClient: () => ({}) }));

import TopupForm from "../src/app/dashboard/topup/TopupForm";
import PromoCodeBox from "../src/app/dashboard/topup/PromoCodeBox";
import { egpClipboardText } from "../src/lib/topupAmount";
import { topupStepsDone } from "../src/lib/topupSteps";

const src = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const form = () =>
  renderToStaticMarkup(createElement(TopupForm, { creditValue: 0.1, ipa: "iammagdy@instapay", onSubmitted: () => {}, pendingCount: 0, maxPending: 3 } as never));
const PAGE = "src/app/dashboard/topup/page.tsx";

describe("the five amounts are ONE row", () => {
  it("one grid container of five equal columns holds the four presets and «أخرى», in that order", () => {
    const html = form();
    const start = html.indexOf('data-testid="topup-presets"');
    expect(start).toBeGreaterThan(0);
    const container = html.slice(html.lastIndexOf("<div", start), html.indexOf("</div>", start));
    expect(container).toMatch(/class="[^"]*\bgrid\b[^"]*\bgrid-cols-5\b/);
    expect(container).not.toMatch(/flex-wrap/);
    const buttons = container.match(/<button\b/g) ?? [];
    expect(buttons).toHaveLength(5);
    const texts = [...container.matchAll(/<button\b[^>]*>(.*?)<\/button>/g)].map((m) => m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
    expect(texts[0]).toContain("١٬٠٠٠");
    expect(texts[1]).toContain("٢٬٥٠٠");
    expect(texts[2]).toContain("٥٬٠٠٠");
    expect(texts[3]).toContain("١٠٬٠٠٠");
    expect(texts[4]).toContain("أخرى");
    expect(texts[4]).toContain("مبلغ تختاره");
    expect(container).toContain('data-testid="topup-custom"');
    expect((container.match(/aria-pressed="true"/g) ?? []).length).toBe(1); // ٢٬٥٠٠ is the one selected
    for (const button of buttons) expect(button).toBeTruthy();
    expect((container.match(/min-w-0/g) ?? []).length).toBe(5); // each may shrink: the row never grows past a 390 phone
  });
});

describe("the numbered steps", () => {
  it("the three circles show ١ ٢ ٣ and at first only step ١ is done (the default 2500 is valid)", () => {
    const html = form();
    const steps = [...html.matchAll(/data-testid="topup-step-(\d)"\s+data-done="(true|false)"[^>]*>([^<]*)</g)].map((m) => [m[1], m[2], m[3]]);
    expect(steps).toEqual([["1", "true", "١"], ["2", "false", "٢"], ["3", "false", "٣"]]);
    expect(html).toContain("اختر عدد النقاط");
    expect(html).toContain("حوّل المبلغ من تطبيق إنستاباي");
    expect(html).toContain("ارفع الإيصال وأرسل الطلب");
  });

  it("the circles follow the state: valid amount, amount copied, receipt attached", () => {
    expect(topupStepsDone({ amountValid: true, amountCopied: false, receiptAttached: false })).toEqual([true, false, false]);
    expect(topupStepsDone({ amountValid: true, amountCopied: true, receiptAttached: false })).toEqual([true, true, false]);
    expect(topupStepsDone({ amountValid: true, amountCopied: true, receiptAttached: true })).toEqual([true, true, true]);
    expect(topupStepsDone({ amountValid: false, amountCopied: false, receiptAttached: true })).toEqual([false, false, true]);
    expect(topupStepsDone({ amountValid: false, amountCopied: true, receiptAttached: false })).toEqual([false, false, false]); // a copied number of an amount that is no longer valid is not a done step
  });

  it("the form feeds the helper from the real state, and a done circle is filled while an open one is not", () => {
    const code = src("src/app/dashboard/topup/TopupForm.tsx");
    expect(code).toContain("amountCopied: amountEgp !== null && copiedAmount === amountEgp");
    expect(code).toContain("receiptAttached: file !== null");
    expect(code).toContain("setCopiedAmount(amountEgp)");
    expect(code).toContain('done ? "bg-ac text-onac" : "bg-sf2 text-ink2"');
  });

  it("a step never gates the server: the request body is still the amount and the receipt, and the submit button does not read a step", () => {
    const code = src("src/app/dashboard/topup/TopupForm.tsx");
    expect(code).toMatch(/body: JSON\.stringify\(\{\s*amountEgp,\s*receiptFileId,\s*\}\)/);
    expect(code).toContain("disabled={sending || problem !== null}");
    expect(code).not.toMatch(/disabled=\{[^}]*stepDone/);
    expect(src("src/app/api/topup/submit/route.ts")).not.toMatch(/stepDone|topupStepsDone|data-done/);
  });
});

describe("the promo form moved into the balance card and still works the same way", () => {
  it("it is the same form with the same handler, endpoint, messages and button", () => {
    const html = renderToStaticMarkup(createElement(PromoCodeBox, { onRedeemed: () => {} }));
    expect(html).toContain("<form");
    expect(html).toContain('aria-label="كود ترويجي"');
    expect(html).toContain('type="submit"');
    expect(html).toContain("تطبيق الكود");
    expect(html).toContain("عندك كود ترويجي؟");
    expect(html).toContain("تُضاف نقاطه إلى رصيدك فورًا.");
    expect(html).toContain('role="status"');
    const box = src("src/app/dashboard/topup/PromoCodeBox.tsx");
    expect(box).toContain("<form onSubmit={submit}");
    expect(box).toContain('fetch("/api/wallet/redeem"');
    expect(box).toContain("body: JSON.stringify({ code })");
    expect(box).toContain("onRedeemed();");
    expect(box).toContain('data.messageAr || "تم تطبيق الكود."');
    expect(box).toContain("تعذر الاتصال الآن. تأكد من الإنترنت وحاول مرة أخرى.");
  });

  it("the page mounts it exactly once, inside the dark balance card, with the same refresh callback", () => {
    const page = src(PAGE);
    expect(page.match(/<PromoCodeBox\b/g)).toHaveLength(1);
    const card = page.slice(page.indexOf('data-testid="wallet-balance-card"'), page.indexOf("</section>", page.indexOf('data-testid="wallet-balance-card"')));
    expect(card).toContain("<PromoCodeBox onRedeemed={() => { void refreshBalance(); void loadLedger(); }} />");
    expect(card).toContain('data-testid="wallet-released-month"');
    expect(card).toContain('data-testid="wallet-capacity"');
  });
});

describe("copy amount still copies the number only", () => {
  it("the button is there, off while the amount is invalid, and writes the plain number", () => {
    const html = form();
    expect(html).toMatch(/data-testid="topup-copy-amount"[^>]*>نسخ المبلغ</);
    expect(html).not.toMatch(/data-testid="topup-copy-amount"[^>]*\sdisabled=""/); // valid default amount
    const code = src("src/app/dashboard/topup/TopupForm.tsx");
    expect(code).toContain("disabled={amountEgp === null}");
    expect(code).toContain("navigator.clipboard?.writeText(egpClipboardText(amountEgp))");
    expect(code).toContain('{amountCopied ? "تم النسخ" : "نسخ المبلغ"}');
    expect(code).toContain("setTimeout(() => setAmountCopied(false), 1800)"); // the one existing feedback timer
    expect(egpClipboardText(250)).toBe("250");
    expect(egpClipboardText(1000)).toBe("1000");
    expect(egpClipboardText(123.5)).toBe("123.5");
  });

  it("the pay box shows the amount large with the points under it, and «—» when the amount is not valid", () => {
    const html = form();
    expect(html).toContain(">ستحوّل<");
    expect(/data-testid="topup-egp-due-text"[^>]*>٢٥٠ جنيه</.test(html)).toBe(true);
    expect(html).toContain("مقابل ٢٬٥٠٠ نقطة");
    const code = src("src/app/dashboard/topup/TopupForm.tsx");
    expect(code).toContain('amountEgp === null ? "—"');
  });
});

describe("the design's rules for this page", () => {
  const files = ["src/app/dashboard/topup/page.tsx", "src/app/dashboard/topup/TopupForm.tsx", "src/app/dashboard/topup/PromoCodeBox.tsx", "src/app/dashboard/topup/InstapayShortcuts.tsx"];

  it("every colour comes from the theme tokens: no raw hex in the wallet files, and the new tokens are registered once", () => {
    for (const file of files) expect(src(file), file).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    const css = src("src/app/globals.css");
    for (const token of ["card", "deep", "line", "pill", "ondark", "ondark-mut", "ondark-faint", "amber", "dot", "promo", "promo-ink", "promo-sub", "promo-line", "promo-ok", "promo-bad"]) {
      expect(css, token).toContain(`--wallet-${token}:`);
      expect(css, token).toContain(`--color-wallet-${token}: var(--wallet-${token});`);
    }
    expect(css).toMatch(/:root,\s*\[data-theme="light"\],\s*\[data-theme="dark"\] \{\s*--wallet-card/); // the card is the same dark teal in both themes
  });

  it("the balance zone and the month panel sit side by side and wrap only when the card is narrow; the top-up steps and QR column wrap too", () => {
    const page = src(PAGE);
    expect(page).toContain("flex flex-wrap items-stretch gap-x-6 gap-y-4");
    expect(page).toContain("flex-[1_1_240px]");
    expect(page).toContain("flex-[1_1_220px]");
    const code = src("src/app/dashboard/topup/TopupForm.tsx");
    expect(code).toContain("flex flex-wrap items-stretch gap-4");
    expect(code).toContain("flex-[3_1_320px]");
    expect(code).toContain("flex-[2_1_240px]");
    expect(code).toContain("flex flex-wrap gap-3"); // the receipt and the send button stack on a phone
  });

  it("the word «حجز مؤقت مُحرَّر» and the tab «حجز مُحرَّر» are kept; one review sentence only; no Google Fonts; no emoji", () => {
    const page = src(PAGE);
    expect(page).toContain('["refund", "حجز مُحرَّر"]');
    expect(src("src/lib/creditKinds.ts")).toContain("حجز مؤقت مُحرَّر");
    const form_ = src("src/app/dashboard/topup/TopupForm.tsx");
    expect(form_.match(/topupReviewSentenceAr\(/g)).toHaveLength(1);
    expect(form_).not.toContain("غالبًا يتم الاعتماد خلال ١٥ دقيقة</"); // the header copy of the mock is not added
    for (const file of files) {
      expect(src(file), file).not.toMatch(/googleapis|gstatic/);
      expect(src(file).replace(/✓/g, ""), file).not.toMatch(/\p{Extended_Pictographic}/u);
    }
  });

  it("the «+ شحن الرصيد» button still scrolls to the top-up card, which now has the id topup", () => {
    const page = src(PAGE);
    expect(page).toContain('id="topup"');
    expect(page).toContain("onClick={scrollToForm}");
    expect(page).toContain("+ شحن الرصيد");
  });

  it("the requests list and the history are full-width cards; the data, the filter tabs and their logic are the same", () => {
    const page = src(PAGE);
    expect(page).toContain('const LEDGER_TABS: Array<["all" | LedgerKind, string]> = [["all", "الكل"], ["topup", "شحن"], ["charge", "خصم وحجز"], ["refund", "حجز مُحرَّر"]];');
    expect(page).toContain("visibleLedgerRows(ledger, ledFilter)");
    expect(page).toContain("onClick={() => setLedFilter(id)}");
    expect(page.match(/rounded-\[24px\] border border-ln bg-sf/g)?.length).toBeGreaterThanOrEqual(2);
  });
});
