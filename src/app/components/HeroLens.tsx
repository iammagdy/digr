"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent, type PointerEvent } from "react";
import { useRouter } from "next/navigation";
import { useUser } from "@/hooks/useUser";
import { savePendingQuestion } from "@/lib/pendingQuestion";

const SUGGESTIONS = [
  "بيانات حساب @unicef على تيك توك مع الإحصائيات العامة",
  "منشورات حساب @who خلال آخر ٣ أشهر",
  "تعليقات عامة على فيديو حملة توعوية",
  "المنشورات العامة على وسم #الصحة_النفسية خلال آخر شهر",
];
const RECORD_TEXT = [
  "تفاعل  ·  منشور عام  ·  2025",
  "مشاركة  ·  نقاش مجتمعي  ·  مصدر مفتوح",
  "تعليق  ·  موضوع بحثي  ·  بيانات عامة",
  "منشور  ·  تفاعل الجمهور  ·  توثيق",
  "استجابة  ·  فترة زمنية  ·  متاح للتحليل",
];

function makeRecords(count: number) {
  let seed = 20261011;
  const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  return Array.from({ length: count }, (_, index) => ({
    text: `${RECORD_TEXT[index % RECORD_TEXT.length]} · سجل ${index + 1}`,
    x: Math.floor(random() * 100),
    y: Math.floor(random() * 100),
    opacity: 0.25 + random() * 0.6,
    rotate: `${Math.floor(random() * 5) - 2}deg`,
  }));
}

export function HeroLens() {
  const router = useRouter();
  const { user } = useUser();
  const [question, setQuestion] = useState("");
  const heroRef = useRef<HTMLElement>(null);
  const records = useMemo(() => makeRecords(190), []);
  const recordRefs = useRef<Array<HTMLSpanElement | null>>([]);
  const pointer = useRef({ x: 0, y: 0, active: false });
  const recordOffsets = useRef(records.map(() => ({ x: 0, y: 0 })));

  useEffect(() => {
    const root = heroRef.current;
    if (!root) return;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const lowPower = (navigator.hardwareConcurrency || 8) <= 4 ||
      ((navigator as Navigator & { deviceMemory?: number }).deviceMemory || 8) <= 4;
    root.dataset.lite = String(lowPower);
    if (reduceMotion) return;

    let frame = 0;
    let frameCount = 0;
    const startedAt = performance.now();
    const phase = Math.random() * Math.PI * 2;
    const animate = (now: number) => {
      const seconds = (now - startedAt) / 1000 + phase;
      const mobile = window.matchMedia("(max-width: 760px)").matches;
      const radiusX = mobile ? 22 : 34;
      const radiusY = mobile ? 12 : 18;
      const x = 50 + Math.cos(seconds * 0.22) * radiusX;
      const y = 46 + Math.sin(seconds * 0.34) * radiusY;
      root.style.setProperty("--lens-x", `${x}%`);
      root.style.setProperty("--lens-y", `${y}%`);
      frameCount += 1;
      if (!lowPower && !mobile && frameCount % 2 === 0) {
        const width = root.clientWidth;
        const height = root.clientHeight;
        for (let index = 0; index < records.length; index += 1) {
          const node = recordRefs.current[index];
          const old = recordOffsets.current[index];
          if (!node || (!pointer.current.active && old.x === 0 && old.y === 0)) continue;
          const dx = (records[index].x / 100) * width - pointer.current.x;
          const dy = (records[index].y / 100) * height - pointer.current.y;
          const distance = Math.hypot(dx, dy);
          const radius = 120;
          const strength = pointer.current.active && distance < radius ? 30 * (1 - distance / radius) : 0;
          const nextX = distance > 0 ? (dx / distance) * strength : 0;
          const nextY = distance > 0 ? (dy / distance) * strength : 0;
          if (Math.abs(nextX - old.x) > 0.5 || Math.abs(nextY - old.y) > 0.5) {
            node.style.transform = `translate(${nextX.toFixed(1)}px, ${nextY.toFixed(1)}px)`;
            old.x = nextX;
            old.y = nextY;
          }
        }
      }
      frame = window.requestAnimationFrame(animate);
    };
    frame = window.requestAnimationFrame(animate);
    return () => window.cancelAnimationFrame(frame);
  }, [records]);

  function moveLensField(event: PointerEvent<HTMLElement>) {
    const root = heroRef.current;
    if (!root) return;
    if ((event.target as Element).closest(".hero-lens__content")) {
      pointer.current.active = false;
      return;
    }
    const rect = root.getBoundingClientRect();
    pointer.current.x = event.clientX - rect.left;
    pointer.current.y = event.clientY - rect.top;
    pointer.current.active = true;
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const text = question.trim();
    if (!text) return;
    try { savePendingQuestion(window.sessionStorage, text); } catch { /* Storage may be blocked. */ }
    router.push(user ? "/dashboard/chat" : "/register");
  }

  return (
    <section ref={heroRef} className="hero-lens" aria-labelledby="hero-title" onPointerMove={moveLensField} onPointerLeave={() => { pointer.current.active = false; }}>
      <div className="hero-lens__data" aria-hidden="true">
        <div className="hero-lens__records hero-lens__records--blur">
          {records.map((record, index) => <span key={index} style={{ left: `${record.x}%`, top: `${record.y}%`, opacity: record.opacity, rotate: record.rotate }}>{record.text}</span>)}
        </div>
        <div className="hero-lens__records hero-lens__records--sharp">
          {records.map((record, index) => <span key={index} ref={(node) => { recordRefs.current[index] = node; }} style={{ left: `${record.x}%`, top: `${record.y}%`, opacity: record.opacity, rotate: record.rotate }}>{record.text}</span>)}
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
