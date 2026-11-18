import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * DT-20261118-07: the landing page is static, so the header's server HTML is the same for everyone, and until the browser has hydrated and read the session the header shows NO button (live: about 5 seconds on a slow phone).
 * The first paint must already show the right button, from what the browser holds (the presence of the auth cookie, no network), and the real session still decides after hydration.
 */
const state = { user: null as unknown, loading: true };
vi.mock("@/hooks/useUser", () => ({ useUser: () => ({ user: state.user, loading: state.loading }), useOptionalUser: () => state.user }));
vi.mock("@/components/ThemeToggle", () => ({ ThemeToggle: () => null }));
vi.mock("@/components/Brand", () => ({ Logo: () => null }));

const render = async () => { const { GlassHeader } = await import("../src/components/landing/GlassHeader"); return renderToStaticMarkup(createElement(GlassHeader)); };

describe("the header's first paint (the session is not read yet)", () => {
  it("the server HTML carries both buttons, each marked for the one state it belongs to, so a script before first paint can show the right one", async () => {
    state.loading = true; state.user = null;
    const html = await render();
    expect(html).toContain("لوحة التحكم");
    expect(html).toContain("دخول");
    // [\s\S] instead of the «s» flag: the root tsconfig targets below ES2018 (tsc TS1501); the match is the same
    expect(html).toMatch(/auth-in-only[^>]*>(?:(?!<\/span>)[\s\S])*لوحة التحكم/);
    expect(html).toMatch(/auth-out-only[^>]*>(?:(?!<\/span>)[\s\S])*دخول/);
  });
  it("once the session is read, only the true button remains", async () => {
    state.loading = false; state.user = null;
    let html = await render();
    expect(html).toContain("دخول");
    expect(html).not.toContain("لوحة التحكم");
    state.user = { id: "u1" };
    html = await render();
    expect(html).toContain("لوحة التحكم");
    expect(html).not.toContain("دخول");
  });
});

describe("the pre-paint script (src/lib/authHint.ts)", () => {
  const run = async (cookie: string | "throw") => {
    const { AUTH_HINT_SCRIPT } = await import("../src/lib/authHint");
    const attrs: Record<string, string> = {};
    const doc = { documentElement: { setAttribute: (k: string, v: string) => { attrs[k] = v; } }, get cookie() { if (cookie === "throw") throw new Error("blocked"); return cookie; } };
    new Function("document", AUTH_HINT_SCRIPT)(doc);
    return attrs["data-auth"];
  };
  it("a sign-in cookie (also a chunked one, wherever it sits in the string) marks «in»; no cookie, another cookie or a blocked cookie jar marks «out»", async () => {
    expect(await run("sb-abcdefgh-auth-token=base64-xyz")).toBe("in");
    expect(await run("theme=dark; sb-abcdefgh-auth-token.0=aaa; sb-abcdefgh-auth-token.1=bbb")).toBe("in");
    expect(await run("")).toBe("out");
    expect(await run("theme=dark; guest_session_id=gst_1")).toBe("out");
    expect(await run("sb-abcdefgh-auth-token-code-verifier=zzz")).toBe("out");
    expect(await run("throw")).toBe("out");
  });
  it("the hint touches no network and no storage, and it is wired in the root layout and the style sheet", async () => {
    const { AUTH_HINT_SCRIPT } = await import("../src/lib/authHint");
    expect(AUTH_HINT_SCRIPT).not.toMatch(/fetch|XMLHttpRequest|localStorage|sendBeacon/);
    const { readFileSync } = await import("node:fs");
    expect(readFileSync("src/app/layout.tsx", "utf8")).toContain("AUTH_HINT_SCRIPT");
    expect(readFileSync("src/app/globals.css", "utf8")).toContain('html[data-auth="in"] .auth-out-only');
  });
});
