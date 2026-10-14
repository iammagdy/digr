"use client";

import { createClient } from "@/lib/supabase/client";

/** Calls an /api/admin/* route with the caller's JWT/session token. The server re-checks `app_metadata.role: admin` on every call. */
export async function adminFetch<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  let token = "";
  try {
    const supabase = createClient();
    const { data: { session } } = await supabase.auth.getSession();
    if (session?.access_token) {
      token = session.access_token;
    }
  } catch {
    /* cookie fallback */
  }

  const res = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers || {}),
    },
    cache: "no-store",
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json?.error || "تعذّر تنفيذ الطلب"), { status: res.status });
  return json as T;
}

/** UTF-8 CSV download (with BOM so Excel opens Arabic correctly). */
export function downloadCsv(filename: string, rows: Array<Array<string | number | null | undefined>>) {
  const esc = (v: string | number | null | undefined) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const blob = new Blob(["\uFEFF" + rows.map((r) => r.map(esc).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 250);
}
