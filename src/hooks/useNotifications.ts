"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { startNotificationPolling } from "@/lib/notificationPolling";
import { getSlowFactor } from "@/lib/degradedClient";
import { NOTIFICATION_LIST_LIMIT, NOTIFICATION_NEWER_WINDOW_MS, actionableUnreadCount, mergeNewerNotifications } from "@/lib/notificationBadge";

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
  const itemsRef = useRef<AppNotification[]>([]);
  itemsRef.current = items;

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
        .limit(NOTIFICATION_LIST_LIMIT);

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

  // The cheap check: only rows from shortly before the newest one already shown (an empty answer is a few hundred bytes). It looks a little
  // BEFORE the newest row, never strictly after it: two notices of one finished job (the result and the released hold) are written within the same
  // second and a clock can put the second one a moment earlier, so «newer than the newest» would skip it until the page was reloaded.
  const checkNewer = useCallback(async (): Promise<boolean> => {
    if (!userId) return false;
    const supabase = createClient();
    let query = supabase.from("notifications").select("*").eq("user_id", userId).order("created_at", { ascending: false }).limit(NOTIFICATION_LIST_LIMIT);
    if (newestRef.current) query = query.gt("created_at", new Date(Date.parse(newestRef.current) - NOTIFICATION_NEWER_WINDOW_MS).toISOString());
    const { data, error } = await query;
    if (error || !data || data.length === 0) return false;
    const fetched = data.map(mapRow);
    const merged = mergeNewerNotifications(itemsRef.current, fetched);
    const newest = String(data[0].created_at);
    if (!newestRef.current || Date.parse(newest) > Date.parse(newestRef.current)) newestRef.current = newest;
    if (!merged.foundNew) return false;
    itemsRef.current = merged.items;
    setItems(merged.items);
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
  /** What the bell's number shows: only unread items that need the customer (see notificationBadge). */
  const actionableUnread = actionableUnreadCount(items);

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

  return { items, unread, actionableUnread, markAllRead, markRead, reload: load };
}
