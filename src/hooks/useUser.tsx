"use client";

import { appBaseUrl } from "@/lib/site";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  type ReactNode,
} from "react";
import { account } from "@/lib/appwrite";
import { type Models } from "appwrite";

interface AuthContextType {
  user: Models.User<Models.Preferences> | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<Models.User<Models.Preferences> | null>;
  register: (email: string, password: string, name: string) => Promise<void>;
  /** Re-read the account (e.g. after email verification) and update the context. */
  refresh: () => Promise<Models.User<Models.Preferences> | null>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<Models.User<Models.Preferences> | null>(
    null,
  );
  const [loading, setLoading] = useState(true);

  const syncBrowserAuthCookies = useCallback(async () => {
    if (typeof document === "undefined") return;
    try {
      const fallbackRaw = window.localStorage?.getItem("cookieFallback");
      if (fallbackRaw) {
        const parsed = JSON.parse(fallbackRaw);
        if (parsed && typeof parsed === "object") {
          for (const [k, v] of Object.entries(parsed)) {
            if (k.startsWith("a_session_") && typeof v === "string" && v) {
              document.cookie = `${k}=${encodeURIComponent(v)}; Path=/; SameSite=Lax`;
            }
          }
        }
      }
    } catch {}
    try {
      const { jwt } = await account.createJWT();
      if (jwt) {
        document.cookie = `diger_jwt=${encodeURIComponent(jwt)}; Path=/; Max-Age=840; SameSite=Lax`;
      }
    } catch {}
  }, []);

  const clearBrowserAuthCookies = useCallback(() => {
    if (typeof document === "undefined") return;
    document.cookie = "diger_jwt=; Path=/; Max-Age=0; SameSite=Lax";
    document.cookie = "digr_jwt=; Path=/; Max-Age=0; SameSite=Lax"; // legacy name, pre-rebrand
  }, []);

  const getUser = useCallback(async () => {
    try {
      const session = await account.get();
      setUser(session);
      await syncBrowserAuthCookies();
      return session;
    } catch {
      setUser(null);
      clearBrowserAuthCookies();
      return null;
    } finally {
      setLoading(false);
    }
  }, [syncBrowserAuthCookies, clearBrowserAuthCookies]);

  useEffect(() => {
    getUser();
  }, [getUser]);

  const login = async (email: string, password: string) => {
    await account.createEmailPasswordSession(email, password);
    return getUser();
  };

  const register = async (email: string, password: string, name: string) => {
    await account.create("unique()", email, password, name);
    await login(email, password);
    // Email must be verified before top-ups / research (see /verify). A failed send
    // is not fatal: the verify screen has a resend button.
    try {
      await account.createVerification(`${appBaseUrl()}/verify`);
    } catch { /* resend available on /verify */ }
  };

  const logout = async () => {
    await account.deleteSession("current");
    clearBrowserAuthCookies();
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, loading, login, register, logout, refresh: getUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useUser() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useUser must be used within an AuthProvider");
  }
  return context;
}
