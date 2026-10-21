"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { startNotificationPolling } from "@/lib/notificationPolling";
import { getSlowFactor } from "@/lib/degradedClient";

export type NotificationKind = "topup_approved" | "topup_rejected" | "job_done" | "refund" | "welcome";

export interface AppNotification {
  id: string;
  $id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  link?: string | null;
  read: boolean;
  readAt?: string | null;
  created_at: string;
  createdAt: string;
}

/**
 * In-app notifications from public.notifications. No live (Realtime) connection: every open page would hold one against a free-plan
 * ceiling of 200 for the whole room. The list is read once, then a cheap «anything newer?» check runs every 30 s (growing to 2 minutes
 * while nothing arrives, jittered, never in a hidden tab) and the full list is read again when the tab comes back to the front.
 */
export const NOTIFICATION_TICK_MS = 30_000;
export const NOTIFICATION_TICK_MAX_MS = 120_000;

export function useNotifications(userId: string | undefined) {
  const [items, setItems] = useState<AppNotification[]>([]);
  const newestRef = useRef<string | null>(null);

  const mapRow = useCallback((r: any): AppNotification => {
    return {
      id: r.id,
      $id: r.id,
      kind: (r.kind || "job_done") as NotificationKind,
      title: r.title,
      body: r.body,
      link: r.link,
      read: !!r.read,
      readAt: r.read ? (r.updated_at || r.created_at) : null,
      created_at: r.created_at,
      createdAt: r.created_at,
    };
  }, []);

  const load = useCallback(async () => {
    if (!userId) return;
    try {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("notifications")
        .select("*")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(30);

      if (error) {
        setItems([]);
        return;
      }
      newestRef.current = data && data.length ? String(data[0].created_at) : null;
      setItems((data || []).map(mapRow));
    } catch {
      // Offline or error: show empty panel rather than failing the shell
      setItems([]);
    }
  }, [userId, mapRow]);

  useEffect(() => { void load(); }, [load]);

  // The cheap check: only rows newer than the newest one already shown (an empty answer is a few hundred bytes).
  const checkNewer = useCallback(async (): Promise<boolean> => {
    if (!userId) return false;
    const supabase = createClient();
    let query = supabase.from("notifications").select("*").eq("user_id", userId).order("created_at", { ascending: false }).limit(30);
    if (newestRef.current) query = query.gt("created_at", newestRef.current);
    const { data, error } = await query;
    if (error || !data || data.length === 0) return false;
    newestRef.current = String(data[0].created_at);
    const fresh = data.map(mapRow);
    setItems((prev) => [...fresh, ...prev.filter((n) => !fresh.some((f) => f.id === n.id))].slice(0, 30));
    return true;
  }, [userId, mapRow]);

  useEffect(() => {
    if (!userId || typeof document === "undefined") return;
    return startNotificationPolling({
      load,
      tick: checkNewer,
      intervalMs: NOTIFICATION_TICK_MS,
      jitter: 0.2,
      slowFactor: getSlowFactor,
      backoff: { factor: 1.5, maxIntervalMs: NOTIFICATION_TICK_MAX_MS },
      isVisible: () => document.visibilityState !== "hidden",
      visibilityTarget: document,
      focusTarget: window,
    });
  }, [userId, load, checkNewer]);

  const unread = items.filter((n) => !n.read).length;

  const markAllRead = useCallback(async () => {
    if (!userId) return;
    setItems((prev) => prev.map((n) => ({ ...n, read: true, readAt: new Date().toISOString() })));
    try {
      const supabase = createClient();
      await supabase
        .from("notifications")
        .update({ read: true })
        .eq("user_id", userId)
        .eq("read", false);
    } catch {
      /* best effort */
    }
  }, [userId]);

  const markRead = useCallback(async (id: string) => {
    setItems((prev) => prev.map((n) => (n.id === id ? { ...n, read: true, readAt: new Date().toISOString() } : n)));
    try {
      const supabase = createClient();
      await supabase
        .from("notifications")
        .update({ read: true })
        .eq("id", id);
    } catch {
      /* best effort */
    }
  }, []);

  return { items, unread, markAllRead, markRead, reload: load };
}
