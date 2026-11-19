"use client";

import { StatusBadge, type BadgeTone } from "./ui";
import { dateTimeAr } from "./format";

/** A campaign draft as GET /api/admin/campaigns returns it (the browser's own copy of the row; the store's type stays on the server). */
export interface CampaignLite {
  id: string; name: string; subject: string; badge: string; heading: string; body: string; cta_label: string; cta_path: string;
  status: "draft" | "ready" | "sending" | "sent" | "cancelled"; revision: number; test_sent_at: string | null; test_content_hash: string | null; updated_at: string;
}

/** The store's own sentence for «the migration is not applied yet» (the 503 body's message, which is what reaches the screen). */
export const CAMPAIGNS_NOT_READY_AR = "تخزين الحملات لم يُفعَّل بعد.";
export const CAMPAIGNS_EMPTY_AR = "لم تُرسل أي رسالة بعد.";
export const CAMPAIGN_STATUS_AR: Record<CampaignLite["status"], { label: string; tone: BadgeTone }> = {
  draft: { label: "مسودة", tone: "mute" },
  ready: { label: "جاهزة للإرسال", tone: "warn" },
  sending: { label: "قيد الإرسال", tone: "warn" },
  sent: { label: "أُرسلت", tone: "ok" },
  cancelled: { label: "أُلغيت", tone: "mute" },
};

export const isCampaignsNotReady = (e: unknown): boolean => e instanceof Error && e.message === CAMPAIGNS_NOT_READY_AR;

export type CampaignListState = { kind: "loading" } | { kind: "notReady" } | { kind: "error"; message: string } | { kind: "ready"; rows: CampaignLite[] };

/** «الحملات»: the saved drafts, newest first (name, status in words, last edit, test time). Opening one puts it in the composer. */
export function CampaignList({ state, onOpen, onRetry }: { state: CampaignListState; onOpen: (c: CampaignLite) => void; onRetry?: () => void }) {
  if (state.kind === "loading") return <p role="status" className="m-0 text-[13px] text-mut">جارٍ التحميل…</p>;
  if (state.kind === "notReady") return <p role="status" className="m-0 text-[13px] text-mut">{CAMPAIGNS_NOT_READY_AR}</p>;
  if (state.kind === "error") {
    return (
      <div className="flex flex-col items-start gap-2">
        <p role="alert" className="m-0 text-[13px] text-bad">{state.message}</p>
        {onRetry && <button type="button" onClick={onRetry} className="min-h-11 cursor-pointer rounded-full border border-ln2 bg-transparent px-5 text-[13px] font-semibold text-ink">أعد المحاولة</button>}
      </div>
    );
  }
  if (state.rows.length === 0) return <p className="m-0 text-[13px] text-mut">{CAMPAIGNS_EMPTY_AR}</p>;
  return (
    <ul className="m-0 flex list-none flex-col gap-2 p-0">
      {state.rows.map((c) => {
        const st = CAMPAIGN_STATUS_AR[c.status] ?? CAMPAIGN_STATUS_AR.draft;
        return (
          <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 rounded-[14px] border border-ln bg-sf p-3">
            <div className="flex min-w-0 flex-col gap-1">
              <span className="flex flex-wrap items-center gap-2 text-[14px] font-semibold text-ink">{c.name}<StatusBadge tone={st.tone}>{st.label}</StatusBadge></span>
              <span className="text-xs text-mut">آخر تعديل: {dateTimeAr(c.updated_at)}</span>
              <span className="text-xs text-mut">{c.test_sent_at ? `نسخة تجريبية: ${dateTimeAr(c.test_sent_at)}` : "لم تُرسَل نسخة تجريبية بعد."}</span>
            </div>
            <button type="button" onClick={() => onOpen(c)} aria-label={`فتح الحملة ${c.name}`} className="min-h-11 cursor-pointer rounded-full border border-ln2 bg-transparent px-5 text-[13px] font-semibold text-ink">فتح</button>
          </li>
        );
      })}
    </ul>
  );
}
