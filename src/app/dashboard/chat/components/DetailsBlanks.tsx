"use client";

import { useMemo, useState } from "react";
import { normalizeDiscoveryQuestions, sanitizeDiscoveryText, type DiscoveryAnswer, type DiscoveryQuestion } from "./discoveryQuestions";

interface DetailsBlanksProps {
  questions: unknown;
  completedAnswers?: DiscoveryAnswer[];
  disabled?: boolean;
  onComplete: (answers: DiscoveryAnswer[]) => void;
}

/** Natural-language lead-in per parameter, so the questions read as one sentence: «أحتاج بيانات على [تيك توك]، حوالي [١٠٠ سجل]، خلال [آخر شهر].» */
const LEAD: Record<string, (w: string) => string> = {
  platform: () => "على",
  volume: () => "حوالي",
  time_window: () => "خلال",
  output_format: () => "بصيغة",
  anonymize: () => "مع إخفاء الهوية:",
  language: () => "باللغة",
  topic: () => "حول",
};

function show(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value.join("، ") : value || "";
}

const WORD_CLS =
  "inline cursor-pointer whitespace-nowrap rounded-lg border-0 px-1 font-[inherit] font-medium text-ink underline decoration-gold decoration-2 underline-offset-[5px] disabled:cursor-default";

/** Design «التفاصيل»: one sentence whose underlined words are the assistant's discovery questions. */
export default function DetailsBlanks({ questions, completedAnswers, disabled = false, onComplete }: DetailsBlanksProps) {
  const qs = useMemo(() => normalizeDiscoveryQuestions(questions), [questions]);
  const [answers, setAnswers] = useState<Record<string, DiscoveryAnswer>>({});
  const [openId, setOpenId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  if (qs.length === 0) return null;

  const locked = !!completedAnswers?.length;
  const answerFor = (q: DiscoveryQuestion): DiscoveryAnswer | undefined =>
    locked ? completedAnswers!.find((a) => a.questionId === q.id) : answers[q.id];

  /** What the underlined word shows right now. */
  const wordFor = (q: DiscoveryQuestion): { text: string; set: boolean } => {
    const a = answerFor(q);
    if (a?.value) return { text: show(a.value), set: true };
    if (a?.skipped) return { text: "سيُطلب منك الاختيار", set: true };
    if (q.defaultOption) return { text: q.defaultOption, set: true };
    return { text: "اختر", set: false };
  };

  const ready = qs.every((q) => wordFor(q).set);

  function put(q: DiscoveryQuestion, value: string | string[]) {
    setAnswers((prev) => ({ ...prev, [q.id]: { questionId: q.id, question: q.text, value } }));
  }
  function skip(q: DiscoveryQuestion) {
    // Trust boundary (unchanged): the client echoes the displayed default; the server still validates the plan and quote.
    setAnswers((prev) => ({
      ...prev,
      [q.id]: { questionId: q.id, question: q.text, skipped: true, ...(q.defaultOption ? { value: q.defaultOption, resolvedDefault: true } : {}) },
    }));
    setOpenId(null);
  }
  function pick(q: DiscoveryQuestion, option: string) {
    if (option.trim() === "أخرى" && q.allowOther) {
      setDraft("");
      return;
    }
    if (q.type === "multi") {
      const prev = answers[q.id]?.value;
      const cur = Array.isArray(prev) ? prev : [];
      const next = cur.includes(option) ? cur.filter((v) => v !== option) : [...cur, option].slice(0, 4);
      if (next.length) put(q, next);
      else setAnswers((p) => { const c = { ...p }; delete c[q.id]; return c; });
    } else {
      put(q, option);
      setOpenId(null);
    }
  }
  function submitDraft(q: DiscoveryQuestion) {
    const v = sanitizeDiscoveryText(draft, q.type === "multi" ? 40 : 200);
    if (!v) return;
    if (q.type === "multi") {
      const prev = answers[q.id]?.value;
      put(q, [...(Array.isArray(prev) ? prev : []), v].slice(0, 4));
    } else {
      put(q, v);
      setOpenId(null);
    }
    setDraft("");
  }
  function finish() {
    const out: DiscoveryAnswer[] = qs.map((q) => {
      const a = answers[q.id];
      if (a) return a;
      // Untouched question: use the displayed default exactly as a skip would.
      return { questionId: q.id, question: q.text, skipped: true, ...(q.defaultOption ? { value: q.defaultOption, resolvedDefault: true } : {}) };
    });
    onComplete(out);
  }

  const open = qs.find((q) => q.id === openId) ?? null;
  const openAnswer = open ? answers[open.id] : undefined;
  const openSelected = open ? (Array.isArray(openAnswer?.value) ? openAnswer!.value : openAnswer?.value ? [openAnswer.value as string] : []) : [];

  return (
    <div>
      <p className="m-0 text-[15px] font-light leading-[2.1] text-ink">
        أحتاج بيانات{" "}
        {qs.map((q, i) => {
          const w = wordFor(q);
          const lead = q.parameterType ? LEAD[q.parameterType]?.(w.text) : undefined;
          return (
            <span key={q.id}>
              {lead ? `${lead} ` : <span className="text-mut">{q.text}: </span>}
              <button
                type="button"
                disabled={locked || disabled}
                onClick={() => { setOpenId(openId === q.id ? null : q.id); setDraft(""); }}
                aria-expanded={openId === q.id}
                className={WORD_CLS}
                style={{ background: openId === q.id ? "var(--sf2)" : "transparent", opacity: w.set ? 1 : 0.7 }}
              >
                {w.text}
              </button>
              {i < qs.length - 1 ? "، " : "."}
            </span>
          );
        })}
      </p>

      {open && !locked && (
        <div className="mt-3" style={{ animation: "up .3s both" }}>
          <p className="m-0 mb-2 text-xs font-light text-fnt">{open.text}</p>
          <div className="flex flex-wrap gap-2">
            {open.options.map((o) => {
              const on = openSelected.includes(o);
              return (
                <button
                  key={o} type="button" role={open.type === "multi" ? "checkbox" : "radio"} aria-checked={on} onClick={() => pick(open, o)}
                  className="min-h-11 cursor-pointer rounded-full px-3.5 text-[13px] text-ink"
                  style={{ border: `1px solid ${on ? "var(--gold)" : "var(--ln)"}`, background: on ? "var(--sf2)" : "var(--sf)" }}
                >
                  {o}
                </button>
              );
            })}
            <button type="button" onClick={() => skip(open)} className="min-h-11 cursor-pointer rounded-full border border-ln bg-transparent px-3.5 text-[13px] text-mut">
              {open.defaultOption ? "تخطّى واستخدم الافتراضي" : "تخطّي"}
            </button>
            {open.type === "multi" && (
              <button type="button" onClick={() => setOpenId(null)} className="min-h-11 cursor-pointer rounded-full border-0 bg-ac px-4 text-[13px] text-onac">تم</button>
            )}
          </div>
          {(open.allowOther || open.type === "free" || open.options.length === 0 || open.parameterType === "volume" || open.id.includes("volume")) && (
            <form onSubmit={(e) => { e.preventDefault(); submitDraft(open); }} className="mt-2.5 flex items-center gap-2">
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                maxLength={200}
                type={open.parameterType === "volume" || open.id.includes("volume") ? "number" : "text"}
                inputMode={open.parameterType === "volume" || open.id.includes("volume") ? "numeric" : "text"}
                min={open.parameterType === "volume" || open.id.includes("volume") ? 1 : undefined}
                max={open.parameterType === "volume" || open.id.includes("volume") ? 5000 : undefined}
                placeholder={
                  open.parameterType === "volume" || open.id.includes("volume")
                    ? "أو أدخل رقماً مخصصاً (مثلاً: 25، 50، 1000)..."
                    : open.options.length ? "أخرى…" : "اكتب إجابتك"
                }
                className="min-h-11 min-w-0 flex-1 rounded-full border border-ln bg-sf px-4 text-base font-light text-ink outline-none focus:border-ln2"
              />
              <button type="submit" disabled={!draft.trim()} className="min-h-11 cursor-pointer rounded-full border-0 bg-ac px-4 text-[13px] text-onac disabled:opacity-40">
                {open.parameterType === "volume" || open.id.includes("volume") ? "تطبيق العدد" : "إضافة"}
              </button>
            </form>
          )}
        </div>
      )}

      {!locked && (
        <div className="mt-5 flex flex-wrap items-center gap-3">
          <button
            type="button" onClick={finish} disabled={disabled || !ready}
            className="min-h-11 cursor-pointer rounded-full border-0 bg-ac px-[18px] text-[13px] text-onac disabled:cursor-not-allowed disabled:opacity-40"
          >
            احسب التكلفة
          </button>
          <span className="text-xs font-light text-fnt">اضغط على أي كلمة تحتها خط لتغييرها</span>
        </div>
      )}
    </div>
  );
}
