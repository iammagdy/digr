"use client";

import { useState } from "react";
import { normalizeDigits, toArabicDigits } from "@/lib/arabicDigits";
import type { PlanEditorView } from "@/lib/agentMission/plan";
import type { PlanEdits } from "@/lib/agentMission/planEdit";

/**
 * THE PLAN EDITOR of the card: the customer changes the plan itself (the number of items, the period, the language, each exclusion the card shows, the main columns) before approving, with no cancelling and no retyping. It only
 * collects the choices; the server applies them to the stored plan, checks them and prices the plan again by code, and the card shows the result for approval. Retyping the whole request stays available beside it.
 */
const BTN = "min-h-11 cursor-pointer rounded-full border px-5 text-[13px] focus-visible:outline-2 disabled:cursor-wait disabled:opacity-60";
const BTN_PRIMARY = `${BTN} border-0 bg-ac text-onac`;
const BTN_PLAIN = `${BTN} border-ln2 bg-transparent text-ink`;
const FIELD = "min-h-11 rounded-xl border border-ln2 bg-bg px-3 text-sm text-ink";

interface StageState { columns: Record<string, boolean>; filters: Record<string, { enabled: boolean; lang?: "ar" | "en"; days?: string }> }

export const initialState = (edit: PlanEditorView): { count: string; perParent: Record<string, string>; pages: Record<string, string>; replies: Record<string, boolean>; stages: Record<string, StageState> } => ({
  count: String(edit.stages.find((s) => s.key === edit.target_stage_key)?.target ?? ""),
  perParent: Object.fromEntries(edit.stages.filter((s) => s.per_parent !== undefined).map((s) => [s.key, String(s.per_parent)])),
  pages: Object.fromEntries(edit.stages.filter((s) => s.pages !== undefined).map((s) => [s.key, String(s.pages)])),
  replies: Object.fromEntries(edit.stages.filter((s) => s.replies !== undefined).map((s) => [s.key, s.replies!.on])),
  stages: Object.fromEntries(edit.stages.map((s) => [s.key, {
    columns: Object.fromEntries(s.columns.map((c) => [c.key, c.on])),
    filters: Object.fromEntries(s.filters.map((f) => [f.kind, { enabled: f.enabled, ...(f.lang ? { lang: f.lang } : {}), ...(f.days !== undefined ? { days: String(f.days) } : {}) }])),
  }])),
});

/** What changed against the plan as it stands: only those fields are sent. */
export function editsFromState(edit: PlanEditorView, state: ReturnType<typeof initialState>): PlanEdits {
  const out: PlanEdits = {};
  const target = edit.stages.find((s) => s.key === edit.target_stage_key);
  const count = Number(normalizeDigits(state.count).replace(/[^\d]/g, ""));
  if (target && Number.isInteger(count) && count !== target.target) out.count = count;
  const stages: NonNullable<PlanEdits["stages"]> = [];
  for (const s of edit.stages) {
    const st = state.stages[s.key];
    const e: NonNullable<PlanEdits["stages"]>[number] = { key: s.key };
    if (s.per_parent !== undefined) {
      const per = Number(normalizeDigits(state.perParent[s.key] ?? "").replace(/[^\d]/g, ""));
      if (Number.isInteger(per) && per !== s.per_parent) e.per_parent = per;
    }
    if (s.pages !== undefined) {
      const pages = Number(normalizeDigits(state.pages[s.key] ?? "").replace(/[^\d]/g, ""));
      if (Number.isInteger(pages) && pages !== s.pages) e.pages = pages;
    }
    if (s.replies !== undefined && state.replies[s.key] !== undefined && state.replies[s.key] !== s.replies.on) e.replies = state.replies[s.key];
    if (s.columns.some((c) => st.columns[c.key] !== c.on)) e.columns = s.columns.filter((c) => st.columns[c.key]).map((c) => c.key);
    const filters = s.filters.flatMap((f) => {
      const cur = st.filters[f.kind];
      const days = cur.days !== undefined ? Number(normalizeDigits(cur.days).replace(/[^\d]/g, "")) : undefined;
      const changed = cur.enabled !== f.enabled || (cur.lang !== undefined && cur.lang !== f.lang) || (days !== undefined && days !== f.days);
      return changed ? [{ kind: f.kind, enabled: cur.enabled, ...(cur.lang !== undefined ? { lang: cur.lang } : {}), ...(days !== undefined && Number.isFinite(days) && days !== f.days ? { days } : {}) }] : [];
    });
    if (filters.length > 0) e.filters = filters;
    if (e.columns || e.filters || e.per_parent !== undefined || e.pages !== undefined || e.replies !== undefined) stages.push(e);
  }
  if (stages.length > 0) out.stages = stages;
  return out;
}

export function PlanEditor({ edit, busy = false, onSave, onCancel, onRetype }: { edit: PlanEditorView; busy?: boolean; onSave: (edits: PlanEdits) => void; onCancel: () => void; onRetype: () => void }) {
  const [state, setState] = useState(() => initialState(edit));
  const target = edit.stages.find((s) => s.key === edit.target_stage_key) ?? null;
  const setFilter = (stageKey: string, kind: string, patch: Partial<StageState["filters"][string]>) => setState((p) => ({ ...p, stages: { ...p.stages, [stageKey]: { ...p.stages[stageKey], filters: { ...p.stages[stageKey].filters, [kind]: { ...p.stages[stageKey].filters[kind], ...patch } } } } }));
  const setColumn = (stageKey: string, key: string, on: boolean) => setState((p) => ({ ...p, stages: { ...p.stages, [stageKey]: { ...p.stages[stageKey], columns: { ...p.stages[stageKey].columns, [key]: on } } } }));
  const edits = editsFromState(edit, state);
  const changed = edits.count !== undefined || (edits.stages?.length ?? 0) > 0;

  return (
    <div className="flex flex-col gap-3 rounded-[14px] border border-ln bg-bg p-3" data-testid="agent-plan-editor" role="group" aria-label="تعديل الخطة">
      <p className="m-0 text-[13px] font-semibold text-ink">عدّل الخطة قبل الاعتماد</p>
      {target ? (
        <label className="flex flex-col gap-1 text-[13px] text-ink2">
          <span>العدد المطلوب</span>
          <input value={state.count} onChange={(e) => setState((p) => ({ ...p, count: e.target.value }))} inputMode="numeric" className={FIELD} dir="ltr" aria-label="العدد المطلوب" data-testid="agent-edit-count" />
          <span className="text-[11px] font-light text-mut">الحد الأقصى {toArabicDigits(edit.max_rows)}. يُحسب السعر من جديد بعد الحفظ.</span>
        </label>
      ) : null}

      {edit.stages.filter((s) => s.per_parent !== undefined).map((s) => (
        <label key={`per-${s.key}`} className="flex flex-col gap-1 text-[13px] text-ink2">
          <span>{s.per_parent_label_ar}</span>
          <input value={state.perParent[s.key] ?? ""} onChange={(e) => setState((p) => ({ ...p, perParent: { ...p.perParent, [s.key]: e.target.value } }))} inputMode="numeric" className={FIELD} dir="ltr" aria-label={s.per_parent_label_ar} data-testid={`agent-edit-per-parent-${s.key}`} />
          <span className="text-[11px] font-light text-mut">يُحسب السعر من جديد بعد الحفظ.</span>
        </label>
      ))}

      {edit.stages.filter((s) => s.replies !== undefined).map((s) => (
        <label key={`replies-${s.key}`} className="flex min-h-11 items-center gap-2 text-[13px] text-ink2">
          <input type="checkbox" checked={state.replies[s.key] ?? false} onChange={(e) => setState((p) => ({ ...p, replies: { ...p.replies, [s.key]: e.target.checked } }))} data-testid={`agent-edit-replies-${s.key}`} />
          <span>{s.replies!.label_ar}</span>
        </label>
      ))}

      {edit.stages.filter((s) => s.pages !== undefined).map((s) => (
        <label key={`pages-${s.key}`} className="flex flex-col gap-1 text-[13px] text-ink2">
          <span>{s.pages_label_ar}</span>
          <input value={state.pages[s.key] ?? ""} onChange={(e) => setState((p) => ({ ...p, pages: { ...p.pages, [s.key]: e.target.value } }))} inputMode="numeric" className={FIELD} dir="ltr" aria-label={s.pages_label_ar} data-testid={`agent-edit-pages-${s.key}`} />
          <span className="text-[11px] font-light text-mut">كلما قلّت الصفحات قلّ السعر، وقلّت فرصة الوصول إلى صناع القرار. الحد الأقصى {toArabicDigits(s.pages_max ?? 10)}. يُحسب السعر من جديد بعد الحفظ.</span>
        </label>
      ))}

      {edit.stages.filter((s) => s.filters.length > 0).map((s) => (
        <fieldset key={s.key} className="m-0 flex flex-col gap-1.5 border-0 p-0" data-testid={`agent-edit-filters-${s.key}`}>
          <legend className="p-0 text-[12px] font-semibold text-ink">ما يُستبعد وما يُشترط{edit.stages.length > 1 ? ` · ${s.title_ar}` : ""}</legend>
          {s.filters.map((f) => {
            const cur = state.stages[s.key].filters[f.kind];
            return (
              <div key={f.kind} className="flex flex-wrap items-center gap-2 text-[13px] text-ink2">
                <label className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={cur.enabled} onChange={(e) => setFilter(s.key, f.kind, { enabled: e.target.checked })} data-testid={`agent-edit-filter-${f.kind}`} /><span>{f.label_ar}</span></label>
                {f.kind === "language" && cur.enabled ? (
                  <select value={cur.lang ?? "ar"} onChange={(e) => setFilter(s.key, f.kind, { lang: e.target.value === "en" ? "en" : "ar" })} className={FIELD} aria-label="اللغة"><option value="ar">العربية</option><option value="en">الإنجليزية</option></select>
                ) : null}
                {f.kind === "period" && cur.enabled ? (
                  <label className="flex items-center gap-1.5"><span>آخر</span><input value={cur.days ?? ""} onChange={(e) => setFilter(s.key, f.kind, { days: e.target.value })} inputMode="numeric" className={`${FIELD} w-20`} dir="ltr" aria-label="عدد الأيام" data-testid="agent-edit-days" /><span>يومًا</span></label>
                ) : null}
              </div>
            );
          })}
        </fieldset>
      ))}

      {edit.stages.filter((s) => s.columns.length > 1).map((s) => (
        <fieldset key={s.key} className="m-0 flex flex-col gap-1 border-0 p-0" data-testid={`agent-edit-columns-${s.key}`}>
          <legend className="p-0 text-[12px] font-semibold text-ink">أعمدة الملف{edit.stages.length > 1 ? ` · ${s.title_ar}` : ""}</legend>
          <div className="flex flex-wrap gap-x-4">
            {s.columns.map((c) => (
              <label key={c.key} className="flex min-h-11 items-center gap-1.5 text-[13px] text-ink2"><input type="checkbox" checked={state.stages[s.key].columns[c.key]} disabled={c.locked} onChange={(e) => setColumn(s.key, c.key, e.target.checked)} />{c.title_ar}</label>
            ))}
          </div>
        </fieldset>
      ))}

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={BTN_PRIMARY} disabled={busy || !changed} onClick={() => onSave(edits)} data-testid="agent-edit-save">احفظ التعديل</button>
        <button type="button" className={BTN_PLAIN} disabled={busy} onClick={onCancel} data-testid="agent-edit-close">إغلاق</button>
        <button type="button" className={`${BTN_PLAIN} border-0 underline`} disabled={busy} onClick={onRetype} data-testid="agent-retype">اكتب الطلب من جديد</button>
      </div>
    </div>
  );
}
