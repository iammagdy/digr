"use client";

import { useCallback, useEffect, useState } from "react";
import { adminFetch, downloadCsv } from "@/lib/adminApi";
import { useAdmin } from "@/components/admin/AdminShell";
import { shortStampAr, initials, tint } from "@/components/admin/format";

interface Entry { id: string; kind: string; who: string; label: string; target: string; ip: string; createdAt: string }

const TABS: Array<[string, string]> = [["all", "الكل"], ["money", "الشحن"], ["keys", "المفاتيح والمزودون"], ["settings", "الإعدادات والدخول"]];
const KIND_COLOR: Record<string, string> = { approve: "var(--ok)", reject: "var(--bad)", key: "var(--gold)", toggle: "var(--info)", setting: "var(--mut)", login: "var(--mut)" };

export default function AuditPage() {
  const { toast, isMobile } = useAdmin();
  const [group, setGroup] = useState("all");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await adminFetch<{ entries: Entry[] }>(`/api/admin/audit?group=${group}`);
      setEntries(res.entries);
      setError("");
    } catch (e) { setError(e instanceof Error ? e.message : "تعذّر تحميل السجل"); }
    finally { setLoading(false); }
  }, [group]);
  useEffect(() => { void load(); }, [load]);

  const exportAudit = () => {
    downloadCsv("diger-audit-log.csv", [["الوقت", "المسؤول", "الإجراء", "التفاصيل", "IP"], ...entries.map((e) => [e.createdAt, e.who, e.label, e.target, e.ip])]);
    toast("تم تصدير السجل إلى CSV");
  };

  return (
    <div data-screen-label="Audit" className="flex flex-col gap-3.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="no-scrollbar flex max-w-full gap-1 overflow-x-auto rounded-[14px] bg-sf2 p-1" role="tablist">
          {TABS.map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={group === id} onClick={() => setGroup(id)} className="min-h-11 shrink-0 cursor-pointer whitespace-nowrap rounded-[10px] border-0 px-3 text-xs font-semibold" style={{ background: group === id ? "var(--sf)" : "transparent", color: group === id ? "var(--ink)" : "var(--mut)", boxShadow: group === id ? "0 1px 3px rgba(0,0,0,.08)" : "none" }}>{label}</button>
          ))}
        </div>
        <button type="button" onClick={exportAudit} className="min-h-11 cursor-pointer rounded-xl border border-ln2 bg-sf px-3 text-xs text-ink">تصدير السجل</button>
      </div>
      <p className="m-0 text-xs leading-[1.8] text-fnt">كل إجراء إداري يُسجَّل تلقائيًا ولا يمكن تعديله أو حذفه — جدول admin_audit_log.</p>
      {error && <p role="alert" className="m-0 text-[13px] text-bad">{error}</p>}
      <div className="overflow-hidden rounded-[20px] border border-ln bg-sf">
        {loading && [0, 1, 2, 3].map((i) => <div key={i} className="h-[72px] border-t border-ln bg-sf2 motion-safe:animate-pulse motion-reduce:animate-none" />)}
        {!loading && entries.map((e) => {
          const c = KIND_COLOR[e.kind] ?? KIND_COLOR.setting;
          return (
            <div key={e.id} className="flex items-start gap-3 border-t border-ln px-4 py-3.5 first:border-t-0" style={{ animation: "up .3s both" }}>
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-sf2 text-xs font-semibold text-ink2">{initials(e.who)}</span>
              <div className="min-w-0 flex-1">
                <p className="m-0 flex flex-wrap items-center gap-1.5 text-[13px] text-ink"><strong className="font-semibold">{e.who}</strong><span className="rounded-full px-2 py-0.5 text-[11px] font-semibold" style={{ background: tint(c, 14), color: c === "var(--gold)" ? "var(--goldT)" : c }}>{e.label}</span></p>
                <p className="mb-0 mt-1 text-xs leading-[1.7] text-ink2">{e.target}</p>
              </div>
              <span className="shrink-0 text-left"><span className="block whitespace-nowrap text-[11px] text-fnt">{shortStampAr(e.createdAt)}</span>{!isMobile && <span dir="ltr" className="block text-[10px] text-fnt" style={{ fontFamily: "ui-monospace,monospace" }}>{e.ip || "—"}</span>}</span>
            </div>
          );
        })}
        {!loading && entries.length === 0 && !error && <p className="m-0 p-10 text-center text-[13px] text-fnt">لا توجد إجراءات مسجّلة بعد.</p>}
      </div>
    </div>
  );
}
