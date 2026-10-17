"use client";

import { useEffect, useState } from "react";
import { PersonaType } from "@/functions/shared/personaConfigs";
import { Alert, Button, Input, Modal } from "@/components/ui";

interface OnboardingModalProps {
  isOpen: boolean;
  onComplete: (persona: PersonaType) => void;
  onSkip: () => void;
  jwtToken?: string;
  initialProfile?: { persona?: unknown; purposes?: unknown; topic?: unknown };
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
    desc: "منهجية أكاديمية رصينة، إبراز حدود العينة، إخفاء هوية الحسابات افتراضيًا ومعايير التكرار.",
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

const STEP_TITLES = ["من أنت؟", "ما الغرض من البيانات؟", "مجال تخصصك"];

export default function OnboardingModal({ isOpen, onComplete, onSkip, jwtToken, initialProfile }: OnboardingModalProps) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [selectedPersona, setSelectedPersona] = useState<PersonaType>("student");
  const [otherPersonaText, setOtherPersonaText] = useState("");
  const [selectedPurposes, setSelectedPurposes] = useState<string[]>(["رسالة أو بحث أكاديمي"]);
  const [topic, setTopic] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    const savedPersona = initialProfile?.persona;
    setSelectedPersona(PERSONA_OPTIONS.some((option) => option.key === savedPersona) ? savedPersona as PersonaType : "researcher");
    const savedPurposes = initialProfile?.purposes;
    setSelectedPurposes(Array.isArray(savedPurposes) && savedPurposes.every((item) => typeof item === "string") && savedPurposes.length ? savedPurposes as string[] : ["رسالة أو بحث أكاديمي"]);
    const savedTopic = typeof initialProfile?.topic === "string" ? initialProfile.topic : "";
    setTopic(savedTopic);
    setOtherPersonaText(savedTopic);
    setStep(1);
    setError(null);
  }, [isOpen, initialProfile]);

  function togglePurpose(p: string) {
    if (selectedPurposes.includes(p)) {
      if (selectedPurposes.length > 1) setSelectedPurposes(selectedPurposes.filter((item) => item !== p));
    } else {
      setSelectedPurposes([...selectedPurposes, p]);
    }
  }

  async function handleFinish() {
    setSubmitting(true);
    setError(null);
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (jwtToken) headers["Authorization"] = `Bearer ${jwtToken}`;
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
      if (!res.ok || !data.success) throw new Error(data.error || "تعذّر حفظ الإعدادات");
      onComplete(selectedPersona);
    } catch (err: any) {
      setError(err.message || "حدث خطأ غير متوقع");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal open={isOpen} onClose={onSkip} title="تخصيص تجربة المساعد" wide>
      {/* Step progress */}
      <div className="mb-6">
        <div className="mb-2 flex items-center justify-between text-xs">
          <span className="font-semibold text-sand-600">الخطوة {step} من 3 — {STEP_TITLES[step - 1]}</span>
          <button type="button" onClick={onSkip} className="cursor-pointer font-semibold text-sand-500 underline underline-offset-2 hover:text-ink-900">
            تخطي الآن
          </button>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-sand-200" role="progressbar" aria-valuenow={step} aria-valuemin={1} aria-valuemax={3} aria-label="تقدم التخصيص">
          <div className="h-full rounded-full bg-gold transition-[width] duration-300 motion-reduce:transition-none" style={{ width: `${(step / 3) * 100}%` }} />
        </div>
      </div>

      {error && (
        <div className="mb-4"><Alert tone="danger">{error}</Alert></div>
      )}

      {step === 1 && (
        <div className="animate-fade">
          <h3 className="font-display text-xl text-ink-900">من أنت؟</h3>
          <p className="mt-1 mb-5 text-sm text-sand-600">يساعدنا هذا في تخصيص لغة المساعد وعمق الشرح وتنسيق ملفات المنهجية.</p>
          <div className="space-y-2.5" role="radiogroup" aria-label="اختر شخصيتك البحثية">
            {PERSONA_OPTIONS.map((opt) => {
              const selected = selectedPersona === opt.key;
              return (
                <label
                  key={opt.key}
                  className={`block cursor-pointer rounded-[20px] border p-4 transition-all ${selected ? "border-gold bg-sf2 ring-1 ring-gold/40" : "border-sand-200 bg-sf hover:border-sand-400"}`}
                >
                  <span className="flex items-start gap-3">
                    <input
                      type="radio"
                      name="persona"
                      value={opt.key}
                      checked={selected}
                      onChange={() => setSelectedPersona(opt.key)}
                      className="mt-1 h-4 w-4 accent-[var(--gold)]"
                    />
                    <span>
                      <span className="block text-sm font-bold text-ink-900 sm:text-base">{opt.title}</span>
                      <span className="mt-0.5 block text-xs leading-relaxed text-sand-600 sm:text-sm">{opt.desc}</span>
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
          {selectedPersona === "other" && (
            <Input
              type="text"
              maxLength={256}
              placeholder="وضّح طبيعة دورك أو مجالك..."
              value={otherPersonaText}
              onChange={(e) => setOtherPersonaText(e.target.value)}
              className="mt-3"
              aria-label="توضيح الدور"
            />
          )}
        </div>
      )}

      {step === 2 && (
        <div className="animate-fade">
          <h3 className="font-display text-xl text-ink-900">ما الغرض من البيانات؟</h3>
          <p className="mt-1 mb-5 text-sm text-sand-600">يمكنك اختيار أكثر من غرض — سنقترح الحقول وطرق الفلترة المناسبة.</p>
          <div className="space-y-2.5">
            {PURPOSE_OPTIONS.map((purp) => {
              const checked = selectedPurposes.includes(purp);
              return (
                <label
                  key={purp}
                  className={`flex cursor-pointer items-center gap-3 rounded-[20px] border p-3.5 transition-all ${checked ? "border-gold bg-sf2 ring-1 ring-gold/40" : "border-sand-200 bg-sf hover:border-sand-400"}`}
                >
                  <input type="checkbox" checked={checked} onChange={() => togglePurpose(purp)} className="h-4 w-4 rounded accent-[var(--gold)]" />
                  <span className="text-sm font-semibold text-ink-900">{purp}</span>
                </label>
              );
            })}
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="animate-fade">
          <h3 className="font-display text-xl text-ink-900">مجال تخصصك</h3>
          <p className="mt-1 mb-5 text-sm text-sand-600">اختياري — يتيح للمساعد اقتراح مصطلحات بحثية ومصادر ملائمة.</p>
          <Input
            type="text"
            maxLength={256}
            placeholder="مثال: علم الاجتماع الرقمي، الصحة العامة، التجارة الإلكترونية..."
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            aria-label="الموضوع أو المجال"
          />
          <p className="mt-2 text-xs text-sand-500">يمكنك تعديل هذه البيانات لاحقًا من إعدادات حسابك.</p>
        </div>
      )}

      <div className="mt-7 flex items-center justify-between border-t border-sand-200 pt-5">
        {step > 1 ? (
          <Button variant="ghost" onClick={() => setStep((s) => (s - 1) as 1 | 2 | 3)}>السابق</Button>
        ) : <span />}
        {step < 3 ? (
          <Button variant="accent" onClick={() => setStep((s) => (s + 1) as 1 | 2 | 3)}>التالي</Button>
        ) : (
          <Button variant="accent" onClick={handleFinish} disabled={submitting}>
            {submitting ? "جاري الحفظ..." : "حفظ ومتابعة"}
          </Button>
        )}
      </div>
    </Modal>
  );
}
