"use client";

interface DiscoveryQuestion {
  question: string;
  options?: string[];
}

interface DiscoveryCardProps {
  questions: DiscoveryQuestion[] | string[];
  reason?: string;
  onSelectOption: (optionText: string) => void;
}

export default function DiscoveryCard({ questions, reason, onSelectOption }: DiscoveryCardProps) {
  const normalizedQuestions: DiscoveryQuestion[] = questions.map((q) => {
    if (typeof q === "string") {
      return { question: q, options: [] };
    }
    return q;
  });

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
            <div className="text-sm font-semibold text-ink-900 mb-2">
              {idx + 1}. {item.question}
            </div>

            {item.options && item.options.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-2">
                {item.options.map((opt, oIdx) => (
                  <button
                    key={oIdx}
                    type="button"
                    onClick={() => onSelectOption(opt)}
                    className="px-3 py-1.5 text-xs font-medium bg-sand-100 hover:bg-sand-200 text-ink-800 rounded-lg border border-sand-300/80 transition-colors cursor-pointer active:scale-98"
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
