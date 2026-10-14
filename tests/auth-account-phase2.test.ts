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

    it("redirects already-authenticated user away from /login and /register without flashing form", async () => {
      mockAuthState.user = {
        id: "signed-in-user",
        email: "user@example.com",
        email_confirmed_at: new Date().toISOString(),
        user_metadata: {},
        app_metadata: { role: "user" },
      };

      const { middleware } = await import("../src/middleware");
      const loginReq = new NextRequest("http://localhost:3000/login", {
        headers: { Accept: "text/html" },
      });
      const loginRes = await middleware(loginReq);
      expect(loginRes.status).toBe(307);
      expect(loginRes.headers.get("location")).toContain("/dashboard/chat");

      const regReq = new NextRequest("http://localhost:3000/register", {
        headers: { Accept: "text/html" },
      });
      const regRes = await middleware(regReq);
      expect(regRes.status).toBe(307);
      expect(regRes.headers.get("location")).toContain("/dashboard/chat");
    });
  });

  describe("Step E: /admin Server Layout, Landing Session & /calculator Links", () => {
    it("AdminLayout redirects non-admin to /dashboard/chat and passes admin with app_metadata.role = 'admin'", async () => {
      const redirectCalls: string[] = [];
      vi.doMock("next/navigation", () => ({
        redirect: (url: string) => {
          redirectCalls.push(url);
          throw new Error(`NEXT_REDIRECT:${url}`);
        },
        useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
        usePathname: () => "/admin",
      }));
      vi.doMock("@/components/admin/AdminGate", () => ({
        AdminGate: ({ children }: any) => children,
      }));
      vi.doMock("@/lib/supabase/server", () => ({
        createServerSideClient: async () => ({
          auth: {
            getUser: async () => ({
              data: { user: mockAuthState.user },
              error: null,
            }),
          },
        }),
      }));

      const { default: AdminLayout } = await import("../src/app/admin/layout");

      // 1. Non-admin user is redirected to /dashboard/chat (not swallowed by catch)
      mockAuthState.user = {
        id: "non-admin-1",
        email: "member@diger.tech",
        email_confirmed_at: new Date().toISOString(),
        app_metadata: { role: "user" },
      };
      await expect(AdminLayout({ children: "admin-content" as any })).rejects.toThrow(
        "NEXT_REDIRECT:/dashboard/chat",
      );
      expect(redirectCalls).toContain("/dashboard/chat");

      // 2. Admin user with app_metadata.role = 'admin' passes without redirect
      redirectCalls.length = 0;
      mockAuthState.user = {
        id: "admin-1",
        email: "admin@diger.tech",
        email_confirmed_at: new Date().toISOString(),
        app_metadata: { role: "admin" },
      };
      const rendered = await AdminLayout({ children: "admin-content" as any });
      expect(redirectCalls).toHaveLength(0);
      expect(rendered).toBeTruthy();
    });

    it("links /calculator from landing header, landing footer, and dashboard sidebar, and prevents login/register flash", () => {
      const landingPage = readFileSync("src/app/page.tsx", "utf8");
      const glassHeader = readFileSync("src/components/landing/GlassHeader.tsx", "utf8");
      const sections = readFileSync("src/components/landing/Sections.tsx", "utf8");
      const appShell = readFileSync("src/components/app/AppShell.tsx", "utf8");
      const loginPage = readFileSync("src/app/login/page.tsx", "utf8");
      const registerPage = readFileSync("src/app/register/page.tsx", "utf8");

      // Landing page reads Supabase session on server and passes initialSignedIn
      expect(landingPage).toContain("createServerSideClient");
      expect(landingPage).toContain("initialSignedIn");
      expect(glassHeader).toContain('href="/dashboard/chat"');
      expect(glassHeader).toContain("لوحة التحكم");

      // /calculator linked in landing header, landing footer, and dashboard sidebar
      expect(glassHeader).toContain('href="/calculator"');
      expect(sections).toContain('href="/calculator"');
      expect(appShell).toContain('href: "/calculator"');

      // /login and /register never flash form when authLoading or user is truthy
      expect(loginPage).toContain("if (authLoading || user)");
      expect(registerPage).toContain("if (authLoading || user)");
    });
  });
});

