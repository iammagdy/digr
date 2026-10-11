"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useUser } from "@/hooks/useUser";
import { savePendingQuestion } from "@/lib/pendingQuestion";

const SUGGESTIONS = [
  "بيانات حساب @unicef على تيك توك مع الإحصائيات العامة",
  "منشورات حساب @who خلال آخر ٣ أشهر",
  "تعليقات عامة على فيديو حملة توعوية",
  "المنشورات العامة على وسم #الصحة_النفسية خلال آخر شهر",
];
const RECORD_TERMS = ["منشور عام", "تعليق عام", "تفاعل", "سجل بحث", "بيانات عامة", "مصدر مفتوح", "فترة زمنية", "رابط عام", "متاح للتحليل", "ملف CSV", "منهجية", "المتغيرات"];

function makeRecords(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    text: RECORD_TERMS[(index * 5) % RECORD_TERMS.length],
  }));
}

export function HeroLens() {
  const router = useRouter();
  const { user } = useUser();
  const [question, setQuestion] = useState("");
  const heroRef = useRef<HTMLElement>(null);
  const records = useMemo(() => makeRecords(144), []);

  useEffect(() => {
    const root = heroRef.current;
    if (!root) return;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduceMotion) return;

    let frame = 0;
    const startedAt = performance.now();
    const phase = Math.random() * Math.PI * 2;
    const animate = (now: number) => {
      const seconds = (now - startedAt) / 1000 + phase;
      const mobile = window.matchMedia("(max-width: 760px)").matches;
      const radiusX = mobile ? 22 : 34;
      const x = 50 + Math.cos(seconds * 0.22) * radiusX;
      const y = mobile ? 80 + Math.sin(seconds * 0.34) * 2 : 46 + Math.sin(seconds * 0.34) * 18;
      root.style.setProperty("--lens-x", `${x}%`);
      root.style.setProperty("--lens-y", `${y}%`);
      frame = window.requestAnimationFrame(animate);
    };
    frame = window.requestAnimationFrame(animate);
    return () => window.cancelAnimationFrame(frame);
  }, []);

  function submit(event: FormEvent) {
    event.preventDefault();
    const text = question.trim();
    if (!text) return;
    try { savePendingQuestion(window.sessionStorage, text); } catch { /* Storage may be blocked. */ }
    router.push(user ? "/dashboard/chat" : "/register");
  }

  return (
    <section ref={heroRef} className="hero-lens" aria-labelledby="hero-title">
      <div className="hero-lens__data" aria-hidden="true">
        <div className="hero-lens__records hero-lens__records--blur">
          {records.map((record, index) => <span key={index}>{record.text}</span>)}
        </div>
        <div className="hero-lens__records hero-lens__records--sharp">
          {records.map((record, index) => <span key={index}>{record.text}</span>)}
        </div>
        <div className="hero-lens__rings" />
        <div className="hero-lens__lens"><span /></div>
      </div>
      <div className="hero-lens__content">
        <p className="hero-lens__eyebrow">بيانات عامة · منظّمة · جاهزة للتحليل</p>
        <h1 id="hero-title" className="font-display">ماذا تريد أن تعرف؟</h1>
        <form onSubmit={submit} className="hero-lens__form" role="search">
          <label className="sr-only" htmlFor="hero-question">اسأل ديجر</label>
          <input
            id="hero-question"
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder="اسأل ديجر"
            autoComplete="off"
            maxLength={2000}
          />
          <button type="submit" disabled={!question.trim()} aria-label="ابدأ سؤالك">
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 12h14m-6-6 6 6-6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
        </form>
        <p className="hero-lens__examples-label">أو ابدأ بمثال</p>
        <div className="hero-lens__suggestions" aria-label="أمثلة للأسئلة">
          {SUGGESTIONS.map((suggestion) => (
            <button key={suggestion} type="button" onClick={() => setQuestion(suggestion)}>{suggestion}</button>
          ))}
        </div>
        <p className="hero-lens__disclaimer">لا يبدأ أي جمع قبل موافقتك — النقطة الواحدة = ٠٫١٠ ج.م</p>
      </div>
    </section>
  );
}
