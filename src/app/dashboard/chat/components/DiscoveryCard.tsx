"use client";

import { useMemo, useState } from "react";
import { normalizeDiscoveryQuestions, sanitizeDiscoveryText, type DiscoveryAnswer } from "./discoveryQuestions";
import { Badge } from "@/components/ui";
import { formatNumber } from "@/lib/honestDisplay";

interface DiscoveryCardProps {
  questions: unknown;
  completedAnswers?: DiscoveryAnswer[];
  disabled?: boolean;
  onSubmit: (answers: DiscoveryAnswer[]) => void;
}

function answerLabel(answer: DiscoveryAnswer | undefined): string {
  if (!answer) return "بانتظار الإجابة";
  if (answer.skipped) {
    const v = Array.isArray(answer.value) ? answer.value.join("، ") : answer.value;
    return v ? `القيمة المقترحة: ${v}` : "سيُطلب منك الاختيار";
  }
  return Array.isArray(answer.value) ? answer.value.join("، ") : answer.value || "";
}

function compactFieldLabel(parameterType: string | undefined, index: number): string {
  const labels: Record<string, string> = {
    platform: "المنصة",
    time_window: "الفترة",
    volume: "العدد",
    output_format: "الصيغة",
    anonymize: "إخفاء الهوية",
    language: "اللغة",
    topic: "الموضوع",
  };
  return parameterType ? labels[parameterType] ?? `الإجابة ${formatNumber(index + 1)}` : `الإجابة ${formatNumber(index + 1)}`;
}

export default function DiscoveryCard({ questions, completedAnswers, disabled = false, onSubmit }: DiscoveryCardProps) {
  const normalizedQuestions = useMemo(() => normalizeDiscoveryQuestions(questions), [questions]);
  const [answers, setAnswers] = useState<Record<string, DiscoveryAnswer>>({});
  const [otherOpen, setOtherOpen] = useState<Record<string, boolean>>({});
  const [otherDraft, setOtherDraft] = useState<Record<string, string>>({});
  const [freeDraft, setFreeDraft] = useState<Record<string, string>>({});
  const [summaryEditId, setSummaryEditId] = useState<string | null>(null);
  const [summaryDraft, setSummaryDraft] = useState("");

  const answerList = normalizedQuestions.map((question) => answers[question.id]).filter(Boolean);
  const allAnswered = normalizedQuestions.length > 0 && answerList.length === normalizedQuestions.length;
  const answeredCount = answerList.length;

  function setAnswer(questionId: string, value: string | string[], skipped = false) {
    const question = normalizedQuestions.find((item) => item.id === questionId);
    if (!question) return;
    // Trust boundary: on skip, the client echoes the displayed default (computed
    // server-side) so the assistant receives a real value instead of placeholder
    // text. The server treats this as the user's explicit answer — it cannot
    // revalidate the default — and any plan built from it still passes
    // server-side plan and quote validation.
    const resolvedDefault = skipped ? question.defaultOption : undefined;
    setAnswers((previous) => ({
      ...previous,
      [questionId]: {
        questionId,
        question: question.text,
        ...(skipped ? {} : { value }),
        ...(skipped ? { skipped: true } : {}),
        ...(resolvedDefault ? { value: resolvedDefault, resolvedDefault: true } : {}),
      },
    }));
  }

  function chooseOption(questionId: string, option: string) {
    const question = normalizedQuestions.find((item) => item.id === questionId);
    if (!question) return;
    if (question.type === "multi") {
      const previous = answers[questionId]?.value;
      const selected = Array.isArray(previous) ? previous : [];
      const next = selected.includes(option)
        ? selected.filter((value) => value !== option)
        : [...selected, option].slice(0, 4);
      if (next.length) setAnswer(questionId, next);
      else setAnswers((current) => {
        const copy = { ...current };
        delete copy[questionId];
        return copy;
      });
    } else {
      setAnswer(questionId, option);
    }
  }

  function submitOther(questionId: string) {
    const question = normalizedQuestions.find((item) => item.id === questionId);
    const value = sanitizeDiscoveryText(otherDraft[questionId], question?.type === "multi" ? 40 : 120);
    if (!question || !value) return;
    if (question.type === "multi") {
      const existing = answers[questionId]?.value;
      const selected = Array.isArray(existing) ? existing : [];
      setAnswer(questionId, [...selected, value].slice(0, 4));
    } else {
      setAnswer(questionId, value);
    }
    setOtherOpen((current) => ({ ...current, [questionId]: false }));
    setOtherDraft((current) => ({ ...current, [questionId]: "" }));
  }

  function submitFreeText(questionId: string) {
    const value = sanitizeDiscoveryText(freeDraft[questionId], 200);
    if (value) setAnswer(questionId, value);
  }

  function submitSummaryEdit(questionId: string) {
    const question = normalizedQuestions.find((item) => item.id === questionId);
    if (!question) return;
    const value = sanitizeDiscoveryText(summaryDraft, 200);
    if (!value) return;
    setAnswer(questionId, question.type === "multi"
      ? value.split(/[،,]+/).map((part) => sanitizeDiscoveryText(part, 40)).filter(Boolean).slice(0, 4)
      : value);
    setSummaryEditId(null);
    setSummaryDraft("");
  }

  /* Completed summary */
  if (completedAnswers?.length) {
    return (
      <div className="mt-3 rounded-2xl border border-sand-200 bg-sand-50 p-4" aria-label="ملخص الإجابات">
        <p className="mb-2.5 text-xs font-bold text-ink-800">ملخص إجاباتك</p>
        <div className="flex flex-wrap gap-1.5">
          {completedAnswers.map((answer) => (
            <span key={answer.questionId} className="max-w-full rounded-xl border border-sand-200 bg-white px-3 py-2 text-xs text-ink-800 break-words">
              <bdi className="font-semibold">{answer.question}:</bdi> {answerLabel(answer)}
            </span>
          ))}
        </div>
      </div>
    );
  }

  if (normalizedQuestions.length === 0) {
    return (
      <div className="mt-3 rounded-2xl border border-sand-200 bg-sand-50 p-4 text-xs leading-relaxed text-sand-700">
        تعذّر عرض أسئلة التوضيح. يمكنك كتابة تفاصيل طلبك في مربع الرسالة.
      </div>
    );
  }

  return (
    <section className="mt-3 overflow-hidden rounded-2xl border border-sand-200 bg-white shadow-[var(--shadow-card)]" aria-label="أسئلة استكشافية">
      {/* Header with progress */}
      <div className="border-b border-sand-100 bg-sand-50/60 px-4 py-3.5 sm:px-5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-bold text-ink-900">لنخصّص خطة بحثك</h3>
            <p className="mt-0.5 text-xs text-sand-600">أجب عن الأسئلة التالية — أو تخطَّ ما يناسبك</p>
          </div>
          {normalizedQuestions.length > 1 && (
            <span className="tnum shrink-0 rounded-full bg-white px-2.5 py-1 text-xs font-bold text-ink-800 ring-1 ring-sand-200" aria-live="polite" dir="ltr">
              {formatNumber(answeredCount)} / {formatNumber(normalizedQuestions.length)}
            </span>
          )}
        </div>
        {normalizedQuestions.length > 1 && (
          <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-sand-200" role="progressbar" aria-valuenow={answeredCount} aria-valuemin={0} aria-valuemax={normalizedQuestions.length} aria-label="تقدم الإجابات">
            <div className="h-full rounded-full bg-accent transition-[width] duration-300 motion-reduce:transition-none" style={{ width: `${normalizedQuestions.length ? (answeredCount / normalizedQuestions.length) * 100 : 0}%` }} />
          </div>
        )}
      </div>

      <div className="space-y-3 p-3.5 sm:p-5">
        {normalizedQuestions.map((item, index) => {
          const selectedValue = answers[item.id]?.value;
          const selectedOptions = Array.isArray(selectedValue) ? selectedValue : selectedValue ? [selectedValue] : [];
          const isAnswered = Boolean(answers[item.id]);
          const wasSkipped = Boolean(answers[item.id]?.skipped);
          return (
            <div
              id={`discovery-${item.id}`}
              key={item.id}
              className={`rounded-2xl border p-4 transition-colors ${isAnswered ? "border-accent/30 bg-accent-light/30" : "border-sand-200 bg-white"}`}
              dir="rtl"
            >
              <div className="flex items-start justify-between gap-3">
                <p className="text-sm font-bold leading-relaxed text-ink-900" dir="auto">
                  <span aria-hidden="true" className="tnum me-1.5 text-xs font-bold text-accent">{formatNumber(index + 1)}.</span>
                  {item.text}
                </p>
                {isAnswered && (
                  <Badge tone={wasSkipped ? "neutral" : "success"} className="shrink-0">
                    {wasSkipped ? "مقترح" : "تم"}
                  </Badge>
                )}
              </div>

              {item.options.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-2" role={item.type === "multi" ? "group" : "radiogroup"} aria-label={item.text}>
                  {item.options.map((option) => {
                    const selected = selectedOptions.includes(option);
                    return (
                      <button
                        key={option}
                        type="button"
                        disabled={disabled}
                        role={item.type === "multi" ? "checkbox" : "radio"}
                        aria-checked={selected}
                        onClick={() => chooseOption(item.id, option)}
                        className={`min-h-11 max-w-full cursor-pointer rounded-xl border px-3.5 py-2 text-xs font-semibold whitespace-normal break-words transition-all focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-60 ${
                          selected
                            ? "border-accent bg-accent text-white shadow-xs"
                            : "border-sand-300 bg-white text-ink-800 hover:border-accent/50 hover:bg-accent-light/40"
                        }`}
                      >
                        {option}
                      </button>
                    );
                  })}
                </div>
              )}

              {item.type === "free" && (
                <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                  <input
                    type="text"
                    maxLength={200}
                    dir="auto"
                    value={freeDraft[item.id] ?? (typeof selectedValue === "string" && !item.options.includes(selectedValue) ? selectedValue : "")}
                    onChange={(event) => setFreeDraft((current) => ({ ...current, [item.id]: event.target.value }))}
                    placeholder="اكتب إجابة قصيرة"
                    aria-label={item.text}
                    className="min-h-11 min-w-0 flex-1 rounded-xl border border-sand-300 bg-white px-3.5 text-sm text-ink-900 outline-none placeholder:text-sand-400 focus:border-accent"
                  />
                  <button
                    type="button"
                    disabled={disabled || !sanitizeDiscoveryText(freeDraft[item.id], 200)}
                    onClick={() => submitFreeText(item.id)}
                    className="min-h-11 shrink-0 cursor-pointer rounded-xl bg-primary px-4 text-xs font-bold text-white transition-colors hover:bg-primary-hover focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    اعتماد الإجابة
                  </button>
                </div>
              )}

              {item.allowOther && (
                <div className="mt-2.5">
                  <button
                    type="button"
                    disabled={disabled}
                    aria-expanded={Boolean(otherOpen[item.id])}
                    onClick={() => setOtherOpen((current) => ({ ...current, [item.id]: !current[item.id] }))}
                    className="min-h-11 cursor-pointer rounded-xl border border-dashed border-sand-300 bg-white px-3.5 text-xs font-semibold text-ink-700 transition-colors hover:border-accent/50 hover:text-accent-ink focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    + أخرى
                  </button>
                  {otherOpen[item.id] && (
                    <div className="animate-fade mt-2 flex flex-col gap-2 sm:flex-row">
                      <input
                        type="text"
                        maxLength={item.type === "multi" ? 40 : 120}
                        dir="auto"
                        value={otherDraft[item.id] ?? ""}
                        onChange={(event) => setOtherDraft((current) => ({ ...current, [item.id]: event.target.value }))}
                        placeholder="اكتب اختيارك"
                        aria-label={`خيار آخر لـ: ${item.text}`}
                        className="min-h-11 min-w-0 flex-1 rounded-xl border border-sand-300 bg-white px-3.5 text-sm text-ink-900 outline-none placeholder:text-sand-400 focus:border-accent"
                      />
                      <button
                        type="button"
                        disabled={disabled || !sanitizeDiscoveryText(otherDraft[item.id], item.type === "multi" ? 40 : 120)}
                        onClick={() => submitOther(item.id)}
                        className="min-h-11 shrink-0 cursor-pointer rounded-xl bg-primary px-4 text-xs font-bold text-white transition-colors hover:bg-primary-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        إضافة الإجابة
                      </button>
                    </div>
                  )}
                </div>
              )}

              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-sand-100 pt-2.5">
                <span className="text-xs text-sand-600" aria-live="polite">
                  {isAnswered ? (
                    <span>الإجابة: <strong className="text-ink-800">{answerLabel(answers[item.id])}</strong></span>
                  ) : (
                    "اختر إجابة أو استخدم القيمة المقترحة"
                  )}
                </span>
                {!isAnswered && item.defaultOption && (
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => setAnswer(item.id, "", true)}
                    className="min-h-11 cursor-pointer rounded-xl px-3 text-xs font-semibold text-accent underline decoration-accent/40 underline-offset-4 transition-colors hover:bg-accent-light focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    تخطّى واستخدم الافتراضي: {item.defaultOption}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {allAnswered && (
        <div className="animate-rise border-t border-sand-200 bg-sand-50/70 p-4 sm:p-5" aria-label="ملخص الطلب قبل الإرسال">
          <p className="mb-3 text-xs font-bold text-ink-800">ملخص إجاباتك — اضغط على أي إجابة لتعديلها</p>
          <div className="flex flex-wrap gap-2">
            {normalizedQuestions.map((question, index) => {
              const answer = answers[question.id];
              const fieldLabel = compactFieldLabel(question.parameterType, index);
              return (
                <div key={question.id} className="max-w-full">
                  {summaryEditId === question.id ? (
                    <div className="flex max-w-full flex-wrap items-center gap-2">
                      <input
                        type="text"
                        value={summaryDraft}
                        onChange={(event) => setSummaryDraft(event.target.value)}
                        maxLength={200}
                        aria-label={`تعديل ${fieldLabel}: ${question.text}`}
                        className="min-h-11 min-w-32 rounded-xl border border-accent bg-white px-3 text-xs outline-none"
                      />
                      <button type="button" onClick={() => submitSummaryEdit(question.id)} className="min-h-11 cursor-pointer rounded-xl bg-sand-200 px-4 text-xs font-bold text-ink-800 hover:bg-sand-300">حفظ</button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        setSummaryEditId(question.id);
                        setSummaryDraft(answer.skipped ? question.defaultOption ?? "" : Array.isArray(answer.value) ? answer.value.join("، ") : answer.value ?? "");
                      }}
                      className="min-h-11 max-w-full cursor-pointer rounded-xl border border-sand-200 bg-white px-3.5 py-2 text-xs text-ink-800 break-words transition-colors hover:border-accent/40 hover:bg-accent-light/30"
                    >
                      <bdi className="font-bold">{fieldLabel}:</bdi> {answerLabel(answer)}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
          <button
            type="button"
            disabled={disabled}
            onClick={() => onSubmit(normalizedQuestions.map((question) => answers[question.id]))}
            className="mt-4 min-h-12 w-full cursor-pointer rounded-2xl bg-accent px-4 py-3 text-sm font-bold text-white shadow-[var(--shadow-ink)] transition-colors hover:bg-accent-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-60"
          >
            تأكيد الإجابات وإرسالها
          </button>
        </div>
      )}
    </section>
  );
}
