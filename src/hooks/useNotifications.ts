"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

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

/** In-app notifications from public.notifications table, live via Supabase Realtime. */
export function useNotifications(userId: string | undefined) {
  const [items, setItems] = useState<AppNotification[]>([]);

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
      setItems((data || []).map(mapRow));
    } catch {
      // Offline or error: show empty panel rather than failing the shell
      setItems([]);
    }
  }, [userId, mapRow]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!userId) return;
    try {
      const supabase = createClient();
      const channel = supabase
        .channel(`user-notifications-${userId}`)
        .on(
          "postgres_changes",
          {
            event: "*",
            schema: "public",
            table: "notifications",
            filter: `user_id=eq.${userId}`,
          },
          (payload) => {
            if (payload.eventType === "INSERT") {
              const mapped = mapRow(payload.new);
              setItems((prev) => [mapped, ...prev.filter((n) => n.id !== mapped.id)].slice(0, 30));
            } else if (payload.eventType === "UPDATE") {
              const mapped = mapRow(payload.new);
              setItems((prev) => prev.map((n) => (n.id === mapped.id ? mapped : n)));
            } else if (payload.eventType === "DELETE") {
              setItems((prev) => prev.filter((n) => n.id !== (payload.old as any).id));
            }
          }
        )
        .subscribe();

      return () => {
        void supabase.removeChannel(channel);
      };
    } catch {
      return;
    }
  }, [userId, mapRow]);

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
