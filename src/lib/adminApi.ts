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

  // a FormData body (a file upload) sets its own multipart Content-Type with the boundary: forcing JSON here would break it
  const isForm = typeof FormData !== "undefined" && init.body instanceof FormData;
  const res = await fetch(path, {
    ...init,
    headers: {
      ...(isForm ? {} : { "Content-Type": "application/json" }),
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

/** Downloads a file from an /api/admin/* route with the caller's session token (admin only). Returns the response headers it came with. */
export async function adminDownload(path: string, fallbackName: string): Promise<{ rows: number | null; capped: boolean }> {
  let token = "";
  try {
    const supabase = createClient();
    const { data: { session } } = await supabase.auth.getSession();
    if (session?.access_token) token = session.access_token;
  } catch {
    /* cookie fallback */
  }
  const res = await fetch(path, { headers: token ? { Authorization: `Bearer ${token}` } : {}, cache: "no-store" });
  if (!res.ok) {
    const json = await res.json().catch(() => ({}));
    throw Object.assign(new Error(json?.error || "تعذّر تنفيذ الطلب"), { status: res.status });
  }
  const blob = await res.blob();
  const disposition = res.headers.get("Content-Disposition") || "";
  const name = /filename="([^"]+)"/.exec(disposition)?.[1] || fallbackName;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  const rows = Number(res.headers.get("X-Export-Rows"));
  return { rows: Number.isFinite(rows) ? rows : null, capped: res.headers.get("X-Export-Capped") === "true" };
}
