"use client";

import { normalizeDiscoveryQuestions } from "./discoveryQuestions";

interface DiscoveryCardProps {
  questions: unknown;
  reason?: string;
  onSelectOption: (optionText: string) => void;
}

export default function DiscoveryCard({ questions, reason, onSelectOption }: DiscoveryCardProps) {
  const normalizedQuestions = normalizeDiscoveryQuestions(questions);

  return (
    <div className="mt-3 p-4 bg-sand-50 border border-sand-300 rounded-2xl shadow-2xs">
      <div className="flex items-center gap-2 mb-3">
        <span className="w-2 h-2 rounded-full bg-accent animate-pulse" />
        <span className="text-xs font-semibold text-ink-700">أسئلة استكشافية لتخصيص الخطة:</span>
      </div>

      {reason && (
        <p className="text-xs text-sand-600 mb-3 italic">
          {reason}
        </p>
      )}

      <div className="space-y-3.5">
        {normalizedQuestions.map((item, idx) => (
          <div key={idx} className="bg-white p-3 rounded-xl border border-sand-200">
            <div className="text-sm font-semibold text-ink-900 mb-2 break-words">
              {idx + 1}. {item.question}
            </div>

            {item.options && item.options.length > 0 && (
              <div className="flex flex-wrap items-start gap-1.5 mt-2">
                {item.options.map((opt, oIdx) => (
                  <button
                    key={oIdx}
                    type="button"
                    onClick={() => onSelectOption(opt)}
                    className="min-h-10 max-w-full px-3 py-1.5 text-xs leading-5 font-medium whitespace-normal break-words text-right bg-sand-100 hover:bg-sand-200 text-ink-800 rounded-lg border border-sand-300/80 transition-colors cursor-pointer active:scale-98"
                  >
                    {opt}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
