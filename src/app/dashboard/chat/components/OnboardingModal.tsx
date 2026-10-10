"use client";

import { useState } from "react";
import { PersonaType, PERSONA_CONFIGS } from "@/functions/shared/personaConfigs";

interface OnboardingModalProps {
  isOpen: boolean;
  onComplete: (persona: PersonaType) => void;
  onSkip: () => void;
  jwtToken?: string;
}

const PERSONA_OPTIONS: Array<{ key: PersonaType; title: string; desc: string }> = [
  {
    key: "student",
    title: "طالب جامعي / دراسات عليا",
    desc: "صياغة مبسطة، إرشادات واضحة للخطوات، أحجام بيانات معتدلة لمشاريع التخرج والماجستير.",
  },
  {
    key: "researcher",
    title: "باحث أو أستاذ جامعي",
    desc: "منهجية أكاديمية رصينة، إبراز حدود العينة، إخفاء هوية الحسابات افتراضياً ومعايير التكرار.",
  },
  {
    key: "statistician",
    title: "إحصائي / محلل بيانات",
    desc: "بنية Tidy Data القياسية، دليل بيانات صارم للمتغيرات، وتركيز رقمي دقيق دون نصوص إنشائية.",
  },
  {
    key: "marketer",
    title: "مسوّق أو صانع محتوى",
    desc: "مؤشرات تفاعل ووصول مباشرة، مقارنة المنافسين، ملخص تنفيذي موجز، وتجنب التعقيد.",
  },
  {
    key: "other",
    title: "أخرى / استكشاف عام",
    desc: "أسئلة استكشافية مرنة لتحديد متطلباتك بدقة واقتراح الخطة الأنسب.",
  },
];

const PURPOSE_OPTIONS = [
  "رسالة أو بحث أكاديمي",
  "نشر علمي في مجلة محكمة",
  "تحليل السوق والمنافسين",
  "صناعة محتوى ورصد اتجاهات الرأي العام",
  "تحليل إحصائي ونمذجة كمية",
  "أخرى",
];

export default function OnboardingModal({ isOpen, onComplete, onSkip, jwtToken }: OnboardingModalProps) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [selectedPersona, setSelectedPersona] = useState<PersonaType>("student");
  const [otherPersonaText, setOtherPersonaText] = useState("");
  const [selectedPurposes, setSelectedPurposes] = useState<string[]>(["رسالة أو بحث أكاديمي"]);
  const [topic, setTopic] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  function togglePurpose(p: string) {
    if (selectedPurposes.includes(p)) {
      if (selectedPurposes.length > 1) {
        setSelectedPurposes(selectedPurposes.filter((item) => item !== p));
      }
    } else {
      setSelectedPurposes([...selectedPurposes, p]);
    }
  }

  async function handleFinish() {
    setSubmitting(true);
    setError(null);
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (jwtToken) {
        headers["Authorization"] = `Bearer ${jwtToken}`;
      }

      const res = await fetch("/api/onboarding", {
        method: "POST",
        headers,
        body: JSON.stringify({
          persona: selectedPersona,
          purposes: selectedPurposes,
          topic: selectedPersona === "other" && otherPersonaText.trim() ? otherPersonaText : topic,
        }),
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || "تعذر حفظ الإعدادات");
      }

      onComplete(selectedPersona);
    } catch (err: any) {
      setError(err.message || "حدث خطأ غير متوقع");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-ink-900/60 backdrop-blur-xs">
      <div className="relative w-full max-w-xl bg-white border border-sand-300 rounded-2xl shadow-xl overflow-hidden animate-in fade-in zoom-in-95 duration-200">
        {/* Step Indicator Header */}
        <div className="p-6 border-b border-sand-200 bg-sand-50">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs font-semibold text-sand-600 tracking-wider">
              تهيئة تجربة المساعد الذكي • الخطوة {step} من 3
            </span>
            <button
              onClick={onSkip}
              className="text-xs text-sand-500 hover:text-ink-900 underline underline-offset-2 transition-colors cursor-pointer"
            >
              تخطي الآن
            </button>
          </div>
          <div className="w-full bg-sand-200 h-1.5 rounded-full overflow-hidden">
            <div
              className="bg-primary h-full transition-all duration-300 ease-out"
              style={{ width: `${(step / 3) * 100}%` }}
            />
          </div>
        </div>

        {/* Modal Body */}
        <div className="p-6 sm:p-8">
          {error && (
            <div className="mb-4 p-3 bg-danger-bg text-danger text-sm rounded-lg border border-danger/20">
              {error}
            </div>
          )}

          {step === 1 && (
            <div>
              <h2 className="text-xl font-bold text-ink-900 mb-1">إنت مين؟</h2>
              <p className="text-sm text-sand-600 mb-6">
                يساعدنا هذا في تخصيص لغة المساعد، عمق الشرح، وتنسيق ملفات المنهجية لتناسبك تماماً.
              </p>
              <div className="space-y-3">
                {PERSONA_OPTIONS.map((opt) => (
                  <label
                    key={opt.key}
                    className={`block p-4 rounded-xl border cursor-pointer transition-all ${
                      selectedPersona === opt.key
                        ? "border-primary bg-sand-50/80 shadow-xs ring-1 ring-primary/20"
                        : "border-sand-200 hover:border-sand-400 bg-white"
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      <input
                        type="radio"
                        name="persona"
                        value={opt.key}
                        checked={selectedPersona === opt.key}
                        onChange={() => setSelectedPersona(opt.key)}
                        className="mt-1 text-primary focus:ring-primary h-4 w-4"
                      />
                      <div>
                        <div className="font-semibold text-ink-900 text-sm sm:text-base">
                          {opt.title}
                        </div>
                        <div className="text-xs sm:text-sm text-sand-600 mt-0.5">
                          {opt.desc}
                        </div>
                      </div>
                    </div>
                  </label>
                ))}

                {selectedPersona === "other" && (
                  <input
                    type="text"
                    placeholder="وضح طبيعة دورك أو مجالك..."
                    value={otherPersonaText}
                    onChange={(e) => setOtherPersonaText(e.target.value)}
                    className="w-full mt-2 p-3 text-sm border border-sand-300 rounded-xl focus:border-primary focus:ring-1 focus:ring-primary outline-hidden"
                  />
                )}
              </div>
            </div>
          )}

          {step === 2 && (
            <div>
              <h2 className="text-xl font-bold text-ink-900 mb-1">ما هو الغرض من استخدام البيانات؟</h2>
              <p className="text-sm text-sand-600 mb-6">
                يمكنك اختيار أكثر من غرض. سنقترح عليك الحقول وطرق الفلترة المناسبة لكل غرض.
              </p>
              <div className="space-y-2.5">
                {PURPOSE_OPTIONS.map((purp) => {
                  const isChecked = selectedPurposes.includes(purp);
                  return (
                    <label
                      key={purp}
                      onClick={() => togglePurpose(purp)}
                      className={`flex items-center gap-3 p-3.5 rounded-xl border cursor-pointer transition-all ${
                        isChecked
                          ? "border-primary bg-sand-50/80 ring-1 ring-primary/20"
                          : "border-sand-200 hover:border-sand-400 bg-white"
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => {}}
                        className="text-primary rounded-xs focus:ring-primary h-4 w-4"
                      />
                      <span className="text-sm font-medium text-ink-900">{purp}</span>
                    </label>
                  );
                })}
              </div>
            </div>
          )}

          {step === 3 && (
            <div>
              <h2 className="text-xl font-bold text-ink-900 mb-1">مجال التخصص أو موضوع البحث</h2>
              <p className="text-sm text-sand-600 mb-6">
                اختياري. يتيح للمساعد اقتراح مصطلحات بحثية وكلمات مفتاحية متخصصة ومصادر ملائمة.
              </p>
              <div>
                <label className="block text-xs font-semibold text-sand-600 uppercase tracking-wider mb-2">
                  الموضوع أو المجال العلمي / التسويقي (اختياري)
                </label>
                <input
                  type="text"
                  placeholder="مثال: علم الاجتماع الرقمي، الصحة العامة، التجارة الإلكترونية، الرياضة..."
                  value={topic}
                  onChange={(e) => setTopic(e.target.value)}
                  className="w-full p-3.5 text-sm border border-sand-300 rounded-xl focus:border-primary focus:ring-1 focus:ring-primary outline-hidden"
                />
                <p className="text-xs text-sand-500 mt-2">
                  يمكنك دائماً تعديل هذه البيانات في أي وقت من إعدادات حسابك.
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div className="p-6 border-t border-sand-200 bg-sand-50 flex items-center justify-between">
          {step > 1 ? (
            <button
              type="button"
              onClick={() => setStep((s) => (s - 1) as any)}
              className="px-4 py-2 text-sm font-medium text-sand-700 hover:text-ink-900 transition-colors cursor-pointer"
            >
              السابق
            </button>
          ) : (
            <div />
          )}

          {step < 3 ? (
            <button
              type="button"
              onClick={() => setStep((s) => (s + 1) as any)}
              className="px-6 py-2.5 bg-primary hover:bg-primary-hover text-white text-sm font-semibold rounded-xl shadow-xs transition-colors cursor-pointer"
            >
              التالي
            </button>
          ) : (
            <button
              type="button"
              onClick={handleFinish}
              disabled={submitting}
              className="px-6 py-2.5 bg-primary hover:bg-primary-hover text-white text-sm font-semibold rounded-xl shadow-xs transition-colors cursor-pointer disabled:opacity-50"
            >
              {submitting ? "جاري الحفظ..." : "حفظ ومتابعة"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
