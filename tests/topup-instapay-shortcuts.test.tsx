import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/hooks/useUser", () => ({ useUser: () => ({ user: { id: "u1", email: "a@b.test" }, loading: false }) }));
vi.mock("../src/lib/supabase/client", () => ({ createClient: () => ({}) }));

import TopupForm from "../src/app/dashboard/topup/TopupForm";
import { InstapayShortcuts } from "../src/app/dashboard/topup/InstapayShortcuts";
import { showsInstapayShortcuts, TOPUP_INSTAPAY_ADDRESS, TOPUP_INSTAPAY_QR_SRC, TOPUP_INSTAPAY_URL } from "../src/lib/topupConfig";

const src = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const form = (ipa: string | null, extra: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(TopupForm, { amount: 100, onAmount: () => {}, creditValue: 0.1, ipa, onSubmitted: () => {}, pendingCount: 0, maxPending: 3, ...extra } as never));

describe("the InstaPay link and QR on the top-up page", () => {
  it("the link: the owner's address from the config constant, a new tab, a safe rel, Arabic label", () => {
    expect(TOPUP_INSTAPAY_URL).toBe("https://ipn.eg/S/iammagdy/instapay/2dNSeG");
    const html = renderToStaticMarkup(createElement(InstapayShortcuts));
    const anchor = /<a [^>]*data-testid="instapay-link"[^>]*>/.exec(html)![0];
    expect(anchor).toContain(`href="${TOPUP_INSTAPAY_URL}"`);
    expect(anchor).toContain('target="_blank"');
    expect(anchor).toContain('rel="noopener noreferrer"');
    expect(html).toContain("افتح إنستاباي للدفع");
    // the URL lives in ONE constant: the component and the form hold no copy of it
    for (const file of ["src/app/dashboard/topup/InstapayShortcuts.tsx", "src/app/dashboard/topup/TopupForm.tsx", "src/app/dashboard/topup/page.tsx"]) expect(src(file), file).not.toMatch(/ipn\.eg|https?:\/\//);
    expect(src("src/lib/topupConfig.ts").match(/ipn\.eg/g)?.length).toBe(1);
  });

  it("the QR: the owner's file at a fixed 200 px box, Arabic alt text and caption, served as it is, on a white card", () => {
    const html = renderToStaticMarkup(createElement(InstapayShortcuts));
    const image = /<img [^>]*data-testid="instapay-qr"[^>]*>/.exec(html)![0];
    expect(image).toContain(`src="${TOPUP_INSTAPAY_QR_SRC}"`); // unoptimized: the file itself, not a re-encoded copy from the image server
    expect(image).toContain('alt="رمز الدفع عبر إنستاباي"');
    expect(image).toContain('width="200"');
    expect(image).toContain('height="200"');
    expect(image).toMatch(/h-\[200px\] w-\[200px\]/);
    expect(image).toContain("object-contain");
    expect(image).toContain("bg-white");
    expect(html).toContain("امسح الرمز من تطبيق إنستاباي");
    // the quiet zone is kept: a white card with padding around the image, and no rounding, filter or blend on the image itself
    expect(html).toMatch(/class="rounded-xl bg-white p-2"/);
    expect(image).not.toMatch(/rounded|filter|blend|opacity|grayscale|invert/);
    expect(src("src/app/dashboard/topup/InstapayShortcuts.tsx")).toContain("unoptimized");
    const visible = html.replace(/<[^>]*>/g, " ");
    expect(visible).not.toMatch(/\p{Extended_Pictographic}|[0-9A-Za-z]/u); // the words the customer reads: Arabic only, no emoji, no digits
  });

  it("the image file is the owner's, unchanged: a 795 x 824 JPEG of 153535 bytes", () => {
    const path = "public/instapay-qr.jpeg";
    expect(statSync(path).size).toBe(153535);
    const bytes = readFileSync(path);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe("3af991a99b995cf18f403ff10afdaeb4f967c398fc15c62ad1a56a37ddd6ecbb");
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xff, 0xd8, 0xff]);
    // the frame header: height then width
    let i = 2; let size = "";
    while (i < bytes.length) { const marker = bytes[i + 1]; const length = bytes.readUInt16BE(i + 2); if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) { size = `${bytes.readUInt16BE(i + 7)}x${bytes.readUInt16BE(i + 5)}`; break; } i += 2 + length; }
    expect(size).toBe("795x824");
  });

  it("the address text, its label, the copy button and the receipt upload are still there, unchanged", () => {
    const html = form(TOPUP_INSTAPAY_ADDRESS);
    expect(html).toContain("iammagdy@instapay");
    expect(html).toContain("عنوان الدفع اللحظي · منصة ديجر");
    expect(html).toContain(">نسخ<");
    expect(html).toContain('accept="image/png,image/jpeg,image/webp,application/pdf"');
    expect(html).toContain('data-testid="instapay-shortcuts"');
    // the shortcuts sit right under the address row and before the receipt picker
    expect(html.indexOf("iammagdy@instapay")).toBeLessThan(html.indexOf('data-testid="instapay-shortcuts"'));
    expect(html.indexOf('data-testid="instapay-shortcuts"')).toBeLessThan(html.indexOf('type="file"'));
  });

  it("the link and the QR show only while the saved address is that account: any other address, or none, hides them (no money to the wrong place)", () => {
    expect(showsInstapayShortcuts("iammagdy@instapay")).toBe(true);
    expect(showsInstapayShortcuts("  IAMMAGDY@InstaPay ")).toBe(true);
    for (const other of ["someone.else@instapay", "iammagdy@instapay.evil", "xiammagdy@instapay", "", null, undefined]) expect(showsInstapayShortcuts(other as never), String(other)).toBe(false);
    expect(form("someone.else@instapay")).not.toContain("instapay-shortcuts");
    expect(form(null)).not.toContain("instapay-shortcuts");
    expect(form(null, { loadingIpa: true })).not.toContain("instapay-qr");
  });

  it("nothing of the top-up logic changed: the submit route, the ledger and the pricing are untouched by this change", () => {
    const form = src("src/app/dashboard/topup/TopupForm.tsx");
    expect(form).toContain("compressReceipt");
    expect(form).toContain("TOPUP_ERROR_MESSAGES");
    expect(form).not.toMatch(/instapay-qr|ipn\.eg/);
  });
});
