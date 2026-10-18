import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  isEmailPreferenceEnabled,
  getRecipient,
  sendPlatformEmail,
  TEMPLATE_CATEGORY_MAP,
  formatArabicDate,
  resolveDisplayName,
} from "../src/lib/server/sendPlatformEmail";

describe("Platform Email Preferences & Server-Side Enforcement", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  describe("Template category mapping & defaults", () => {
    it("maps all 6 approved templates correctly", () => {
      expect(TEMPLATE_CATEGORY_MAP["welcome"]).toBeNull();
      expect(TEMPLATE_CATEGORY_MAP["topup-received"]).toBe("topup");
      expect(TEMPLATE_CATEGORY_MAP["topup-approved"]).toBe("topup");
      expect(TEMPLATE_CATEGORY_MAP["topup-rejected"]).toBe("topup");
      expect(TEMPLATE_CATEGORY_MAP["job-done"]).toBe("done");
      expect(TEMPLATE_CATEGORY_MAP["refund"]).toBe("refund");
    });

    it("allows welcome template unconditionally regardless of user preferences", () => {
      expect(isEmailPreferenceEnabled("welcome", null)).toBe(true);
      expect(isEmailPreferenceEnabled("welcome", {})).toBe(true);
      expect(
        isEmailPreferenceEnabled("welcome", {
          prefs: { notif: { topup: false, done: false, refund: false, news: false } },
        })
      ).toBe(true);
    });

    it("defaults topup, done, and refund to true when prefs are missing or invalid", () => {
      expect(isEmailPreferenceEnabled("topup-received", null)).toBe(true);
      expect(isEmailPreferenceEnabled("topup-approved", undefined)).toBe(true);
      expect(isEmailPreferenceEnabled("topup-rejected", {})).toBe(true);
      expect(isEmailPreferenceEnabled("job-done", { prefs: null })).toBe(true);
      expect(isEmailPreferenceEnabled("refund", { prefs: "invalid" as any })).toBe(true);
      expect(isEmailPreferenceEnabled("refund", { prefs: { notif: null } })).toBe(true);
    });

    it("respects explicit opt-out (false) in user_metadata.prefs.notif", () => {
      const prefsOptedOut = {
        prefs: {
          notif: {
            topup: false,
            done: false,
            refund: false,
          },
        },
      };

      expect(isEmailPreferenceEnabled("topup-received", prefsOptedOut)).toBe(false);
      expect(isEmailPreferenceEnabled("topup-approved", prefsOptedOut)).toBe(false);
      expect(isEmailPreferenceEnabled("topup-rejected", prefsOptedOut)).toBe(false);
      expect(isEmailPreferenceEnabled("job-done", prefsOptedOut)).toBe(false);
      expect(isEmailPreferenceEnabled("refund", prefsOptedOut)).toBe(false);
    });

    it("respects explicit opt-in (true) in user_metadata.prefs.notif", () => {
      const prefsOptedIn = {
        prefs: {
          notif: {
            topup: true,
            done: true,
            refund: true,
          },
        },
      };

      expect(isEmailPreferenceEnabled("topup-received", prefsOptedIn)).toBe(true);
      expect(isEmailPreferenceEnabled("topup-approved", prefsOptedIn)).toBe(true);
      expect(isEmailPreferenceEnabled("topup-rejected", prefsOptedIn)).toBe(true);
      expect(isEmailPreferenceEnabled("job-done", prefsOptedIn)).toBe(true);
      expect(isEmailPreferenceEnabled("refund", prefsOptedIn)).toBe(true);
    });

    it("allows independent preference toggling per category", () => {
      const mixedPrefs = {
        prefs: {
          notif: {
            topup: true,
            done: false,
            refund: true,
          },
        },
      };

      expect(isEmailPreferenceEnabled("topup-approved", mixedPrefs)).toBe(true);
      expect(isEmailPreferenceEnabled("job-done", mixedPrefs)).toBe(false);
      expect(isEmailPreferenceEnabled("refund", mixedPrefs)).toBe(true);
    });
  });

  describe("getRecipient with preference enforcement", () => {
    it("returns null when user has opted out of the template category", async () => {
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const mockAdminClient = {
        auth: {
          admin: {
            getUserById: vi.fn(async () => ({
              data: {
                user: {
                  id: "usr_opted_out",
                  email: "user@example.com",
                  user_metadata: {
                    name: "أحمد",
                    prefs: { notif: { topup: false } },
                  },
                },
              },
              error: null,
            })),
          },
        },
      };

      const result = await getRecipient(mockAdminClient, "usr_opted_out", "topup-approved");
      expect(result).toBeNull();
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining("[email:preference_disabled] template=topup-approved category=topup")
      );
    });

    it("returns recipient when user has opted into the template category", async () => {
      const mockAdminClient = {
        auth: {
          admin: {
            getUserById: vi.fn(async () => ({
              data: {
                user: {
                  id: "usr_opted_in",
                  email: "user@example.com",
                  user_metadata: {
                    name: "سارة محمد",
                    prefs: { notif: { topup: true } },
                  },
                },
              },
              error: null,
            })),
          },
        },
      };

      const result = await getRecipient(mockAdminClient, "usr_opted_in", "topup-approved");
      expect(result).toEqual({
        email: "user@example.com",
        name: "سارة محمد",
      });
    });

    it("handles missing user or database error gracefully without throwing", async () => {
      const mockAdminClient = {
        auth: {
          admin: {
            getUserById: vi.fn(async () => ({
              data: { user: null },
              error: { message: "User not found" },
            })),
          },
        },
      };

      const result = await getRecipient(mockAdminClient, "usr_unknown", "job-done");
      expect(result).toBeNull();
    });

    it("handles malformed admin client without auth.admin gracefully", async () => {
      const brokenClient = {};
      const result = await getRecipient(brokenClient as any, "usr_123", "job-done");
      expect(result).toBeNull();
    });
  });

  describe("sendPlatformEmail resilience & timeout", () => {
    it("safely ignores missing or invalid email addresses without throwing", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      await sendPlatformEmail("welcome", "", { Name: "تست" });
      await sendPlatformEmail("welcome", "not-an-email", { Name: "تست" });
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("safely handles missing environment variables without throwing", async () => {
      delete process.env.NEXT_PUBLIC_SUPABASE_URL;
      delete process.env.SUPABASE_SERVICE_ROLE_KEY;
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      await expect(
        sendPlatformEmail("welcome", "user@example.com", { Name: "تست" })
      ).resolves.not.toThrow();

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("reason=missing_config")
      );
    });

    it("sends request with AbortSignal timeout and handles fetch error safely", async () => {
      process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
      process.env.SUPABASE_SERVICE_ROLE_KEY = "mock_service_key";

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network timeout"));
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      await expect(
        sendPlatformEmail("welcome", "user@example.com", { Name: "تست" })
      ).resolves.not.toThrow();

      expect(fetchSpy).toHaveBeenCalled();
      const fetchCallArgs = fetchSpy.mock.calls[0];
      expect(fetchCallArgs[0]).toBe("https://example.supabase.co/functions/v1/send-email");
      expect((fetchCallArgs[1] as any)?.signal).toBeDefined();
      expect(errorSpy).toHaveBeenCalledWith("[email:send_failed] template=welcome reason=network_error");
      expect(JSON.stringify(errorSpy.mock.calls)).not.toContain("user@example.com");
    });
  });

  describe("Formatting helpers", () => {
    it("formats Arabic dates correctly", () => {
      expect(formatArabicDate("2026-10-14T10:00:00Z")).toContain("14");
      expect(formatArabicDate("2026-10-14T10:00:00Z")).toContain("أكتوبر");
      expect(formatArabicDate("2026-10-14T10:00:00Z")).toContain("2026");
    });

    it("resolves display names with full_name > name > email > fallback", () => {
      expect(
        resolveDisplayName({ email: "test@example.com", user_metadata: { full_name: "محمد أحمد" } })
      ).toBe("محمد أحمد");

      expect(
        resolveDisplayName({ email: "test@example.com", user_metadata: { name: "أحمد" } })
      ).toBe("أحمد");

      expect(resolveDisplayName({ email: "researcher@diger.tech" })).toBe("researcher");
      expect(resolveDisplayName({})).toBe("عزيزنا العميل");
    });
  });
});
