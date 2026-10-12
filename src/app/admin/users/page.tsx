"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { adminFetch } from "@/lib/adminApi";
import { formatAr } from "@/lib/arabicDigits";
import { useAdmin } from "@/components/admin/AdminShell";
import { UserSheet } from "@/components/admin/UserSheet";
import { ADMIN_IC, AIcon } from "@/components/admin/icons";
import { EGP, agoAr, dateTimeAr, initials, tint } from "@/components/admin/format";

interface Row { id: string; name: string; email: string; registration: string; lastLogin: string | null; balance: number; totalTopupsEgp: number; lastTopupAt: string | null; jobs: number; isNew: boolean; recent: boolean }
interface Resp { users: Row[]; total: number; page: number; pageSize: number; counts: Record<string, number>; stats: { total: number; active30: number; newWeek: number; payers: number } }

const FILTERS: Array<["all" | "active" | "new" | "zero", string]> = [["all", "الكل"], ["active", "نشط"], ["new", "جديد"], ["zero", "بلا شحن"]];
const COLS = "minmax(0,2.2fr) minmax(0,1fr) minmax(0,1fr) minmax(0,.9fr) minmax(0,1fr) minmax(0,1fr) minmax(0,.6fr)";

export default function AdminUsersPage() {
  const { isMobile, toast } = useAdmin();
  const [q, setQ] = useState("");
  const [applied, setApplied] = useState("");
  const [filter, setFilter] = useState<"all" | "active" | "new" | "zero">("all");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Resp | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    const p = new URLSearchParams(window.location.search).get("q");
    if (p) { setQ(p); setApplied(p); }
  }, []);
  useEffect(() => { const t = setTimeout(() => { setApplied(q.trim()); setPage(1); }, 350); return () => clearTimeout(t); }, [q]);

  const load = useCallback(async () => {
    try {
      setData(await adminFetch<Resp>(`/api/admin/users?filter=${filter}&page=${page}&q=${encodeURIComponent(applied)}`));
      setError("");
    } catch (e) { setError(e instanceof Error ? e.message : "تعذّر تحميل المستخدمين"); }
  }, [filter, page, applied]);
  useEffect(() => { void load(); }, [load]);

  const exportCsv = async () => {
    try {
      const supabase = createClient();
      const { data: { session } } = await supabase.auth.getSession();
      const headers: Record<string, string> = {};
      if (session?.access_token) headers.Authorization = `Bearer ${session.access_token}`;
      const res = await fetch(`/api/admin/users?format=csv&filter=${filter}&q=${encodeURIComponent(applied)}`, { headers });
      if (!res.ok) throw new Error();
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a"); a.href = url; a.download = "digr-users.csv"; document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 250);
      toast("تم تصدير المستخدمين إلى CSV");
    } catch { toast("تعذّر تصدير الملف"); }
  };

  const rows = data?.users ?? [];
  const from = data ? (data.page - 1) * data.pageSize + 1 : 0;
  const to = data ? from + rows.length - 1 : 0;
  const lastPage = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  const Avatar = ({ u, size }: { u: Row; size: number }) => (
    <span className="relative flex shrink-0 items-center justify-center rounded-full bg-sf2 font-semibold text-ink2" style={{ width: size, height: size, fontSize: size > 38 ? 13 : 12 }}>
      {initials(u.name)}
      <span className="absolute bottom-0 left-0 rounded-full border-2 border-sf" style={{ width: size > 38 ? 11 : 10, height: size > 38 ? 11 : 10, background: u.recent ? "var(--ok)" : "var(--ln2)" }} />
    </span>
  );

  return (
    <div data-screen-label="Users" className="flex flex-col gap-3.5">
      <div className="grid gap-2.5" style={{ gridTemplateColumns: "repeat(auto-fill,minmax(min(100%,160px),1fr))" }}>
        {[["إجمالي المستخدمين", data?.stats.total], ["نشطون (٣٠ يومًا)", data?.stats.active30], ["جدد هذا الأسبوع", data?.stats.newWeek], ["شحنوا مرة على الأقل", data?.stats.payers]].map(([k, v]) => (
          <div key={k as string} className="rounded-[18px] border border-ln bg-sf p-3.5"><p className="m-0 text-xs text-mut">{k}</p><p className="mb-0 mt-1.5 font-display text-[30px] leading-none text-ink">{v == null ? "…" : formatAr(v as number)}</p></div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <label className="flex min-h-[46px] min-w-[min(100%,240px)] flex-1 items-center gap-2 rounded-[14px] border border-ln bg-sf px-3.5 text-fnt">
          <AIcon d={ADMIN_IC.search} size={16} stroke={1.8} />
          <input type="text" value={q} onChange={(e) => setQ(e.target.value)} placeholder="الاسم أو البريد الإلكتروني" aria-label="بحث في المستخدمين" className="min-w-0 flex-1 border-0 bg-transparent text-base text-ink outline-none" />
        </label>
        <div className="no-scrollbar flex max-w-full gap-1 overflow-x-auto rounded-[14px] bg-sf2 p-1" role="tablist">
          {FILTERS.map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={filter === id} onClick={() => { setFilter(id); setPage(1); }} className="min-h-11 shrink-0 cursor-pointer whitespace-nowrap rounded-[10px] border-0 px-3 text-xs font-semibold" style={{ background: filter === id ? "var(--sf)" : "transparent", color: filter === id ? "var(--ink)" : "var(--mut)", boxShadow: filter === id ? "0 1px 3px rgba(0,0,0,.08)" : "none" }}>
              {label} <span className="opacity-60">{data ? formatAr(data.counts[id]) : ""}</span>
            </button>
          ))}
        </div>
        <button type="button" onClick={exportCsv} className="min-h-[46px] cursor-pointer whitespace-nowrap rounded-[14px] border border-ln2 bg-sf px-3.5 text-[13px] text-ink">تصدير CSV</button>
      </div>

      {error && <p role="alert" className="m-0 text-[13px] text-bad">{error}</p>}

      {!isMobile && (
        <div className="overflow-hidden rounded-[20px] border border-ln bg-sf">
          <div className="grid gap-3 bg-sf2 px-[18px] py-3 text-[11px] font-semibold text-mut" style={{ gridTemplateColumns: COLS }}>
            <span>المستخدم</span><span>تاريخ التسجيل</span><span>آخر دخول</span><span>الرصيد</span><span>إجمالي الشحن</span><span>آخر شحن</span><span>الأبحاث</span>
          </div>
          {!data && [0, 1, 2, 3].map((i) => <div key={i} className="h-[60px] border-t border-ln bg-sf2 motion-safe:animate-pulse motion-reduce:animate-none" />)}
          {rows.map((u) => (
            <button key={u.id} type="button" onClick={() => setOpen(u.id)} className="grid min-h-14 w-full cursor-pointer items-center gap-3 border-0 border-t border-ln bg-transparent px-[18px] py-3 text-right text-[13px] text-ink2 hover:bg-sf2" style={{ gridTemplateColumns: COLS }}>
              <span className="flex min-w-0 items-center gap-2.5">
                <Avatar u={u} size={36} />
                <span className="min-w-0">
                  <span className="flex items-center gap-1.5"><span className="truncate font-semibold text-ink">{u.name || "—"}</span>{u.isNew && <span className="rounded-full px-[7px] py-px text-[10px] font-semibold text-info" style={{ background: tint("var(--info)", 14) }}>جديد</span>}</span>
                  <span dir="ltr" className="block truncate text-right text-[11px] text-fnt">{u.email}</span>
                </span>
              </span>
              <span className="text-mut">{dateTimeAr(u.registration).split("،")[0]}</span>
              <span style={{ color: u.recent ? "var(--ink)" : "var(--mut)" }}>{u.lastLogin ? agoAr(u.lastLogin) : "—"}</span>
              <span className="font-semibold text-ink">{formatAr(u.balance)}</span>
              <span>{u.totalTopupsEgp ? EGP(u.totalTopupsEgp) : "—"}</span>
              <span className="text-mut">{u.lastTopupAt ? agoAr(u.lastTopupAt) : "—"}</span>
              <span>{formatAr(u.jobs)}</span>
            </button>
          ))}
          {data && rows.length === 0 && <p className="m-0 p-10 text-center text-[13px] text-fnt">لا يوجد مستخدمون مطابقون للبحث.</p>}
        </div>
      )}

      {isMobile && (
        <div className="flex flex-col gap-2">
          {rows.map((u) => (
            <button key={u.id} type="button" onClick={() => setOpen(u.id)} className="flex w-full cursor-pointer flex-col gap-2.5 rounded-[18px] border border-ln bg-sf p-3.5 text-right">
              <span className="flex items-center gap-2.5">
                <Avatar u={u} size={40} />
                <span className="min-w-0 flex-1"><span className="block text-sm font-semibold text-ink">{u.name || "—"}</span><span dir="ltr" className="block truncate text-right text-xs text-fnt">{u.email}</span></span>
                <span className="whitespace-nowrap font-display text-2xl text-ink">{formatAr(u.balance)}</span>
              </span>
              <span className="grid grid-cols-3 gap-1.5 text-[11px] text-mut">
                <span>آخر دخول<br /><strong className="font-semibold" style={{ color: u.recent ? "var(--ink)" : "var(--mut)" }}>{u.lastLogin ? agoAr(u.lastLogin) : "—"}</strong></span>
                <span>إجمالي الشحن<br /><strong className="font-semibold text-ink">{u.totalTopupsEgp ? EGP(u.totalTopupsEgp) : "—"}</strong></span>
                <span>آخر شحن<br /><strong className="font-semibold text-ink">{u.lastTopupAt ? agoAr(u.lastTopupAt) : "—"}</strong></span>
              </span>
            </button>
          ))}
          {data && rows.length === 0 && <p className="m-0 p-8 text-center text-[13px] text-fnt">لا يوجد مستخدمون مطابقون للبحث.</p>}
        </div>
      )}

      {data && data.total > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2.5 text-xs text-mut">
          <span>عرض {formatAr(from)}–{formatAr(to)} من {formatAr(data.total)} مستخدم</span>
          <span className="flex gap-1.5">
            <button type="button" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1} className="min-h-11 cursor-pointer rounded-xl border border-ln2 bg-sf px-3.5 text-xs text-ink disabled:opacity-40">→ السابق</button>
            <button type="button" onClick={() => setPage((p) => Math.min(lastPage, p + 1))} disabled={page >= lastPage} className="min-h-11 cursor-pointer rounded-xl border border-ln2 bg-sf px-3.5 text-xs text-ink disabled:opacity-40">التالي ←</button>
          </span>
        </div>
      )}

      {open && <UserSheet userId={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
