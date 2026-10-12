"use client";

import { useCallback, useEffect, useState } from "react";
import { Query } from "appwrite";
import { client, databases } from "@/lib/appwrite";
import { DATABASE_ID, NOTIFICATIONS_COLLECTION } from "@/lib/constants";

export type NotificationKind = "topup_approved" | "topup_rejected" | "job_done" | "refund" | "welcome";

export interface AppNotification {
  $id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  link?: string;
  readAt?: string | null;
  createdAt: string;
}

/** In-app notifications from the `notifications` collection, live via Realtime. */
export function useNotifications(userId: string | undefined) {
  const [items, setItems] = useState<AppNotification[]>([]);

  const load = useCallback(async () => {
    if (!userId) return;
    try {
      const res = await databases.listDocuments(DATABASE_ID, NOTIFICATIONS_COLLECTION, [
        Query.equal("userId", userId),
        Query.orderDesc("createdAt"),
        Query.limit(30),
      ]);
      setItems(res.documents as unknown as AppNotification[]);
    } catch {
      // Collection not provisioned yet, or offline: show an empty panel rather than failing the shell.
      setItems([]);
    }
  }, [userId]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!userId) return;
    try {
      return client.subscribe(`databases.${DATABASE_ID}.collections.${NOTIFICATIONS_COLLECTION}.documents`, (e) => {
        const doc = e.payload as unknown as AppNotification & { userId?: string };
        if (doc.userId !== userId) return;
        setItems((prev) => {
          const rest = prev.filter((n) => n.$id !== doc.$id);
          return [doc, ...rest].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 30);
        });
      });
    } catch {
      return;
    }
  }, [userId]);

  const unread = items.filter((n) => !n.readAt).length;

  const markAllRead = useCallback(async () => {
    const now = new Date().toISOString();
    const pending = items.filter((n) => !n.readAt);
    setItems((prev) => prev.map((n) => (n.readAt ? n : { ...n, readAt: now })));
    await Promise.allSettled(pending.map((n) => databases.updateDocument(DATABASE_ID, NOTIFICATIONS_COLLECTION, n.$id, { readAt: now })));
  }, [items]);

  const markRead = useCallback(async (id: string) => {
    const now = new Date().toISOString();
    setItems((prev) => prev.map((n) => (n.$id === id && !n.readAt ? { ...n, readAt: now } : n)));
    try { await databases.updateDocument(DATABASE_ID, NOTIFICATIONS_COLLECTION, id, { readAt: now }); } catch { /* best effort */ }
  }, []);

  return { items, unread, markAllRead, markRead, reload: load };
}
