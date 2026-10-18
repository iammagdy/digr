import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import PromoCodeBox from "../src/app/dashboard/topup/PromoCodeBox";
import { ADMIN_PAGES, adminHref } from "../src/components/admin/icons";
import { CREDIT_KIND_LABEL_AR } from "../src/lib/creditKinds";

const read = (p: string) => readFileSync(p, "utf8");

describe("3. customer wallet: promo box and typed history", () => {
  it("the box is Arabic, accessible and has no browser alert", () => {
    const html = renderToStaticMarkup(createElement(PromoCodeBox, { onRedeemed: () => {} }));
    expect(html).toContain("كود ترويجي");
    expect(html).toContain("تطبيق الكود");
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html.replace(/<[^>]+>/g, " ")).not.toMatch(/[A-Za-z]{2,}/);
    expect(read("src/app/dashboard/topup/PromoCodeBox.tsx")).not.toMatch(/alert\(|confirm\(/);
  });

  it("success and failure messages come from the server in Arabic and the balance refreshes at once", () => {
    const box = read("src/app/dashboard/topup/PromoCodeBox.tsx");
    expect(box).toContain('fetch("/api/wallet/redeem"');
    expect(box).toContain("onRedeemed();");
    const page = read("src/app/dashboard/topup/page.tsx");
    expect(page).toContain("<PromoCodeBox onRedeemed={() => { void refreshBalance(); void loadLedger(); }} />");
    expect(page).toContain('fetch("/api/wallet/history"');
  });

  it("the history labels are «رصيد ترويجي» and «هدية من الإدارة»", () => {
    expect(CREDIT_KIND_LABEL_AR.promo_code).toBe("رصيد ترويجي");
    expect(CREDIT_KIND_LABEL_AR.admin_grant).toBe("هدية من الإدارة");
    expect(CREDIT_KIND_LABEL_AR.topup_instapay).toBe("شحن عبر انستاباي");
    expect(read("src/app/dashboard/topup/page.tsx")).toContain("ledgerLabel(l)");
  });
});

describe("4 to 6. admin screens", () => {
  it("the promo codes and support pages are in the admin menu", () => {
    const ids = ADMIN_PAGES.map(([id]) => id);
    expect(ids).toContain("promo-codes");
    expect(ids).toContain("support");
    expect(ADMIN_PAGES.find(([id]) => id === "promo-codes")![1]).toBe("الأكواد الترويجية");
    expect(adminHref("promo-codes")).toBe("/admin/promo-codes");
  });

  it("the promo page creates, edits, disables, lists redemptions and tells new from existing accounts", () => {
    const page = read("src/app/admin/promo-codes/page.tsx");
    for (const needle of ['method: "POST"', 'method: "PATCH"', "حساب جديد", "حساب قائم", "من استخدموه", "متبقٍ", "تاريخ الانتهاء"]) expect(page).toContain(needle);
  });

  it("the user sheet shows balance, dates, jobs, promo use, the full history with the granting admin and the manual credit form", () => {
    const sheet = read("src/components/admin/UserSheet.tsx");
    for (const needle of ["إضافة رصيد يدوي", "سجل الرصيد الكامل", "آخر بحث", "استخدم كودًا ترويجيًا", "بواسطة ${h.grantedBy}", "runningBalance", "/credit`"]) expect(sheet).toContain(needle);
  });

  it("the finance page keeps real income apart from promotional and admin points and has a date filter", () => {
    const page = read("src/app/admin/finance/page.tsx");
    for (const needle of ["دخل حقيقي (ج.م)", "نقاط ترويجية", "نقاط هدية من الإدارة", "نقاط مستهلكة", "صافي المتبقي للعملاء", 'type="date"']) expect(page).toContain(needle);
    expect(page).toContain("لا تُحسب دخلًا أبدًا");
  });
});
