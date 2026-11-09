"use client";

import { fileNameFromDisposition } from "@/lib/downloadName";
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
  if (!res.ok) throw Object.assign(new Error(json?.error || failureWithoutMessageAr(res.status)), { status: res.status });
  return json as T;
}

/**
 * The sentence when the server answered with no message of its own (the platform cut the request off, or it never reached the route): the status code
 * is said, so the cause can be told apart (504 = took too long, 413 = too large, 404 = no such route), never a bare «تعذّر تنفيذ الطلب».
 */
export function failureWithoutMessageAr(status: number): string {
  const why = status === 504 ? "استغرق الطلب وقتًا أطول من المسموح" : status === 413 ? "حجم البيانات أو الملف أكبر من المسموح" : status === 404 ? "المسار غير موجود" : status === 429 ? "طلبات كثيرة في وقت قصير" : status >= 500 ? "خطأ في الخادم" : "";
  return `تعذّر تنفيذ الطلب${why ? `: ${why}` : ""} (رمز ${status})`;
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
  const name = fileNameFromDisposition(disposition) || fallbackName;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  const rows = Number(res.headers.get("X-Export-Rows"));
  return { rows: Number.isFinite(rows) ? rows : null, capped: res.headers.get("X-Export-Capped") === "true" };
}
