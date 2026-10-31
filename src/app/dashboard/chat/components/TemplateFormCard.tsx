"use client";

import { useId, useState, type FormEvent } from "react";
import { buildTemplateRequest, initialTemplateValues, templateProblems, type TemplateForm } from "@/lib/templateForms";

const FIELD = "min-h-12 w-full min-w-0 rounded-[14px] border border-ln2 bg-bg px-3.5 text-[15px] text-ink outline-none focus:border-ac";

/**
 * The small form a chip of the start page opens. It holds the few fields the request needs, filled with sensible defaults; the account, the topic or the link is empty and required (a placeholder
 * account is never sent). «أرسل» builds the request text from the fields and sends it; nothing is sent before that, and nothing is sent while a required field is empty.
 */
export default function TemplateFormCard({ form, onSend, onClose, disabled = false }: { form: TemplateForm; onSend: (text: string) => void | boolean | Promise<void | boolean>; onClose: () => void; disabled?: boolean }) {
  const uid = useId();
  const [values, setValues] = useState(() => initialTemplateValues(form));
  const [tried, setTried] = useState(false);
  const [sending, setSending] = useState(false);
  const problems = templateProblems(form, values);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setTried(true);
    const text = buildTemplateRequest(form, values);
    if (!text || sending || disabled) return;
    setSending(true);
    try { await onSend(text); } finally { setSending(false); }
  }

  return (
    <form onSubmit={submit} noValidate data-testid="template-form" data-template={form.id} aria-label={form.titleAr} className="flex w-full min-w-0 flex-col gap-3.5 rounded-[20px] border border-ln bg-sf p-4 text-right" style={{ animation: "up .3s both" }}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="m-0 text-[15px] font-semibold text-ink">{form.titleAr}</h3>
        <button type="button" onClick={onClose} aria-label="إغلاق النموذج" data-testid="template-form-close" className="flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent text-lg text-mut hover:bg-sf2">×</button>
      </div>
      <div className="grid min-w-0 grid-cols-1 gap-3 min-[560px]:grid-cols-2">
        {form.fields.map((f) => {
          const id = `${uid}-${f.id}`;
          const error = tried ? problems[f.id] : undefined;
          const wide = f.kind === "textarea" || f.link || f.id === "account" || f.id === "topic" || f.id === "activity";
          return (
            <div key={f.id} className={`flex min-w-0 flex-col gap-1.5 ${wide ? "min-[560px]:col-span-2" : ""}`}>
              <label htmlFor={id} className="text-[13px] font-medium text-ink">{f.labelAr}{f.required ? <span className="text-mut"> (مطلوب)</span> : null}</label>
              {f.kind === "select" ? (
                <select id={id} value={values[f.id]} onChange={(e) => setValues({ ...values, [f.id]: e.target.value })} className={FIELD}>
                  {f.options?.map((o) => <option key={o.value} value={o.value}>{o.labelAr}</option>)}
                </select>
              ) : f.kind === "textarea" ? (
                <textarea id={id} rows={3} value={values[f.id]} placeholder={f.placeholderAr} onChange={(e) => setValues({ ...values, [f.id]: e.target.value })} aria-invalid={Boolean(error)} aria-describedby={error ? `${id}-err` : undefined} className={`${FIELD} py-2.5 leading-[1.8]`} />
              ) : (
                <input id={id} type="text" inputMode={f.kind === "number" ? "numeric" : f.link ? "url" : "text"} dir={f.link ? "ltr" : "auto"} value={values[f.id]} placeholder={f.placeholderAr} onChange={(e) => setValues({ ...values, [f.id]: e.target.value })} aria-invalid={Boolean(error)} aria-describedby={error ? `${id}-err` : undefined} className={`${FIELD} ${f.link ? "text-left" : ""}`} />
              )}
              {f.helpAr && !error ? <p className="m-0 text-[12px] font-light text-mut">{f.helpAr}</p> : null}
              {error ? <p id={`${id}-err`} role="alert" className="m-0 text-[12px] text-bad">{error}</p> : null}
            </div>
          );
        })}
      </div>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <button type="submit" disabled={disabled || sending} data-testid="template-form-send" className="inline-flex min-h-12 w-full cursor-pointer items-center justify-center rounded-full border-0 bg-ac px-6 text-[15px] font-semibold text-onac disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto sm:min-w-[160px]">أرسل</button>
        <p className="m-0 text-[12px] font-light leading-[1.8] text-mut">لن يُخصم شيء قبل أن تراجع الخطة والسعر وتعتمد.</p>
      </div>
    </form>
  );
}
