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
import { createClient } from "@/lib/supabase/client";
import type { User } from "@supabase/supabase-js";

export interface AppUser {
  id: string;
  $id: string; // compatibility alias
  email: string;
  name: string;
  emailVerification: boolean;
  labels: string[];
  app_metadata: Record<string, any>;
  user_metadata: Record<string, any>;
  prefs?: Record<string, any>;
  rawUser: User;
}

interface AuthContextType {
  user: AppUser | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<AppUser | null>;
  register: (email: string, password: string, name: string) => Promise<void>;
  /** Re-read the account (e.g. after email verification) and update the context. */
  refresh: () => Promise<AppUser | null>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | null>(null);

function mapSupabaseUser(u: User | null): AppUser | null {
  if (!u) return null;
  const isVerified = !!(u.email_confirmed_at || u.user_metadata?.email_verified);
  const isAdmin = u.app_metadata?.role === "admin";
  const name =
    u.user_metadata?.name ||
    u.user_metadata?.full_name ||
    u.email?.split("@")[0] ||
    "";

  return {
    id: u.id,
    $id: u.id,
    email: u.email || "",
    name,
    emailVerification: isVerified,
    labels: isAdmin ? ["admin"] : [],
    app_metadata: u.app_metadata || {},
    user_metadata: u.user_metadata || {},
    prefs: u.user_metadata?.prefs || {},
    rawUser: u,
  };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AppUser | null>(null);
  const [loading, setLoading] = useState(true);

  const getUser = useCallback(async () => {
    try {
      const supabase = createClient();
      const { data: { user: su }, error } = await supabase.auth.getUser();
      if (error || !su) {
        setUser(null);
        return null;
      }
      const mapped = mapSupabaseUser(su);
      setUser(mapped);
      return mapped;
    } catch {
      setUser(null);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const supabase = createClient();
    getUser();

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session?.user) {
        setUser(mapSupabaseUser(session.user));
      } else {
        setUser(null);
      }
      setLoading(false);
    });

    return () => {
      subscription.unsubscribe();
    };
  }, [getUser]);

  const login = async (email: string, password: string) => {
    const supabase = createClient();
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    if (error) throw error;
    const mapped = mapSupabaseUser(data.user);
    setUser(mapped);
    return mapped;
  };

  const register = async (email: string, password: string, name: string) => {
    const supabase = createClient();
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { name, full_name: name },
        emailRedirectTo: `${appBaseUrl()}/verify`,
      },
    });
    if (error) throw error;
    const mapped = mapSupabaseUser(data.user);
    setUser(mapped);
  };

  const logout = async () => {
    const supabase = createClient();
    await supabase.auth.signOut();
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
