import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: any) => createElement("a", { href, ...rest }, children) }));
vi.mock("@/components/Brand", () => ({ Logo: () => createElement("span", null, "ديجر") }));

import ContactForm from "../src/app/contact/ContactForm";
import { cleanArText, getPublicCalculatorOptions } from "../src/lib/calculatorPricing";
import { PLATFORM_GUIDE, buildPlatformGuideServices } from "../src/functions/shared/platformGuide";
import { SUPPORT_PLACEHOLDER_AR } from "../src/lib/supportContact";

describe("item 8: Arabic-only public pages", () => {
  it("/services text has no @example and no sample handle", () => {
    const services = buildPlatformGuideServices();
    const text = services.map((s) => `${s.nameAr} ${s.descriptionAr} ${s.exampleAr} ${s.examplePlanAr}`).join(" ");
    expect(text).not.toMatch(/@example/i);
    expect(text).not.toMatch(/@\w/);
    const page = readFileSync("src/app/services/page.tsx", "utf8");
    expect(page).toContain("cleanArText(service.exampleAr)");
    expect(JSON.stringify(PLATFORM_GUIDE)).not.toMatch(/@example/i);
  });

  it("the calculator never shows a Latin «X»; the platform is written «إكس»", () => {
    expect(cleanArText("بحث منشورات منصة X (تويتر)")).toBe("بحث منشورات منصة إكس (تويتر)");
    expect(cleanArText("منشورات X")).toBe("منشورات إكس");
    expect(cleanArText("Next")).toBe("Next");
    for (const option of getPublicCalculatorOptions()) {
      expect(`${option.nameAr} ${option.descriptionAr}`).not.toMatch(/(^|[^A-Za-z0-9])X(?![A-Za-z0-9])/);
    }
  });

  it("/contact renders the support email and WhatsApp on the server pass, with no «coming soon»", () => {
    const html = renderToStaticMarkup(createElement(ContactForm, { initialSettings: { supportEmail: "help@diger.tech", whatsappNumber: "201000000000" } }));
    expect(html).toContain("help@diger.tech");
    expect(html).toContain("https://wa.me/201000000000");
    expect(html).not.toContain(SUPPORT_PLACEHOLDER_AR);
  });

  it("with only one channel set, the other card is hidden instead of saying «coming soon»", () => {
    const emailOnly = renderToStaticMarkup(createElement(ContactForm, { initialSettings: { supportEmail: "help@diger.tech", whatsappNumber: "" } }));
    expect(emailOnly).toContain("help@diger.tech");
    expect(emailOnly).not.toContain(SUPPORT_PLACEHOLDER_AR);
    const waOnly = renderToStaticMarkup(createElement(ContactForm, { initialSettings: { supportEmail: "", whatsappNumber: "201000000000" } }));
    expect(waOnly).toContain("wa.me/201000000000");
    expect(waOnly).not.toContain(SUPPORT_PLACEHOLDER_AR);
  });

  it("with nothing set the placeholder is still shown", () => {
    const html = renderToStaticMarkup(createElement(ContactForm, { initialSettings: { supportEmail: "", whatsappNumber: "" } }));
    expect(html).toContain(SUPPORT_PLACEHOLDER_AR);
  });

  it("the /contact page reads the settings on the server and is rendered per request", () => {
    const page = readFileSync("src/app/contact/page.tsx", "utf8");
    expect(page).toContain("loadSupportSettings()");
    expect(page).toContain('export const dynamic = "force-dynamic"');
    expect(page).toContain("initialSettings=");
  });
});
