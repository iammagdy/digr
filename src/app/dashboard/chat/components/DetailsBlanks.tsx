"use client";

import { useMemo, useState } from "react";
import { toArabicDigits } from "@/lib/arabicDigits";
import { normalizeDiscoveryQuestions, sanitizeDiscoveryText, type DiscoveryAnswer, type DiscoveryQuestion } from "./discoveryQuestions";

interface DetailsBlanksProps {
  questions: unknown;
  intro?: string;
  completedAnswers?: DiscoveryAnswer[];
  disabled?: boolean;
  onComplete: (answers: DiscoveryAnswer[]) => void;
}

function answerLabel(answer: DiscoveryAnswer | undefined): string {
  if (answer?.skipped) return "تُرك هذا الاختيار";
  if (Array.isArray(answer?.value)) return answer.value.join("، ");
  return answer?.value || "";
}

/** Adaptive, one-question-at-a-time Arabic clarification flow embedded in chat. */
export default function DetailsBlanks({ questions, intro, completedAnswers, disabled = false, onComplete }: DetailsBlanksProps) {
  const qs = useMemo(() => normalizeDiscoveryQuestions(questions), [questions]);
  const [answers, setAnswers] = useState<Record<string, DiscoveryAnswer>>({});
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState("");
  const [customInputOpen, setCustomInputOpen] = useState(false);

  if (!qs.length) return null;

  const locked = !!completedAnswers?.length;
  const current = qs[Math.min(step, qs.length - 1)];
  const answer = answers[current.id];
  const selected = Array.isArray(answer?.value) ? answer.value : answer?.value ? [answer.value] : [];
  const ready = qs.every((q) => Boolean(answers[q.id]?.skipped || answers[q.id]?.value));
  const currentAnswered = Boolean(answer?.skipped || answer?.value);
  const displayIntro = intro?.trim() || "خلّيني أوضح تفاصيل طلبك عشان أجهز خطة مناسبة.";

  function moveTo(index: number) {
    setStep(Math.max(0, Math.min(index, qs.length - 1)));
    setDraft("");
    setCustomInputOpen(false);
  }

  function save(q: DiscoveryQuestion, value: string | string[]) {
    setAnswers((previous) => ({ ...previous, [q.id]: { questionId: q.id, question: q.text, value } }));
  }

  function choose(option: string) {
    if (option.trim() === "أخرى" && current.allowOther) {
      setDraft("");
      setCustomInputOpen(true);
      return;
    }
    if (current.type === "multi") {
      const next = selected.includes(option) ? selected.filter((value) => value !== option) : [...selected, option].slice(0, 4);
      setAnswers((previous) => {
        const copy = { ...previous };
        if (next.length) copy[current.id] = { questionId: current.id, question: current.text, value: next };
        else delete copy[current.id];
        return copy;
      });
      return;
    }
    save(current, option);
  }

  function skipCurrent() {
    const skippedAnswer = { questionId: current.id, question: current.text, skipped: true } satisfies DiscoveryAnswer;
    if (qs.length === 1) {
      onComplete([skippedAnswer]);
      return;
    }
    setAnswers((previous) => ({ ...previous, [current.id]: skippedAnswer }));
    if (step < qs.length - 1) moveTo(step + 1);
  }

  function submitCustom(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = sanitizeDiscoveryText(draft, current.type === "multi" ? 40 : 200);
    if (!value) return;
    if (current.type === "multi") save(current, [...selected, value].slice(0, 4));
    else save(current, value);
    setDraft("");
    setCustomInputOpen(false);
  }

  function submitAll() {
    const result = qs.map((q) => answers[q.id]).filter((item): item is DiscoveryAnswer => Boolean(item));
    if (result.length === qs.length) onComplete(result);
  }

  if (locked) {
    return (
      <section className="mt-3.5 rounded-2xl border border-ln bg-sf p-4" aria-label="ملخص التوضيحات" dir="rtl">
        <h3 className="m-0 text-sm font-semibold text-ink">ملخص طلبك</h3>
        <dl className="mb-0 mt-3 space-y-2">
          {qs.map((q) => {
            const item = completedAnswers!.find((entry) => entry.questionId === q.id);
            return <div key={q.id} className="grid grid-cols-1 gap-1 text-[13px] sm:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]"><dt className="text-mut">{q.text}</dt><dd className="m-0 text-ink">{answerLabel(item) || "—"}</dd></div>;
          })}
        </dl>
      </section>
    );
  }

  return (
    <section className="mt-3.5 rounded-2xl border border-ln bg-sf p-4" aria-label="أسئلة توضيح الطلب" dir="rtl">
      <p className="m-0 text-[14px] leading-7 text-ink">{displayIntro}</p>
      {qs.length > 1 ? (
        <div className="mt-3 flex items-center justify-between gap-3">
          <span className="text-xs text-mut">سؤال {toArabicDigits(step + 1)} من {toArabicDigits(qs.length)}</span>
          <div className="flex flex-1 flex-row-reverse gap-1" aria-hidden="true">
            {qs.map((q, index) => <span key={q.id} className="h-1 flex-1 rounded-full" style={{ background: index <= step ? "var(--gold)" : "var(--ln)" }} />)}
          </div>
        </div>
      ) : (
        <p className="mb-0 mt-3 text-xs text-mut">سؤال توضيحي</p>
      )}

      <div key={current.id} className="mt-4" role="group" aria-labelledby={`clarification-${current.id}`}>
        <h3 id={`clarification-${current.id}`} className="m-0 text-base font-medium leading-7 text-ink">{current.text}</h3>
        {current.options.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {current.options.map((option) => {
              const isSelected = selected.includes(option);
              return <button key={option} type="button" aria-pressed={isSelected} disabled={disabled} onClick={() => choose(option)} className="min-h-11 cursor-pointer rounded-full px-3.5 text-[13px] text-ink transition-colors disabled:cursor-not-allowed disabled:opacity-50" style={{ border: `1px solid ${isSelected ? "var(--gold)" : "var(--ln)"}`, background: isSelected ? "var(--sf2)" : "var(--bg)" }}>{option}</button>;
            })}
            {current.allowOther && !current.options.includes("أخرى") && <button type="button" disabled={disabled} onClick={() => { setCustomInputOpen(true); setDraft(""); }} className="min-h-11 cursor-pointer rounded-full border border-dashed border-ln2 bg-transparent px-3.5 text-[13px] text-ink disabled:cursor-not-allowed disabled:opacity-50">أخرى</button>}
          </div>
        )}

        {(customInputOpen || current.type === "free" || current.options.length === 0 || current.parameterType === "volume" || current.id.includes("volume")) && (
          <form onSubmit={submitCustom} className="mt-3 flex items-center gap-2">
            <input value={draft} onChange={(event) => setDraft(event.target.value)} disabled={disabled} maxLength={200} type={current.parameterType === "volume" || current.id.includes("volume") ? "number" : "text"} inputMode={current.parameterType === "volume" || current.id.includes("volume") ? "numeric" : "text"} min={current.parameterType === "volume" || current.id.includes("volume") ? 1 : undefined} max={current.parameterType === "volume" || current.id.includes("volume") ? 5000 : undefined} placeholder={current.options.length ? "اكتب اختيارك" : "اكتب إجابتك"} className="min-h-11 min-w-0 flex-1 rounded-full border border-ln bg-bg px-4 text-base text-ink outline-none focus:border-ln2 disabled:opacity-50" />
            <button type="submit" disabled={disabled || !draft.trim()} className="min-h-11 cursor-pointer rounded-full border-0 bg-ac px-4 text-[13px] text-onac disabled:cursor-not-allowed disabled:opacity-40">إضافة</button>
          </form>
        )}
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-2">
          <button type="button" disabled={disabled || step === 0} onClick={() => moveTo(step - 1)} className="min-h-11 cursor-pointer rounded-full border border-ln px-4 text-[13px] text-ink disabled:cursor-not-allowed disabled:opacity-40">السابق</button>
          {step < qs.length - 1 ? (
            <button type="button" disabled={disabled || !currentAnswered} onClick={() => moveTo(step + 1)} className="min-h-11 cursor-pointer rounded-full border-0 bg-ac px-5 text-[13px] text-onac disabled:cursor-not-allowed disabled:opacity-40">التالي</button>
          ) : (
            <button type="button" onClick={submitAll} disabled={disabled || !ready} className="min-h-11 cursor-pointer rounded-full border-0 bg-ac px-5 text-[13px] text-onac disabled:cursor-not-allowed disabled:opacity-40">{qs.length === 1 ? "إجابة ومتابعة" : "متابعة وحساب التكلفة"}</button>
          )}
        </div>
        <button type="button" onClick={skipCurrent} disabled={disabled} className="min-h-11 cursor-pointer rounded-full border-0 bg-transparent px-3 text-[13px] text-mut">تخطّي السؤال</button>
      </div>
    </section>
  );
}
