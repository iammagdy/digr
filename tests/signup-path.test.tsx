import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const nav = vi.hoisted(() => ({ redirected: [] as string[] }));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => { nav.redirected.push(path); throw new Error("NEXT_REDIRECT"); },
  useRouter: () => ({ replace: () => {}, push: () => {} }),
  useSearchParams: () => new URLSearchParams("promo=conf26"),
}));
vi.mock("@/hooks/useUser", () => ({ useUser: () => ({ user: null, loading: false, register: async () => {}, login: async () => {}, logout: async () => {}, refresh: async () => null }) }));

import {
  PENDING_PROMO_KEY, PENDING_PROMO_MAX_ATTEMPTS, clearPendingPromo, normalizePromoCode, notePromoAttempt, readPendingPromo, registerPathForCode, savePendingPromo,
} from "../src/lib/signupPromo";
import {
  AUTH_FAILURE_AR, LATE_EMAIL_AFTER_SECONDS, LATE_EMAIL_HINT_AR, RESEND_COOLDOWNS_SECONDS, RESEND_LIMIT_REACHED_AR, RESEND_MAX_SENDS, authFailureMessageAr, classifyAuthFailure, resendState, resendWaitAr,
} from "../src/lib/authHelp";
import RegisterPage from "../src/app/register/page";
import JoinPage from "../src/app/join/page";
import JoinWithCode from "../src/app/join/[code]/page";
import EmptyChat from "../src/app/dashboard/chat/components/EmptyChat";

const memoryStore = () => {
  const map = new Map<string, string>();
  return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v), removeItem: (k: string) => void map.delete(k), map };
};

describe("the invitation code of a QR or a link", () => {
  it("is normalised the way the redeem box takes it, and a malformed one is dropped", () => {
    expect(normalizePromoCode(" conf26 ")).toBe("CONF26");
    expect(normalizePromoCode("a b c")).toBe("ABC");
    for (const bad of ["", "ab", "x".repeat(41), "كود", "a;drop table", null, undefined, 12]) expect(normalizePromoCode(bad as any), String(bad)).toBeNull();
  });
  it("waits in the browser through the e-mail confirmation, is read back, and is cleared", () => {
    const store = memoryStore();
    expect(savePendingPromo(store, "conf26")).toBe(true);
    expect(readPendingPromo(store)).toEqual({ code: "CONF26", attempts: 0 });
    notePromoAttempt(store, readPendingPromo(store)!);
    expect(readPendingPromo(store)).toEqual({ code: "CONF26", attempts: 1 });
    clearPendingPromo(store);
    expect(store.map.has(PENDING_PROMO_KEY)).toBe(false);
    expect(readPendingPromo(store)).toBeNull();
  });
  it("a broken or hostile stored value is never used, and a missing store is no error", () => {
    const store = memoryStore();
    store.setItem(PENDING_PROMO_KEY, "{not json");
    expect(readPendingPromo(store)).toBeNull();
    store.setItem(PENDING_PROMO_KEY, JSON.stringify({ code: "<script>", attempts: 0 }));
    expect(readPendingPromo(store)).toBeNull();
    expect(savePendingPromo(null, "CONF26")).toBe(false);
    expect(readPendingPromo(undefined)).toBeNull();
    expect(PENDING_PROMO_MAX_ATTEMPTS).toBeGreaterThanOrEqual(2);
  });
  it("the QR path goes to sign-up with the code in its field, never a code that is not one", () => {
    expect(registerPathForCode("conf26")).toBe("/register?promo=CONF26");
    expect(registerPathForCode("x")).toBe("/register");
    expect(registerPathForCode(undefined)).toBe("/register");
    nav.redirected.length = 0;
    return JoinPage({ searchParams: Promise.resolve({ code: "conf26" }) }).catch(() => undefined)
      .then(() => JoinWithCode({ params: Promise.resolve({ code: "vip-1" }) }).catch(() => undefined))
      .then(() => JoinPage({ searchParams: Promise.resolve({}) }).catch(() => undefined))
      .then(() => expect(nav.redirected).toEqual(["/register?promo=CONF26", "/register?promo=VIP-1", "/register"]));
  });
});

describe("sign-up on a phone: three fields, the invitation code inside it, nothing else in the way", () => {
  const html = renderToStaticMarkup(createElement(RegisterPage as any));
  it("the code field is there, already filled from the link, optional, and Arabic-labelled", () => {
    expect(html).toContain('data-testid="signup-promo"');
    expect(html).toContain('value="CONF26"');
    expect(html).toContain("كود الدعوة (اختياري)");
  });
  it("name, e-mail and password are the only required fields", () => {
    expect((html.match(/required=""/g) || []).length).toBe(3);
    expect(html).not.toMatch(/data-testid="signup-promo"[^>]*required|required[^>]*data-testid="signup-promo"/);
    expect(html).toContain("إنشاء الحساب");
  });
  it("the page stores the code for after the confirmation, only when one was given", () => {
    const source = readFileSync("src/app/register/page.tsx", "utf8");
    expect(source).toContain("savePendingPromo");
    expect(source).toContain("if (promo.trim())");
    expect(source.indexOf("await register(")).toBeLessThan(source.indexOf("savePendingPromo("));
  });
});

describe("after the e-mail is confirmed: the first templates, the balance in the welcome, the code redeemed once", () => {
  it("the empty chat shows the templates and the welcome line with the points, and no line at zero", () => {
    const withBalance = renderToStaticMarkup(createElement(EmptyChat as any, { firstName: "منى", zeroBalance: false, balance: 250, onStart: () => {} }));
    expect(withBalance).toContain('data-testid="mission-templates"');
    expect(withBalance).toContain("رصيدك الآن ٢٥٠ نقطة");
    expect(withBalance).toContain("ولا يُخصم منها إلا ما يُسلَّم لك فعلًا");
    const none = renderToStaticMarkup(createElement(EmptyChat as any, { firstName: "", zeroBalance: true, balance: 0, onStart: () => {} }));
    expect(none).not.toContain("welcome-balance");
  });
  it("the redeem goes through the existing redeem route once the account is verified, and the stored code is cleared on success and on a plain refusal", () => {
    const hook = readFileSync("src/hooks/usePendingPromo.ts", "utf8");
    expect(hook).toContain('"/api/wallet/redeem"');
    expect(hook).toContain("clearPendingPromo(store)");
    expect(hook).toContain("PENDING_PROMO_MAX_ATTEMPTS");
    const chat = readFileSync("src/app/dashboard/chat/page.tsx", "utf8");
    expect(chat).toContain("usePendingPromo(Boolean(user?.emailVerification)");
  });
});

describe("when the sign-in service is rate limited or the e-mail is late", () => {
  it("each failure has its own plain sentence, Arabic only, no technical word", () => {
    expect(classifyAuthFailure({ status: 429 })).toBe("rate_limited");
    expect(classifyAuthFailure({ code: "over_request_rate_limit" })).toBe("rate_limited");
    expect(classifyAuthFailure({ code: "over_email_send_rate_limit" })).toBe("email_rate_limited");
    expect(classifyAuthFailure({ message: "Email rate limit exceeded" })).toBe("email_rate_limited");
    expect(classifyAuthFailure({ message: "Failed to fetch" })).toBe("offline");
    expect(classifyAuthFailure({ status: 409 })).toBe("exists");
    expect(classifyAuthFailure({ message: "Invalid login credentials" })).toBe("invalid_credentials");
    expect(classifyAuthFailure(new Error("boom"))).toBe("unknown");
    for (const text of Object.values(AUTH_FAILURE_AR)) if (text) expect(text).not.toMatch(/[A-Za-z]|\d/);
    expect(authFailureMessageAr({ status: 429 }, "x")).toContain("نفس الشبكة");
    expect(authFailureMessageAr(new Error("boom"), "حدث خطأ")).toBe("حدث خطأ");
  });
  it("the resend button has its own limits: free the first time, then 30, 60, 120 and 180 seconds, and four presses at most", () => {
    expect(RESEND_COOLDOWNS_SECONDS).toEqual([30, 60, 120, 180]);
    expect(resendState(0, 0)).toEqual({ allowed: true, waitSeconds: 0, sendsLeft: RESEND_MAX_SENDS });
    expect(resendState(1, 10)).toEqual({ allowed: false, waitSeconds: 20, sendsLeft: 3 });
    expect(resendState(1, 30)).toMatchObject({ allowed: true, waitSeconds: 0 });
    expect(resendState(2, 30)).toMatchObject({ allowed: false, waitSeconds: 30 });
    expect(resendState(3, 119)).toMatchObject({ allowed: false, waitSeconds: 1 });
    expect(resendState(4, 10_000)).toEqual({ allowed: false, waitSeconds: 0, sendsLeft: 0 });
    expect(resendState(99, 0).allowed).toBe(false);
  });
  it("a late message is said to be late, the limit has its own sentence, the wait is in Arabic digits", () => {
    expect(LATE_EMAIL_AFTER_SECONDS).toBe(90);
    expect(LATE_EMAIL_HINT_AR).toContain("قد تتأخر بضع دقائق");
    expect(RESEND_LIMIT_REACHED_AR).toContain("الحد الأقصى لإعادة الإرسال");
    expect(resendWaitAr(20)).toBe("أُرسلت — يمكنك الطلب مجددًا بعد ٢٠ ثانية");
    expect(LATE_EMAIL_HINT_AR + RESEND_LIMIT_REACHED_AR).not.toMatch(/[A-Za-z]/);
  });
  it("the verify page counts a press before the call (a failing press still uses the allowance), keeps the count for the tab, and shows the late hint", () => {
    const source = readFileSync("src/app/verify/page.tsx", "utf8");
    expect(source).toContain("sessionStorage");
    expect(source.indexOf("writeSends({ count: sends.count + 1")).toBeLessThan(source.indexOf("supabase.auth.resend("));
    expect(source).toContain('data-testid="late-email-hint"');
    expect(source).toContain("sendsLeft === 0");
  });
});
