"use client";

import { account } from "@/lib/appwrite";

/** Calls an /api/admin/* route with the caller's JWT. The server re-checks `labels: admin` on every call. */
export async function adminFetch<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  let jwt = "";
  try { jwt = (await account.createJWT()).jwt; } catch { /* cookie fallback */ }
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}), ...(init.headers || {}) },
    cache: "no-store",
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json?.error || "تعذّر تنفيذ الطلب"), { status: res.status });
  return json as T;
}

/** UTF-8 CSV download (with BOM so Excel opens Arabic correctly). */
export function downloadCsv(filename: string, rows: Array<Array<string | number | null | undefined>>) {
  const esc = (v: string | number | null | undefined) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const blob = new Blob(["﻿" + rows.map((r) => r.map(esc).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 250);
}
