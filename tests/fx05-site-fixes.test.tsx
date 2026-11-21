import { existsSync, readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const nav = vi.hoisted(() => ({ redirected: [] as string[] }));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    nav.redirected.push(path);
    throw new Error("NEXT_REDIRECT");
  },
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: any) => <a href={href} {...props}>{children}</a>,
}));

import { checkCustomerText } from "../src/lib/agentMission/text";
import { SUPPORT_PLACEHOLDER_AR } from "../src/lib/supportContact";
import NotFound from "../src/app/not-found";
import sitemap from "../src/app/sitemap";
import ContactForm from "../src/app/contact/ContactForm";

describe("FX-05: Site Fixes", () => {
  describe("1. Redirects", () => {
    it("redirects /dashboard/wallet to /dashboard/topup", async () => {
      nav.redirected = [];
      const mod = await import("../src/app/dashboard/wallet/page");
      const DashboardWalletRedirect = mod.default;
      expect(() => DashboardWalletRedirect()).toThrow("NEXT_REDIRECT");
      expect(nav.redirected).toContain("/dashboard/topup");
    });

    it("redirects /wallet to /dashboard/topup", async () => {
      nav.redirected = [];
      const mod = await import("../src/app/wallet/page");
      const WalletRedirect = mod.default;
      expect(() => WalletRedirect()).toThrow("NEXT_REDIRECT");
      expect(nav.redirected).toContain("/dashboard/topup");
    });

    it("counter-case: exact static routes only, no wildcards", () => {
      expect(existsSync("src/app/dashboard/topup/page.tsx")).toBe(true);
      expect(existsSync("src/app/dashboard/wallet-anything-else/page.tsx")).toBe(false);
      const nextConfig = existsSync("next.config.mjs") ? readFileSync("next.config.mjs", "utf8") : "";
      expect(nextConfig).not.toMatch(/redirect.*wallet/i);
    });
  });

  describe("2. 404 page (src/app/not-found.tsx)", () => {
    it("uses V7 theme tokens, RTL arrow, links to /, and passes checkCustomerText", () => {
      const html = renderToStaticMarkup(<NotFound />);
      const source = readFileSync("src/app/not-found.tsx", "utf8");

      expect(html).toContain('href="/"');
      expect(html).toContain("→");
      expect(html).not.toContain("←");
      expect(html).not.toContain('href="/dashboard/chat"');

      // V7 theme tokens in markup / source
      for (const token of ["bg-bg", "bg-sf", "border-ln2", "text-ink", "bg-ac", "text-onac"]) {
        expect(source).toContain(token);
      }

      // Zero hardcoded light palette classes
      for (const oldClass of ["bg-white", "text-white", "bg-sand-50", "bg-ink-900", "text-ink-"]) {
        expect(source).not.toContain(oldClass);
      }

      const plainText = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      expect(checkCustomerText(plainText).issues).toEqual([]);
    });
  });

  describe("3. Sitemap (src/app/sitemap.ts)", () => {
    it("includes https://diger.tech/help and retains existing canonical URLs", () => {
      const entries = sitemap();
      const urls = entries.map((e) => e.url);

      expect(urls).toContain("https://diger.tech/help");
      expect(urls).toContain("https://diger.tech/");
      expect(urls).toContain("https://diger.tech/services");
      expect(urls).toContain("https://diger.tech/pricing");
      expect(urls).toContain("https://diger.tech/calculator");
      expect(urls).toContain("https://diger.tech/register");
      expect(urls).toContain("https://diger.tech/login");
      expect(urls).toContain("https://diger.tech/contact");
      expect(urls).toContain("https://diger.tech/legal/terms");
      expect(urls).toContain("https://diger.tech/legal/privacy");
    });
  });

  describe("4. Contact page (src/app/contact/ContactForm.tsx)", () => {
    it("with empty settings: does NOT contain واتساب or wa.me, renders email placeholder", () => {
      const html = renderToStaticMarkup(<ContactForm initialSettings={{ supportEmail: "", whatsappNumber: "" }} />);
      expect(html).not.toContain("واتساب");
      expect(html).not.toContain("wa.me");
      expect(html).toContain(SUPPORT_PLACEHOLDER_AR);
    });

    it("with only email set: contains email and does NOT contain واتساب or wa.me", () => {
      const html = renderToStaticMarkup(<ContactForm initialSettings={{ supportEmail: "help@diger.tech", whatsappNumber: "" }} />);
      expect(html).toContain("help@diger.tech");
      expect(html).not.toContain("واتساب");
      expect(html).not.toContain("wa.me");
    });

    it("with whatsapp set: contains wa.me link and واتساب", () => {
      const html = renderToStaticMarkup(<ContactForm initialSettings={{ supportEmail: "", whatsappNumber: "201000000000" }} />);
      expect(html).toContain("https://wa.me/201000000000");
      expect(html).toContain("واتساب");
    });
  });
});
