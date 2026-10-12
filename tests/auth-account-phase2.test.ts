import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";

const mockAuthState = vi.hoisted(() => ({
  user: null as any,
  authError: null as any,
}));

vi.mock("@supabase/ssr", () => ({
  createServerClient: vi.fn(() => ({
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: mockAuthState.user },
        error: mockAuthState.authError,
      })),
    },
  })),
}));

describe("Phase 2: Auth, Account & Middleware Guardrails", () => {
  const middlewareFile = readFileSync("src/middleware.ts", "utf8");
  const useUserFile = readFileSync("src/hooks/useUser.tsx", "utf8");
  const useBalanceFile = readFileSync("src/hooks/useBalance.tsx", "utf8");
  const useNotificationsFile = readFileSync("src/hooks/useNotifications.ts", "utf8");
  const adminGateFile = readFileSync("src/components/admin/AdminGate.tsx", "utf8");
  const adminLayoutFile = readFileSync("src/app/admin/layout.tsx", "utf8");

  beforeEach(() => {
    mockAuthState.user = null;
    mockAuthState.authError = null;
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://mock.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "mock-anon-key");
  });

  describe("File contracts and architectural rules", () => {
    it("middleware refreshes session via @supabase/ssr createServerClient", () => {
      expect(middlewareFile).toContain("@supabase/ssr");
      expect(middlewareFile).toContain("createServerClient");
      expect(middlewareFile).toContain("auth.getUser()");
    });

    it("middleware protects /dashboard/* and /admin/* and returns 403 on unverified email", () => {
      expect(middlewareFile).toContain('pathname.startsWith("/dashboard")');
      expect(middlewareFile).toContain('pathname.startsWith("/admin")');
      expect(middlewareFile).toContain("403");
      expect(middlewareFile).toContain("فعّل بريدك الإلكتروني أولًا لبدء البحث.");
      expect(middlewareFile).toContain("/login");
      expect(middlewareFile).toContain("/verify");
    });

    it("useBalance sums own credit_ledger.delta via RLS and never shows fake zero", () => {
      expect(useBalanceFile).toContain(".from(\"credit_ledger\")");
      expect(useBalanceFile).toContain(".select(\"delta\")");
      expect(useBalanceFile).toContain("balanceFailed()");
      expect(useBalanceFile).not.toContain("appwrite");
    });

    it("useNotifications reads from notifications table with realtime support", () => {
      expect(useNotificationsFile).toContain(".from(\"notifications\")");
      expect(useNotificationsFile).toContain("postgres_changes");
      expect(useNotificationsFile).not.toContain("appwrite");
    });

    it("useUser maps Supabase user and checks admin role via app_metadata", () => {
      expect(useUserFile).toContain("@/lib/supabase/client");
      expect(useUserFile).toContain("app_metadata");
      expect(useUserFile).toContain('role === "admin"');
      expect(useUserFile).toContain("appBaseUrl()");
      expect(useUserFile).not.toContain("appwrite");
    });

    it("AdminGate and AdminLayout enforce admin role via app_metadata", () => {
      expect(adminGateFile).toContain('app_metadata?.role === "admin"');
      expect(adminLayoutFile).toContain('app_metadata?.role === "admin"');
      expect(adminLayoutFile).toContain("createServerSideClient");
    });
  });

  describe("Middleware execution logic", () => {
    it("redirects unauthenticated user accessing /dashboard/chat to /login", async () => {
      mockAuthState.user = null;

      const { middleware } = await import("../src/middleware");
      const req = new NextRequest("http://localhost:3000/dashboard/chat");

      const res = await middleware(req);
      expect(res.status).toBe(307);
      expect(res.headers.get("location")).toContain("/login");
    });

    it("returns 403 for unverified user calling with JSON accept header", async () => {
      mockAuthState.user = {
        id: "unverified-user",
        email: "unverified@example.com",
        email_confirmed_at: null,
        user_metadata: {},
        app_metadata: {},
      };

      const { middleware } = await import("../src/middleware");
      const req = new NextRequest("http://localhost:3000/dashboard/chat", {
        headers: { Accept: "application/json" },
      });

      const res = await middleware(req);
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error).toBe("فعّل بريدك الإلكتروني أولًا لبدء البحث.");
    });

    it("redirects unverified user accessing /dashboard/chat via browser to /verify", async () => {
      mockAuthState.user = {
        id: "unverified-user",
        email: "unverified@example.com",
        email_confirmed_at: null,
        user_metadata: {},
        app_metadata: {},
      };

      const { middleware } = await import("../src/middleware");
      const req = new NextRequest("http://localhost:3000/dashboard/chat", {
        headers: { Accept: "text/html" },
      });

      const res = await middleware(req);
      expect(res.status).toBe(307);
      expect(res.headers.get("location")).toContain("/verify");
    });

    it("blocks non-admin from /admin/* with redirect to /dashboard/chat", async () => {
      mockAuthState.user = {
        id: "regular-user",
        email: "user@example.com",
        email_confirmed_at: new Date().toISOString(),
        user_metadata: {},
        app_metadata: { role: "user" },
      };

      const { middleware } = await import("../src/middleware");
      const req = new NextRequest("http://localhost:3000/admin/topups", {
        headers: { Accept: "text/html" },
      });

      const res = await middleware(req);
      expect(res.status).toBe(307);
      expect(res.headers.get("location")).toContain("/dashboard/chat");
    });

    it("allows verified admin into /admin/topups", async () => {
      mockAuthState.user = {
        id: "admin-user",
        email: "admin@example.com",
        email_confirmed_at: new Date().toISOString(),
        user_metadata: {},
        app_metadata: { role: "admin" },
      };

      const { middleware } = await import("../src/middleware");
      const req = new NextRequest("http://localhost:3000/admin/topups", {
        headers: { Accept: "text/html" },
      });

      const res = await middleware(req);
      expect(res.status).toBe(200);
    });
  });
});
