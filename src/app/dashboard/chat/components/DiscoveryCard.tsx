"use client";

import { useMemo, useState } from "react";
import { normalizeDiscoveryQuestions, sanitizeDiscoveryText, type DiscoveryAnswer } from "./discoveryQuestions";

interface DiscoveryCardProps {
  questions: unknown;
  completedAnswers?: DiscoveryAnswer[];
  disabled?: boolean;
  onSubmit: (answers: DiscoveryAnswer[]) => void;
}

function answerLabel(answer: DiscoveryAnswer | undefined): string {
  if (!answer) return "بانتظار الإجابة";
  if (answer.skipped) {
    if (answer.value) return Array.isArray(answer.value) ? answer.value.join("، ") : answer.value;
    return "سيُطلب منك الاختيار";
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
  return parameterType ? labels[parameterType] ?? `الإجابة ${index + 1}` : `الإجابة ${index + 1}`;
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

  function setAnswer(questionId: string, value: string | string[], skipped = false) {
    const question = normalizedQuestions.find((item) => item.id === questionId);
    if (!question) return;
    // When skipping, the client echoes the displayed default (previously
    // computed server-side) so the assistant receives a real value instead of
    // placeholder text. The server treats this as the user's explicit answer —
    // it cannot revalidate the default — and any plan built from it still goes
    // through server-side plan and quote validation.
    const resolvedDefault = skipped ? question.defaultOption : undefined;
    setAnswers((previous) => ({
      ...previous,
      [questionId]: {
        questionId,
        question: question.text,
        ...(skipped ? { skipped: true } : { value }),
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

  if (completedAnswers?.length) {
    return (
      <div className="mt-3 rounded-xl border border-sand-200 bg-sand-50 p-3" aria-label="ملخص الإجابات">
        <div className="mb-2 text-xs font-semibold text-ink-800">ملخص إجاباتك</div>
        <div className="flex flex-wrap gap-1.5">
          {completedAnswers.map((answer) => (
            <span key={answer.questionId} className="max-w-full rounded-lg border border-sand-200 bg-white px-2.5 py-1.5 text-xs text-ink-800 break-words">
              <bdi>{answer.question}:</bdi> {answerLabel(answer)}
            </span>
          ))}
        </div>
      </div>
    );
  }

  if (normalizedQuestions.length === 0) {
    return (
      <div className="mt-3 rounded-xl border border-sand-300 bg-sand-50 p-3 text-xs text-sand-700">
        تعذر عرض أسئلة التوضيح. يمكنك كتابة تفاصيل طلبك في مربع الرسالة.
      </div>
    );
  }

  return (
    <section className="mt-3 rounded-2xl border border-sand-300 bg-sand-50 p-3.5 sm:p-4 shadow-2xs" aria-label="أسئلة استكشافية">
      <div className="mb-3 text-xs font-semibold text-ink-700">أسئلة استكشافية لتخصيص الخطة:</div>

      <div className="space-y-3">
        {normalizedQuestions.map((item, index) => {
          const selectedValue = answers[item.id]?.value;
          const selectedOptions = Array.isArray(selectedValue) ? selectedValue : selectedValue ? [selectedValue] : [];
          const isAnswered = Boolean(answers[item.id]);
          return (
            <div id={`discovery-${item.id}`} key={item.id} className="rounded-xl border border-sand-200 bg-white p-3" dir="rtl">
              <div className="mb-2 break-words text-sm font-semibold text-ink-900" dir="auto">
                {index + 1}. {item.text}
              </div>

              {item.options.length > 0 && (
                <div className="mt-2 flex flex-wrap items-start gap-2">
                  {item.options.map((option) => (
                    <button
                      key={option}
                      type="button"
                      disabled={disabled}
                      aria-pressed={selectedOptions.includes(option)}
                      onClick={() => chooseOption(item.id, option)}
                      className={`min-h-11 max-w-full rounded-lg border px-3 py-2 text-xs font-medium leading-5 whitespace-normal break-words transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:opacity-60 ${
                        selectedOptions.includes(option)
                          ? "border-primary bg-primary/10 text-ink-900"
                          : "border-sand-300 bg-sand-100 text-ink-800 hover:bg-sand-200"
                      }`}
                    >
                      {option}
                    </button>
                  ))}
                </div>
              )}

              {item.type === "free" && (
                <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                  <input
                    type="text"
                    maxLength={200}
                    dir="auto"
                    value={freeDraft[item.id] ?? (typeof selectedValue === "string" && !item.options.includes(selectedValue) ? selectedValue : "")}
                    onChange={(event) => setFreeDraft((current) => ({ ...current, [item.id]: event.target.value }))}
                    placeholder="اكتب إجابة قصيرة"
                    className="min-h-11 min-w-0 flex-1 rounded-lg border border-sand-300 px-3 text-sm text-ink-900 outline-none focus-visible:outline-2 focus-visible:outline-primary"
                  />
                  <button
                    type="button"
                    disabled={disabled || !sanitizeDiscoveryText(freeDraft[item.id], 200)}
                    onClick={() => submitFreeText(item.id)}
                    className="min-h-11 rounded-lg border border-sand-300 bg-white px-3 text-xs font-semibold text-ink-800 hover:bg-sand-100 focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-50"
                  >
                    اعتماد الإجابة
                  </button>
                </div>
              )}

              {item.allowOther && (
                <div className="mt-2">
                  <button
                    type="button"
                    disabled={disabled}
                    aria-expanded={Boolean(otherOpen[item.id])}
                    onClick={() => setOtherOpen((current) => ({ ...current, [item.id]: !current[item.id] }))}
                    className="min-h-11 rounded-lg border border-sand-300 bg-white px-3 text-xs font-semibold text-ink-800 hover:bg-sand-100 focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-60"
                  >
                    أخرى
                  </button>
                  {otherOpen[item.id] && (
                    <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                      <input
                        type="text"
                        maxLength={item.type === "multi" ? 40 : 120}
                        dir="auto"
                        value={otherDraft[item.id] ?? ""}
                        onChange={(event) => setOtherDraft((current) => ({ ...current, [item.id]: event.target.value }))}
                        placeholder="اكتب اختيارك"
                        className="min-h-11 min-w-0 flex-1 rounded-lg border border-sand-300 px-3 text-sm text-ink-900 outline-none focus-visible:outline-2 focus-visible:outline-primary"
                      />
                      <button
                        type="button"
                        disabled={disabled || !sanitizeDiscoveryText(otherDraft[item.id], item.type === "multi" ? 40 : 120)}
                        onClick={() => submitOther(item.id)}
                        className="min-h-11 rounded-lg bg-primary px-3 text-xs font-semibold text-white hover:bg-primary-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:opacity-50"
                      >
                        إضافة الإجابة
                      </button>
                    </div>
                  )}
                </div>
              )}

              <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs text-sand-600" aria-live="polite">
                  {isAnswered ? `الإجابة: ${answerLabel(answers[item.id])}` : "اختر إجابة أو استخدم الافتراضي"}
                </span>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => setAnswer(item.id, "", true)}
                  className="min-h-11 rounded-lg px-3 text-xs font-medium text-sand-700 underline decoration-sand-400 underline-offset-2 hover:bg-sand-100 focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-60"
                >
                  تخطّى واستخدم الافتراضي
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {allAnswered && (
        <div className="mt-3 rounded-xl border border-sand-200 bg-white p-3" aria-label="ملخص الطلب قبل الإرسال">
          <div className="mb-2 text-xs font-semibold text-ink-800">ملخص إجاباتك — اضغط على أي إجابة لتعديلها</div>
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
                        className="min-h-11 min-w-32 rounded-lg border border-primary px-3 text-xs outline-none focus-visible:outline-2 focus-visible:outline-primary"
                      />
                      <button type="button" onClick={() => submitSummaryEdit(question.id)} className="min-h-11 rounded-lg bg-sand-200 px-3 text-xs font-semibold text-ink-800 focus-visible:outline-2 focus-visible:outline-primary">حفظ</button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        setSummaryEditId(question.id);
                        setSummaryDraft(answer.skipped ? question.defaultOption ?? "" : Array.isArray(answer.value) ? answer.value.join("، ") : answer.value ?? "");
                      }}
                      className="min-h-11 max-w-full rounded-lg border border-sand-200 bg-sand-50 px-3 py-2 text-xs text-ink-800 hover:bg-sand-100 focus-visible:outline-2 focus-visible:outline-primary break-words"
                    >
                      <bdi>{fieldLabel}:</bdi> {answerLabel(answer)}
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
            className="mt-3 min-h-11 w-full rounded-xl bg-primary px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-primary-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:opacity-60"
          >
            تأكيد الإجابات وإرسالها
          </button>
        </div>
      )}
    </section>
  );
}
