import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: () => {}, push: () => {} }),
  useSearchParams: () => new URLSearchParams(""),
}));
vi.mock("@/hooks/useUser", () => ({ useUser: () => ({ user: null, loading: false, register: async () => {}, login: async () => {}, logout: async () => {}, refresh: async () => null }) }));

import { AuthField, PasswordInput } from "../src/components/AuthLayout";
import LoginPage from "../src/app/login/page";
import RegisterPage from "../src/app/register/page";
import ForgotPage from "../src/app/forgot/page";
import ResetPage from "../src/app/reset/page";

/** Every text <input> with the visible <label for> tied to it (read with regexes: the suite runs in node, with no DOM). */
function parse(html: string) {
  const inputs = [...html.matchAll(/<input\b[^>]*>/g)].map((m) => m[0]);
  return inputs
    .filter((tag) => !/type="(hidden|submit|button|checkbox)"/.test(tag))
    .map((tag) => {
      const id = /\sid="([^"]+)"/.exec(tag)?.[1] ?? "";
      const label = id ? new RegExp(`<label[^>]*for="${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*>([^<]+)</label>`).exec(html)?.[1].trim() ?? "" : "";
      const placeholder = /\splaceholder="([^"]*)"/.exec(tag)?.[1] ?? "";
      return { tag, id, label, placeholder };
    });
}

const PAGES: Array<[string, unknown, string[]]> = [
  ["/login", LoginPage, ["البريد الإلكتروني", "كلمة المرور"]],
  ["/register", RegisterPage, ["الاسم", "البريد الإلكتروني", "كلمة المرور", "كود الدعوة (اختياري)"]],
  ["/forgot", ForgotPage, ["البريد الإلكتروني"]],
  ["/reset", ResetPage, ["كلمة المرور الجديدة", "تأكيد كلمة المرور"]],
];

describe("sign-in pages: every field keeps a visible label that does not disappear while typing", () => {
  for (const [path, Page, labels] of PAGES) {
    it(`${path}: each input has a <label for> with its own name (not the placeholder)`, () => {
      const found = parse(renderToStaticMarkup(createElement(Page as any)));
      expect(found.map((f) => f.label), path).toEqual(labels);
      for (const f of found) {
        expect(f.id, `${path} input without id`).not.toBe("");
        expect(f.tag).not.toContain("aria-label=");
      }
      expect(new Set(found.map((f) => f.id)).size, "ids are unique").toBe(found.length);
    });
  }

  it("a placeholder is only an example: no placeholder repeats its label or says «٨ خانات» (the old clipped password placeholder)", () => {
    for (const [path, Page] of PAGES) {
      for (const f of parse(renderToStaticMarkup(createElement(Page as any)))) {
        expect(f.placeholder, `${path} ${f.label}`).not.toBe(f.label);
        expect(f.placeholder, `${path} ${f.label}`).not.toContain("خانات");
      }
    }
  });

  it("the password hint is announced with the field, and the show button names what it shows", () => {
    const html = renderToStaticMarkup(createElement(PasswordInput as any, { value: "", onChange: () => {}, autoComplete: "new-password", hint: "٨ خانات على الأقل" }));
    const id = /<input[^>]*\sid="([^"]+)"/.exec(html)![1];
    expect(html).toContain(`aria-describedby="${id}-hint"`);
    expect(html).toContain(`<p id="${id}-hint"`);
    expect(html).toContain('aria-label="إظهار كلمة المرور"');
    expect(html).not.toContain("aria-pressed");
  });

  it("an error is tied to its field: aria-invalid, aria-describedby, role=alert, and it replaces the hint", () => {
    const html = renderToStaticMarkup(createElement(AuthField as any, { label: "كلمة المرور", hint: "تلميح", error: "قصيرة", id: "pw" }));
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('aria-describedby="pw-error"');
    expect(html).toMatch(/<p id="pw-error" role="alert"[^>]*>قصيرة<\/p>/);
    expect(html).not.toContain("تلميح");
  });

  it("a field without an error carries no aria-invalid", () => {
    const html = renderToStaticMarkup(createElement(AuthField as any, { label: "الاسم", id: "n" }));
    expect(html).not.toContain("aria-invalid");
    expect(html).not.toContain("aria-describedby");
  });
});
