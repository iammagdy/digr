"use client";

import { useMemo, useState } from "react";
import { proseDigitsAr, toArabicDigits } from "@/lib/arabicDigits";
import { normalizeDiscoveryQuestions, sanitizeDiscoveryText, type DiscoveryAnswer, type DiscoveryQuestion } from "./discoveryQuestions";

interface DetailsBlanksProps {
  questions: unknown;
  intro?: string;
  completedAnswers?: DiscoveryAnswer[];
  disabled?: boolean;
  /** A plan was made after these answers: a question that was skipped is no longer a gap, so its row («تُرك هذا الاختيار») is not listed. */
  planExists?: boolean;
  onComplete: (answers: DiscoveryAnswer[]) => void;
}

function answerLabel(answer: DiscoveryAnswer | undefined): string {
  if (answer?.skipped) return "تُرك هذا الاختيار";
  if (Array.isArray(answer?.value)) return answer.value.join("، ");
  return answer?.value || "";
}

/** Adaptive, one-question-at-a-time Arabic clarification flow embedded in chat. */
export default function DetailsBlanks({ questions, intro, completedAnswers, disabled = false, planExists = false, onComplete }: DetailsBlanksProps) {
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
  const currentAnswered = Boolean(answer?.skipped || answer?.value);
  const displayIntro = intro?.trim() || "خلّيني أوضح تفاصيل طلبك عشان أجهز خطة مناسبة.";

  function moveTo(index: number) {
    const target = Math.max(0, Math.min(index, qs.length - 1));
    setStep(target);
    // Going back to a question answered with the customer's own words shows those words in the field, so the answer can be edited, not retyped.
    const earlier = answers[qs[target].id];
    const typedBefore = typeof earlier?.value === "string" && !qs[target].options.includes(earlier.value) ? earlier.value : "";
    setDraft(typedBefore);
    setCustomInputOpen(Boolean(typedBefore));
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
    const withSkip: Record<string, DiscoveryAnswer> = { ...answers, [current.id]: skippedAnswer };
    setAnswers(withSkip);
    // The next question still open (after this one, then any before it); when none is left the answers go on (a skip on the last question was a dead end).
    const open = [...qs.slice(step + 1), ...qs.slice(0, step)].find((q) => !withSkip[q.id]?.skipped && !withSkip[q.id]?.value);
    if (open) { moveTo(qs.indexOf(open)); return; }
    if (!disabled) onComplete(qs.map((q) => withSkip[q.id]).filter((item): item is DiscoveryAnswer => Boolean(item)));
  }

  function submitCustom(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = sanitizeDiscoveryText(draft, current.type === "multi" ? 40 : 200);
    if (!value) return;
    // A typed answer to the only open question is the answer: it goes straight on, with no second «add» then «continue».
    if (qs.length === 1 && current.type !== "multi" && !disabled) {
      onComplete([{ questionId: current.id, question: current.text, value }]);
      setDraft("");
      return;
    }
    if (current.type === "multi") save(current, [...selected, value].slice(0, 4));
    else save(current, value);
    setDraft("");
    setCustomInputOpen(false);
  }

  /** The ONE «إجابة ومتابعة»: keeps what was typed or chosen, then goes to the next question, or sends everything from the last one. */
  function advance() {
    if (disabled) return;
    const typed = sanitizeDiscoveryText(draft, current.type === "multi" ? 40 : 200);
    if (typed && qs.length === 1 && current.type !== "multi") {
      const value = typed;
      onComplete([{ questionId: current.id, question: current.text, value }]);
      setDraft("");
      return;
    }
    let next = answers;
    if (typed) {
      next = { ...answers, [current.id]: { questionId: current.id, question: current.text, value: current.type === "multi" ? [...selected, typed].slice(0, 4) : typed } };
      setAnswers(next);
      setDraft("");
      setCustomInputOpen(false);
    }
    if (!(next[current.id]?.skipped || next[current.id]?.value)) return;
    if (step < qs.length - 1) { moveTo(step + 1); return; }
    const result = qs.map((q) => next[q.id]).filter((item): item is DiscoveryAnswer => Boolean(item));
    if (result.length === qs.length) onComplete(result);
  }

  if (locked) {
    // With a plan on screen the summary lists only what was answered: a skipped row would say «تُرك هذا الاختيار» about a question the plan already settled.
    const rows = qs.filter((q) => !(planExists && completedAnswers!.find((entry) => entry.questionId === q.id)?.skipped));
    if (rows.length === 0) return null;
    return (
      <section className="mt-3.5 rounded-2xl border border-ln bg-sf p-4" aria-label="ملخص التوضيحات" dir="rtl">
        <h3 className="m-0 text-sm font-semibold text-ink">ملخص طلبك</h3>
        <dl className="mb-0 mt-3 space-y-2">
          {rows.map((q) => {
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
      {/* The server sends ONE question per panel and the next panel is a new message, so a counter on a single question would say «سؤال ١ من ١» three times in a row.
          The counter and «السابق» exist only when this panel really holds several questions. */}
      {qs.length > 1 && (
        <div className="mt-3 flex items-center justify-between gap-3">
          <span className="text-xs text-mut" data-testid="clarification-progress">سؤال {toArabicDigits(step + 1)} من {toArabicDigits(qs.length)}</span>
          <div className="flex flex-1 flex-row-reverse gap-1" aria-hidden="true">
            {qs.map((q, index) => <span key={q.id} className="h-1 flex-1 rounded-full" style={{ background: index <= step ? "var(--gold)" : "var(--ln)" }} />)}
          </div>
        </div>
      )}
      {qs.length > 1 && qs.some((q, index) => index !== step && (answers[q.id]?.value || answers[q.id]?.skipped)) && (
        <ul data-testid="clarification-answers" className="m-0 mt-3 flex list-none flex-col gap-1 p-0">
          {qs.map((q, index) => {
            const given = answers[q.id];
            if (index === step || !(given?.value || given?.skipped)) return null;
            return (
              <li key={q.id} className="flex items-center justify-between gap-2 text-[12px] text-mut">
                <span className="min-w-0 truncate">{q.text}: <span className="text-ink">{answerLabel(given)}</span></span>
                <button type="button" onClick={() => moveTo(index)} disabled={disabled} className="min-h-11 shrink-0 cursor-pointer border-0 bg-transparent px-2 text-[12px] text-goldT">تعديل</button>
              </li>
            );
          })}
        </ul>
      )}

      <div key={current.id} className="mt-4" role="group" aria-labelledby={`clarification-${current.id}`}>
        <h3 id={`clarification-${current.id}`} className="m-0 text-base font-medium leading-7 text-ink">{proseDigitsAr(current.text)}</h3>
        {current.options.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {current.options.map((option) => {
              const isSelected = selected.includes(option);
              return <button key={option} type="button" aria-pressed={isSelected} disabled={disabled} onClick={() => choose(option)} className="min-h-11 cursor-pointer rounded-full px-3.5 text-[13px] text-ink transition-colors disabled:cursor-not-allowed disabled:opacity-50" style={{ border: `1px solid ${isSelected ? "var(--gold)" : "var(--ln)"}`, background: isSelected ? "var(--sf2)" : "var(--bg)" }}>{proseDigitsAr(option)}</button>;
            })}
            {current.allowOther && !current.options.includes("أخرى") && <button type="button" disabled={disabled} onClick={() => { setCustomInputOpen(true); setDraft(""); }} className="min-h-11 cursor-pointer rounded-full border border-dashed border-ln2 bg-transparent px-3.5 text-[13px] text-ink disabled:cursor-not-allowed disabled:opacity-50">أخرى</button>}
          </div>
        )}

        {(customInputOpen || current.type === "free" || current.options.length === 0 || current.parameterType === "volume" || current.id.includes("volume")) && (
          <form onSubmit={submitCustom} className="mt-3 flex items-center gap-2">
            <input value={draft} onChange={(event) => setDraft(event.target.value)} disabled={disabled} maxLength={200} type="text" inputMode={current.parameterType === "volume" || current.id.includes("volume") ? "numeric" : "text"} placeholder={current.options.length ? "اكتب اختيارك" : "اكتب إجابتك"} className="min-h-11 min-w-0 flex-1 rounded-full border border-ln bg-bg px-4 text-base text-ink outline-none focus:border-ln2 disabled:opacity-50" />
            {current.type === "multi" && <button type="submit" disabled={disabled || !draft.trim()} className="min-h-11 cursor-pointer rounded-full border-0 bg-ac px-4 text-[13px] text-onac disabled:cursor-not-allowed disabled:opacity-40">إضافة</button>}
          </form>
        )}
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-2">
          {qs.length > 1 && <button type="button" disabled={disabled || step === 0} onClick={() => moveTo(step - 1)} className="min-h-11 cursor-pointer rounded-full border border-ln px-4 text-[13px] text-ink disabled:cursor-not-allowed disabled:opacity-40">السابق</button>}
          <button
            type="button" onClick={advance} disabled={disabled || !(currentAnswered || draft.trim())}
            title={step < qs.length - 1 ? "الانتقال إلى السؤال التالي" : "إرسال الإجابات ومتابعة الخطة"}
            className="min-h-11 cursor-pointer rounded-full border-0 bg-ac px-5 text-[13px] text-onac disabled:cursor-not-allowed disabled:opacity-40"
          >إجابة ومتابعة</button>
        </div>
        <button type="button" onClick={skipCurrent} disabled={disabled} className="min-h-11 cursor-pointer rounded-full border-0 bg-transparent px-3 text-[13px] text-mut">تخطّي السؤال</button>
      </div>
    </section>
  );
}
