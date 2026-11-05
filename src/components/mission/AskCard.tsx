"use client";

import { useState } from "react";
import type { AskCardField, AskCardView, AskEdit } from "@/lib/agentMission/stage2/askCard";
import {
  ASK_CARD_BAD_NUMBER_AR, ASK_CARD_CANCEL_AR, ASK_CARD_CLEAR_AR, ASK_CARD_EDIT_AR, ASK_CARD_FROM_AR, ASK_CARD_NO_PERIOD_AR, ASK_CARD_SAVE_AR, ASK_CARD_TO_AR, ASK_EDIT_NEW_READ_AR,
} from "@/lib/agentMission/stage2/cardText";
import { normalizeDigits } from "@/lib/arabicDigits";

/**
 * STAGE 2 S4 (docs/STAGE-2.md): THE «فهمنا طلبك» CARD. One row per field of the Ask (its label and value; the customer's own words in «»), an «تعديل» button on each editable field, and the
 * editor its input kind asks for (a whole number in its limits, the choices, two Cairo days, a short text). An edit is sent as ONE field (`onEdit`), checked again and recompiled by the
 * server (the price is the new plan's, by code). A field whose edit needs a new read says so before it is saved. The card draws only what the server sent: no network here.
 * Shown only when the mission answer carries `askCard` (DIGER_STAGE2_ASK_CARD on for the viewer) and the page asked for the Stage 2 surfaces (the requests page).
 */
const BTN = "min-h-11 cursor-pointer rounded-full border px-4 text-[13px] focus-visible:outline-2 disabled:cursor-wait disabled:opacity-60";
const BTN_PRIMARY = `${BTN} border-0 bg-ac text-onac`;
const BTN_PLAIN = `${BTN} border-ln2 bg-transparent text-ink`;
const INPUT = "min-h-11 rounded-[10px] border border-ln2 bg-sf px-3 text-[14px] text-ink";

/** A draft of the editor: the typed text, or the two days of a period. */
export interface AskDraft { text?: string; from?: string; to?: string }

/**
 * THE EDIT A DRAFT MAKES, by code (pure, tested): a whole number inside the field's limits, a choice of its list («أي ...» is cleared), a period of two days (or none), a short text (an empty
 * source is cleared). Null when the draft is not a valid value: the card says so and sends nothing (the server checks again in any case).
 */
export function askEditFromDraft(field: Pick<AskCardField, "key" | "input">, draft: AskDraft | { choice: string } | { clear: true }): AskEdit | null {
  const key = field.key;
  if (key === "platform") return null;
  if ("clear" in draft) return key === "period" || key === "source" || key === "budget" || key === "country" || key === "language" ? ({ field: key, value: null } as AskEdit) : null;
  if ("choice" in draft) {
    if (field.input.kind !== "choice" || !field.input.options.some((o) => o.value === draft.choice)) return null;
    const value = draft.choice === "any" ? null : draft.choice;
    return { field: key, value } as AskEdit;
  }
  switch (field.input.kind) {
    case "number": {
      const t = normalizeDigits(String(draft.text ?? "")).replace(/[٬,\s]/g, "");
      if (!/^\d{1,9}$/.test(t)) return null;
      const n = Number(t);
      return n < field.input.min || n > field.input.max ? null : ({ field: key, value: n } as AskEdit);
    }
    case "text": {
      const t = String(draft.text ?? "").replace(/\s+/g, " ").trim();
      if (t.length > field.input.maxChars) return null;
      if (t === "") return key === "source" ? ({ field: key, value: null } as AskEdit) : null;
      return { field: key, value: t } as AskEdit;
    }
    case "period": {
      const from = String(draft.from ?? ""), to = String(draft.to ?? "");
      return /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to) ? { field: "period", value: { from, to } } : null;
    }
    default:
      return null;
  }
}

export interface AskCardProps {
  view: AskCardView;
  busy?: boolean;
  onEdit?: (edit: AskEdit) => void;
  /** The server's fixed sentence of a refused edit. */
  errorAr?: string | null;
  /** For the tests and a page that opens an editor from the start. */
  initialEditing?: AskCardField["key"] | null;
}

export function AskCard({ view, busy = false, onEdit = () => undefined, errorAr = null, initialEditing = null }: AskCardProps) {
  const [editing, setEditing] = useState<AskCardField["key"] | null>(initialEditing);
  const [draft, setDraft] = useState<AskDraft>({});
  const [localError, setLocalError] = useState<string | null>(null);
  const send = (field: AskCardField, d: Parameters<typeof askEditFromDraft>[1]) => {
    const e = askEditFromDraft(field, d);
    if (!e) { setLocalError(ASK_CARD_BAD_NUMBER_AR); return; }
    setLocalError(null);
    setEditing(null);
    setDraft({});
    onEdit(e);
  };
  return (
    <section dir="rtl" data-testid="ask-card" className="flex flex-col gap-2 rounded-[14px] border border-ln bg-sf2 p-3" aria-label={view.titleAr}>
      <h3 className="m-0 text-[15px] font-semibold text-ink">{view.titleAr}</h3>
      <dl className="m-0 flex flex-col gap-1">
        {view.fields.map((f) => (
          <div key={f.key} className="flex flex-col gap-1 border-b border-ln py-1 last:border-b-0" data-testid={`ask-field-${f.key}`}>
            <div className="flex items-center justify-between gap-2">
              <dt className="text-[13px] text-ink2">{f.labelAr}</dt>
              <dd className="m-0 flex items-center gap-2 text-[14px] text-ink">
                <span>{f.customerWords ? `«${f.valueAr}»` : f.valueAr}</span>
                {f.editable && editing !== f.key ? <button type="button" className={BTN_PLAIN} disabled={busy} onClick={() => { setEditing(f.key); setDraft({}); setLocalError(null); }} data-testid={`ask-edit-${f.key}`}>{ASK_CARD_EDIT_AR}</button> : null}
              </dd>
            </div>
            {editing === f.key ? (
              <div className="flex flex-col gap-2" data-testid={`ask-editor-${f.key}`}>
                {f.input.kind === "choice" ? (
                  <div className="flex flex-wrap gap-2" role="group" aria-label={f.labelAr}>
                    {f.input.options.map((o) => <button key={o.value} type="button" className={BTN_PLAIN} disabled={busy} onClick={() => send(f, { choice: o.value })}>{o.labelAr}</button>)}
                  </div>
                ) : f.input.kind === "number" ? (
                  <input className={INPUT} inputMode="numeric" aria-label={f.labelAr} min={f.input.min} max={f.input.max} value={draft.text ?? ""} onChange={(e) => setDraft({ text: e.target.value })} />
                ) : f.input.kind === "text" ? (
                  <input className={INPUT} aria-label={f.labelAr} maxLength={f.input.maxChars} value={draft.text ?? ""} onChange={(e) => setDraft({ text: e.target.value })} />
                ) : f.input.kind === "period" ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <label className="flex items-center gap-1 text-[13px] text-ink2">{ASK_CARD_FROM_AR}<input type="date" className={INPUT} value={draft.from ?? ""} onChange={(e) => setDraft({ ...draft, from: e.target.value })} /></label>
                    <label className="flex items-center gap-1 text-[13px] text-ink2">{ASK_CARD_TO_AR}<input type="date" className={INPUT} value={draft.to ?? ""} onChange={(e) => setDraft({ ...draft, to: e.target.value })} /></label>
                  </div>
                ) : null}
                {f.scope === "new_read" ? <p className="m-0 text-[12px] text-ink2" data-testid="ask-new-read">{ASK_EDIT_NEW_READ_AR}</p> : null}
                <div className="flex flex-wrap gap-2">
                  {f.input.kind !== "choice" ? <button type="button" className={BTN_PRIMARY} disabled={busy} onClick={() => send(f, draft)}>{ASK_CARD_SAVE_AR}</button> : null}
                  {f.key === "period" ? <button type="button" className={BTN_PLAIN} disabled={busy} onClick={() => send(f, { clear: true })}>{ASK_CARD_NO_PERIOD_AR}</button> : null}
                  {f.key === "source" || f.key === "budget" ? <button type="button" className={BTN_PLAIN} disabled={busy} onClick={() => send(f, { clear: true })}>{ASK_CARD_CLEAR_AR}</button> : null}
                  <button type="button" className={BTN_PLAIN} disabled={busy} onClick={() => { setEditing(null); setDraft({}); setLocalError(null); }}>{ASK_CARD_CANCEL_AR}</button>
                </div>
              </div>
            ) : null}
          </div>
        ))}
      </dl>
      {localError || errorAr ? <p role="alert" className="m-0 text-[13px] text-ink" data-testid="ask-error">{localError ?? errorAr}</p> : null}
    </section>
  );
}

export default AskCard;
