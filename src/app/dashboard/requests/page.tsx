"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useUser } from "@/hooks/useUser";
import { createClient } from "@/lib/supabase/client";
import { formatAr } from "@/lib/arabicDigits";
import { dayLabel } from "@/lib/dayLabel";
import { JOBS_COLLECTION } from "@/lib/constants";
import { getJobIdForQuote } from "@/lib/md5";

interface JobDoc {
  $id: string;
  templateSlug: string;
  params?: string;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  reservedCredits: number;
  chargedCredits?: number;
  rowsCollected?: number;
  targetVolumeMax?: number;
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

function targetOf(params?: string): string {
  try {
    const p = JSON.parse(params || "{}");
    if (p.username) return `بيانات حساب @${String(p.username).replace(/^@/, "")}`;
    if (p.query) return String(p.query);
  } catch { /* fall through */ }
  return "طلب بحث";
}

function formatRefundedNote(rawError?: string, reservedCredits = 0): string {
  if (!rawError) {
    return `لم تتوفر سجلات عامة كافية — رجعت ${formatAr(reservedCredits)} نقطة كاملة لرصيدك.`;
  }
  let cleaned = rawError
    .replace(/مراقب\s*المهام\s*\(?Watchdog\)?/gi, "")
    .replace(/watchdog/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  if (
    cleaned.includes("لتجاوز المهلة الزمنية") ||
    cleaned.includes("لتأخر التنفيذ") ||
    cleaned.includes("تلقائياً")
  ) {
    cleaned = "تم إلغاء الطلب تلقائياً لتأخر التنفيذ وتم إرجاع كامل نقاطك المحجوزة لرصيدك.";
  }

  if (
    cleaned.includes("رجعت") ||
    cleaned.includes("استرجاع") ||
    cleaned.includes("إرجاع") ||
    cleaned.includes("استرداد")
  ) {
    return cleaned;
  }

  return `${cleaned} — رجعت ${formatAr(reservedCredits)} نقطة كاملة لرصيدك.`;
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
      const supabase = createClient();
      const [jobsRes, quotesRes, convRes, msgsRes] = await Promise.all([
        supabase
          .from(JOBS_COLLECTION)
          .select("*")
          .eq("user_id", user.id)
          .order("created_at", { ascending: false })
          .limit(100),
        supabase
          .from("plans_quotes")
          .select("id, status, items, total_reserved_credits, created_at")
          .eq("user_id", user.id)
          .eq("status", "accepted")
          .order("created_at", { ascending: false })
          .limit(100),
        supabase
          .from("conversations")
          .select("id, title")
          .eq("user_id", user.id)
          .order("updated_at", { ascending: false })
          .limit(100),
        supabase
          .from("messages")
          .select("conversation_id, quote")
          .eq("user_id", user.id)
          .not("quote", "is", null)
          .order("created_at", { ascending: false })
          .limit(100),
      ]);
      if (jobsRes.error) throw jobsRes.error;
      const mappedJobs: JobDoc[] = (jobsRes.data || []).map((r: any) => ({
        $id: r.id,
        templateSlug: r.endpoint_id || r.template_slug || r.templateSlug || "",
        params: typeof r.params === "string" ? r.params : JSON.stringify(r.params || {}),
        status: r.status,
        reservedCredits: Number(r.reserved_credits ?? r.reservedCredits ?? 0),
        chargedCredits: r.charged_credits !== undefined && r.charged_credits !== null ? Number(r.charged_credits) : undefined,
        rowsCollected: r.delivered_units ?? r.rows_collected ?? r.rowsCollected ?? 0,
        targetVolumeMax: typeof r.target_volume_max === "number" ? r.target_volume_max : undefined,
        errorAr: r.error_message ?? r.error_ar ?? r.errorAr ?? undefined,
        createdAt: r.created_at || r.createdAt || new Date().toISOString(),
      }));
      setJobs(mappedJobs);

      // Map quoteId to conversationId and summaryAr from messages table
      const quoteToConv: Record<string, { conversationId: string; summaryAr?: string }> = {};
      for (const m of (msgsRes?.data || []) as any[]) {
        const qId = m.quote?.quoteId || m.quote?.id;
        if (qId && m.conversation_id) {
          quoteToConv[qId] = {
            conversationId: m.conversation_id,
            summaryAr: m.quote?.summaryAr || m.quote?.summary_ar,
          };
        }
      }

      const qMap: Record<string, QuoteInfo> = {};
      for (const q of (quotesRes?.data || []) as any[]) {
        const jId = getJobIdForQuote(q.id);
        const item = Array.isArray(q.items) ? q.items[0] : null;
        const msgInfo = quoteToConv[q.id];
        qMap[jId] = {
          conversationId: msgInfo?.conversationId || "",
          targetVolumeMax: item?.targetVolumeMax ?? item?.target_volume_max ?? 0,
          summaryAr: msgInfo?.summaryAr || (item?.capabilitySlug ? `استخراج بيانات ${item.capabilitySlug}` : undefined),
        };
      }
      setQuotes(qMap);

      const tMap: Record<string, string> = {};
      for (const c of (convRes.data || []) as any[]) {
        tMap[c.id || c.$id] = c.title;
      }
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
      const supabase = createClient();
      const { data: { session } } = await supabase.auth.getSession();
      const headers: Record<string, string> = {};
      if (session?.access_token) {
        headers["Authorization"] = `Bearer ${session.access_token}`;
      }
      const res = await fetch(`/api/jobs/${job.$id}/download?format=${ext}`, { headers });
      if (!res.ok) throw new Error(String(res.status));
      const payload = await res.json();
      if (!payload?.success || !payload?.signedUrl) throw new Error("no_signed_url");
      const fileRes = await fetch(payload.signedUrl);
      if (!fileRes.ok) throw new Error(String(fileRes.status));
      const url = URL.createObjectURL(await fileRes.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = payload.downloadFileName || `diger_${job.templateSlug || "dataset"}_${job.$id.slice(0, 8)}.${ext}`;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 250);
    } catch {
      setDlError("تعذّر تحميل الملف. يرجى إعادة المحاولة. (التحميل متاح لمدة ٩٠ يومًا)");
    } finally {
      setDl(null);
    }
  }

  const openFile = (job: JobDoc, retry = false) => {
    try {
      sessionStorage.setItem("diger_active_job_id", job.$id);
      sessionStorage.setItem("diger_canvas_open", "1");
    } catch {
      // Non-blocking storage fallback
    }
    const c = quotes[job.$id]?.conversationId;
    const query = new URLSearchParams();
    query.set("jobId", job.$id);
    if (c) query.set("c", c);
    if (retry) query.set("retry", "1");
    router.push(`/dashboard/chat?${query.toString()}`);
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
          const title = (q?.conversationId && titles[q.conversationId]) || q?.summaryAr || targetOf(j.params) || (j.templateSlug ? `طلب ${platformOf(j.templateSlug)}` : "طلب بحث");
          const requested = j.targetVolumeMax || q?.targetVolumeMax;
          const rows = j.rowsCollected ?? 0;
          const pct = requested ? Math.min(100, (rows / requested) * 100) : 0;
          const note = k === "running" ? "جارٍ الجمع — ستصلك رسالة عند الاكتمال."
            : k === "refunded" ? formatRefundedNote(j.errorAr, j.reservedCredits || 0) : "";
          return (
            <article key={j.$id} className="flex flex-col gap-3.5 rounded-3xl border border-ln bg-sf p-[18px]" style={{ animation: "up .35s both" }}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <button
                    type="button"
                    onClick={() => openFile(j, k === "refunded")}
                    className="m-0 cursor-pointer border-0 bg-transparent p-0 text-right text-base font-medium leading-[1.6] text-ink hover:underline focus-visible:outline-2"
                  >
                    {title}
                  </button>
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
                <button
                  type="button"
                  onClick={() => openFile(j, k === "refunded")}
                  className={`min-h-11 cursor-pointer rounded-full border-0 px-4 text-xs font-medium transition-colors ${
                    k === "running" ? "bg-ac text-onac hover:opacity-90" : "bg-sf2 text-ink hover:bg-sf"
                  }`}
                >
                  {k === "running" ? "متابعة التقدم" : k === "refunded" ? "إعادة المحاولة" : "متابعة التفاصيل والملفات"}
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
