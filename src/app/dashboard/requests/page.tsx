"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Query } from "appwrite";
import { account, databases } from "@/lib/appwrite";
import { useUser } from "@/hooks/useUser";
import { formatAr } from "@/lib/arabicDigits";
import { formatTime } from "@/lib/honestDisplay";
import { DATABASE_ID, JOBS_COLLECTION } from "@/lib/constants";

interface JobDoc {
  $id: string;
  templateSlug: string;
  params?: string;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  reservedCredits: number;
  chargedCredits?: number;
  rowsCollected?: number;
  errorAr?: string;
  createdAt: string;
}
interface QuoteInfo { conversationId: string; targetVolumeMax: number; summaryAr?: string }

type Kind = "done" | "running" | "refunded";
const kindOf = (s: JobDoc["status"]): Kind => (s === "done" ? "done" : s === "failed" || s === "cancelled" ? "refunded" : "running");
const STATUS: Record<Kind, { label: string; fg: string; tint: string }> = {
  done: { label: "مكتمل", fg: "var(--ok)", tint: "var(--ok)" },
  running: { label: "قيد التنفيذ", fg: "var(--gold)", tint: "var(--gold)" },
  refunded: { label: "مسترد", fg: "var(--mut)", tint: "var(--mut)" },
};
const TABS: Array<["all" | Kind, string]> = [["all", "الكل"], ["done", "مكتملة"], ["running", "قيد التنفيذ"], ["refunded", "مستردة"]];

function platformOf(slug: string): string {
  const s = slug.toLowerCase();
  if (s.includes("tiktok")) return "تيك توك";
  if (s.includes("instagram")) return "إنستجرام";
  if (s.includes("youtube")) return "يوتيوب";
  if (s.includes("facebook")) return "فيسبوك";
  if (s.includes("linkedin")) return "لينكدإن";
  if (s.includes("reddit")) return "ريديت";
  if (s.startsWith("x-") || s.includes("twitter")) return "إكس";
  return "الإنترنت العام";
}

/** «اليوم ١٢:٤٦» · «أمس ٩:١٨ م» · «٨ أكتوبر» */
function dayLabel(iso: string): string {
  const d = new Date(iso), now = new Date();
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((startOf(now) - startOf(d)) / 86400000);
  if (diff === 0) return `اليوم ${formatTime(iso)}`;
  if (diff === 1) return `أمس ${formatTime(iso)}`;
  return new Intl.DateTimeFormat("ar-EG-u-nu-arab", { day: "numeric", month: "long" }).format(d);
}

function targetOf(params?: string): string {
  try {
    const p = JSON.parse(params || "{}");
    if (p.username) return `بيانات حساب @${String(p.username).replace(/^@/, "")}`;
    if (p.query) return String(p.query);
  } catch { /* fall through */ }
  return "طلب بحث";
}

const DL_ICON = "M12 4v11M7 10l5 5 5-5M5 20h14";

export default function RequestsPage() {
  const { user } = useUser();
  const router = useRouter();
  const [jobs, setJobs] = useState<JobDoc[]>([]);
  const [quotes, setQuotes] = useState<Record<string, QuoteInfo>>({});
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [filter, setFilter] = useState<"all" | Kind>("all");
  const [dl, setDl] = useState<string | null>(null);
  const [dlError, setDlError] = useState("");

  const load = useCallback(async () => {
    if (!user) return;
    try {
      const [jobsRes, quotesRes, convRes] = await Promise.all([
        databases.listDocuments(DATABASE_ID, JOBS_COLLECTION, [Query.equal("userId", user.$id), Query.orderDesc("createdAt"), Query.limit(100)]),
        databases.listDocuments(DATABASE_ID, "plans_quotes", [Query.equal("userId", user.$id), Query.equal("status", "accepted"), Query.orderDesc("createdAt"), Query.limit(100)]),
        databases.listDocuments(DATABASE_ID, "conversations", [Query.equal("userId", user.$id), Query.orderDesc("updatedAt"), Query.limit(100)]),
      ]);
      setJobs(jobsRes.documents as unknown as JobDoc[]);
      const qMap: Record<string, QuoteInfo> = {};
      for (const q of quotesRes.documents as any[]) if (q.jobId) qMap[q.jobId] = { conversationId: q.conversationId, targetVolumeMax: q.targetVolumeMax, summaryAr: q.summaryAr };
      setQuotes(qMap);
      const tMap: Record<string, string> = {};
      for (const c of convRes.documents as any[]) tMap[c.$id] = c.title;
      setTitles(tMap);
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    void load();
    const t = setInterval(() => { if (jobs.some((j) => j.status === "queued" || j.status === "running")) void load(); }, 4000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, jobs.length]);

  const counts = useMemo(() => ({
    all: jobs.length,
    done: jobs.filter((j) => kindOf(j.status) === "done").length,
    running: jobs.filter((j) => kindOf(j.status) === "running").length,
    refunded: jobs.filter((j) => kindOf(j.status) === "refunded").length,
  }), [jobs]);
  const list = jobs.filter((j) => filter === "all" || kindOf(j.status) === filter);

  async function download(job: JobDoc, ext: "xlsx" | "pdf" | "csv") {
    const key = `${job.$id}_${ext}`;
    setDl(key);
    setDlError("");
    try {
      // Latest artifact version if the user edited the result; otherwise the original file.
      let fileId = `${ext}_${job.$id}`;
      try {
        const info = await (await fetch(`/api/jobs/${job.$id}/data`)).json();
        if (info?.success && info.fileIds?.[ext]) fileId = info.fileIds[ext];
      } catch { /* default id */ }
      const jwt = (await account.createJWT()).jwt;
      const endpoint = process.env.NEXT_PUBLIC_APPWRITE_ENDPOINT || "https://fra.cloud.appwrite.io/v1";
      const res = await fetch(`${endpoint}/storage/buckets/results/files/${fileId}/download`, {
        headers: { "X-Appwrite-Project": process.env.NEXT_PUBLIC_APPWRITE_PROJECT_ID || "6ac947090008606ef482", "X-Appwrite-JWT": jwt },
      });
      if (!res.ok) throw new Error(String(res.status));
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url; a.download = `digr_${job.templateSlug || "dataset"}_${job.$id.slice(0, 8)}.${ext}`;
      document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 250);
    } catch {
      setDlError("تعذّر تحميل الملف. يرجى إعادة المحاولة. (التحميل متاح لمدة ٩٠ يومًا)");
    } finally {
      setDl(null);
    }
  }

  const openFile = (job: JobDoc, retry = false) => {
    const c = quotes[job.$id]?.conversationId;
    router.push(c ? `/dashboard/chat?c=${c}${retry ? "&retry=1" : ""}` : "/dashboard/chat");
  };

  return (
    <div data-screen-label="Requests" className="flex-1">
      <div className="mx-auto flex max-w-[820px] flex-col gap-4 px-[18px] pb-16 pt-[22px]">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="m-0 font-display text-[40px] font-medium leading-[1.1] text-ink">طلباتي</h2>
            <p className="mb-0 mt-1.5 text-sm font-light text-mut">كل أبحاثك وملفاتها في مكان واحد — التحميل متاح لمدة ٩٠ يومًا.</p>
          </div>
          <button type="button" onClick={() => router.push("/dashboard/chat")} className="min-h-11 cursor-pointer whitespace-nowrap rounded-full border-0 bg-ac px-[18px] text-[13px] text-onac">+ سؤال بحثي جديد</button>
        </div>

        <div className="no-scrollbar flex max-w-full gap-1 self-start overflow-x-auto rounded-full bg-sf2 p-1" role="tablist">
          {TABS.map(([id, label]) => {
            const on = filter === id;
            return (
              <button
                key={id} type="button" role="tab" aria-selected={on} onClick={() => setFilter(id)}
                className="min-h-11 shrink-0 cursor-pointer whitespace-nowrap rounded-full border-0 px-3.5 text-[13px] font-medium"
                style={{ background: on ? "var(--sf)" : "transparent", color: on ? "var(--ink)" : "var(--mut)", boxShadow: on ? "0 1px 3px rgba(0,0,0,.08)" : "none" }}
              >
                {label} <span className="opacity-60">{formatAr(counts[id])}</span>
              </button>
            );
          })}
        </div>

        {failed && <p role="alert" className="m-0 text-[13px] text-bad">تعذّر تحميل طلباتك الآن. تحقق من الاتصال ثم حاول مرة أخرى.</p>}
        {dlError && <p role="alert" className="m-0 text-[13px] text-bad">{dlError}</p>}
        {loading && [0, 1, 2].map((i) => <div key={i} className="h-40 rounded-3xl bg-sf2 motion-safe:animate-pulse motion-reduce:animate-none" />)}

        {!loading && list.map((j) => {
          const k = kindOf(j.status);
          const st = STATUS[k];
          const q = quotes[j.$id];
          const title = (q && titles[q.conversationId]) || q?.summaryAr || targetOf(j.params);
          const requested = q?.targetVolumeMax;
          const rows = j.rowsCollected ?? 0;
          const pct = requested ? Math.min(100, (rows / requested) * 100) : 0;
          const note = k === "running" ? "جارٍ الجمع — ستصلك رسالة عند الاكتمال."
            : k === "refunded" ? `${j.errorAr ? `${j.errorAr} ` : "لم تتوفر سجلات عامة كافية — "}رجعت ${formatAr(j.reservedCredits || 0)} نقطة كاملة لرصيدك.` : "";
          return (
            <article key={j.$id} className="flex flex-col gap-3.5 rounded-3xl border border-ln bg-sf p-[18px]" style={{ animation: "up .35s both" }}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="m-0 text-base font-medium leading-[1.6] text-ink">{title}</h3>
                  <p className="mb-0 mt-1 text-xs text-fnt">{platformOf(j.templateSlug)} · {dayLabel(j.createdAt)}</p>
                </div>
                <span className="shrink-0 whitespace-nowrap rounded-full px-3 py-1 text-xs font-medium" style={{ background: `color-mix(in oklab, ${st.tint} 13%, transparent)`, color: st.fg }}>{st.label}</span>
              </div>
              <div className="grid grid-cols-3 gap-2 border-t border-ln pt-3 text-xs text-mut">
                <span>السجلات<br /><strong className="text-sm font-semibold text-ink">{formatAr(rows)}{requested ? ` / ${formatAr(requested)}` : ""}</strong></span>
                <span>النقاط المخصومة<br /><strong className="text-sm font-semibold text-ink">{k === "running" ? "محجوز" : formatAr(j.chargedCredits ?? 0)}</strong></span>
                <span>الملفات<br /><strong className="text-sm font-semibold text-ink">{k === "done" ? "٣" : "—"}</strong></span>
              </div>
              {k === "running" && <div className="h-1 overflow-hidden rounded bg-sf2"><div className="h-full bg-gold" style={{ width: `${pct}%` }} /></div>}
              {note && <p className="m-0 text-[13px] leading-[1.8] text-ink2">{note}</p>}
              <div className="flex flex-wrap gap-2">
                {k === "done" && (["xlsx", "pdf", "csv"] as const).map((ext) => (
                  <button
                    key={ext} type="button" onClick={() => download(j, ext)} disabled={dl === `${j.$id}_${ext}`}
                    className="flex min-h-11 cursor-pointer items-center gap-1.5 rounded-full border border-ln2 bg-transparent px-3.5 text-xs text-ink disabled:opacity-60"
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={DL_ICON} /></svg>
                    {ext === "xlsx" ? "Excel" : ext.toUpperCase()}
                  </button>
                ))}
                <button type="button" onClick={() => openFile(j, k === "refunded")} className="min-h-11 cursor-pointer rounded-full border-0 bg-sf2 px-3.5 text-xs text-ink">
                  {k === "running" ? "متابعة التقدم" : k === "refunded" ? "إعادة المحاولة" : "فتح ملف البحث"}
                </button>
              </div>
            </article>
          );
        })}

        {!loading && !failed && list.length === 0 && (
          <div className="flex flex-col items-center gap-3 rounded-3xl border border-dashed border-ln2 px-5 py-10 text-center">
            <span className="flex h-[52px] w-[52px] items-center justify-center rounded-full bg-sf2 text-mut">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>
            </span>
            <p className="m-0 text-base font-medium text-ink">لا توجد أبحاث هنا بعد</p>
            <p className="m-0 max-w-[340px] text-[13px] font-light leading-[1.8] text-mut">ابدأ بسؤال واحد، وستجد ملفاتك هنا جاهزة للتحميل في أي وقت.</p>
            <button type="button" onClick={() => router.push("/dashboard/chat")} className="mt-1 min-h-11 cursor-pointer rounded-full border-0 bg-ac px-5 text-[13px] text-onac">ابدأ أول بحث</button>
          </div>
        )}
      </div>
    </div>
  );
}
