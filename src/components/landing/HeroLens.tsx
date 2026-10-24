"use client";

import { memo, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useUser } from "@/hooks/useUser";
import { savePendingQuestion } from "@/lib/pendingQuestion";
import { CHIP_ICONS, DEFAULT_Q, EXAMPLES, FIELD_ITEMS, PROMPTS } from "./data";
import { MISSION_TEMPLATES } from "@/lib/missionTemplates";

const FIELD_STYLE: React.CSSProperties = {
  position: "absolute", inset: 0, padding: 12, fontSize: 13, lineHeight: 2.2, display: "flex", flexWrap: "wrap",
  alignContent: "flex-start", columnGap: 22, userSelect: "none", overflow: "hidden",
};

/* Memoised: typing in the ask field must never re-render the ~190 records. */
const RecordField = memo(function RecordField({ items, variant }: { items: string[]; variant: "dim" | "hi" }) {
  if (variant === "dim") {
    return (
      <div
        data-field="dim"
        style={{ ...FIELD_STYLE, color: "transparent", textShadow: "0 0 2.5px var(--ink),4px 1px 2.5px var(--ink),-3px 0 2.5px var(--ink)" }}
      >
        {items.map((w, i) => (
          <span key={i} style={{ display: "inline-block", whiteSpace: "nowrap", opacity: 0.12, willChange: "transform" }}>{w}</span>
        ))}
      </div>
    );
  }
  return (
    <div
      data-lens-inner="1"
      data-field="hi"
      style={{ ...FIELD_STYLE, inset: "auto", left: 0, top: 0, width: 100, height: 100, color: "var(--ink)", transformOrigin: "0 0", willChange: "transform" }}
    >
      {items.map((w, i) => (
        <span key={i} style={{ display: "inline-block", whiteSpace: "nowrap", opacity: 0.74 }}>{w}</span>
      ))}
    </div>
  );
});

function useIsMobile(bp = 760) {
  const [m, setM] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${bp - 1}px)`);
    const on = () => setM(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [bp]);
  return m;
}

export function HeroLens() {
  const router = useRouter();
  const { user } = useUser();
  const mobile = useIsMobile();
  const [hasText, setHasText] = useState(false);
  const [picked, setPicked] = useState<number | null>(null);
  const [ideasOpen, setIdeasOpen] = useState(false);

  const heroRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const mobileRef = useRef(false);
  const mouse = useRef({ x: 0, y: 0, on: false });
  const tap = useRef<{ x: number; y: number; t: number } | null>(null);
  const shield = useRef(false);
  mobileRef.current = mobile;

  const items = mobile ? FIELD_ITEMS.slice(0, 80) : FIELD_ITEMS.slice(0, 190);

  /* ── single rAF loop: lens, parallax, magnet. CSS transforms only, no setState. ── */
  useEffect(() => {
    const hero = heroRef.current;
    if (!hero) return;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const nav = navigator as Navigator & { deviceMemory?: number };
    const lite = reduced || (nav.hardwareConcurrency || 8) <= 4 || (nav.deviceMemory || 8) <= 4;

    const L = { x: 0.78, y: 0.29, tx: 0.78, ty: 0.29, px: 0, py: 0, fx: 0, fy: 0 };
    let geo: { W: number; H: number; cy: number; ry: number; n: number } | null = null;
    let els: null | { back: HTMLElement; win: HTMLElement; inner: HTMLElement; ring: HTMLElement; rings: HTMLElement; shield: HTMLElement; W: number; H: number; D: number } = null;
    let fw: null | { w: number; dims: HTMLElement[]; cx: number[]; cy: number[]; ox: number[]; oy: number[]; moved: boolean[] } = null;
    let raf = 0;
    let frame = 0;

    const heroEls = () => {
      if (els && els.win.isConnected) {
        if (els.W !== hero.clientWidth || els.H !== hero.clientHeight) {
          els.W = hero.clientWidth; els.H = hero.clientHeight;
          els.inner.style.width = els.W + "px"; els.inner.style.height = els.H + "px";
          els.D = els.win.offsetWidth;
        }
        return els;
      }
      const q = <T extends HTMLElement>(s: string) => hero.querySelector<T>(s);
      const back = q("[data-px-back]"), win = q("[data-lens-win]"), inner = q("[data-lens-inner]"), ring = q("[data-lens-ring]"), rings = q("[data-px-rings]"), sh = q("[data-lens-shield]");
      if (!back || !win || !inner || !ring || !rings || !sh) return null;
      els = { back, win, inner, ring, rings, shield: sh, W: hero.clientWidth, H: hero.clientHeight, D: win.offsetWidth };
      inner.style.width = els.W + "px"; inner.style.height = els.H + "px";
      return els;
    };

    /* The lens orbits the area above the input, around the headline. */
    const lensGeo = () => {
      const W = hero.clientWidth, H = hero.clientHeight;
      if (geo && geo.W === W && geo.H === H && geo.n++ < 60) return geo;
      const h1 = hero.querySelector("h1"), form = hero.querySelector("form");
      let cy = 0.25, ry = 0.06;
      if (h1 && form && H) {
        const hr = hero.getBoundingClientRect(), r1 = h1.getBoundingClientRect(), rf = form.getBoundingClientRect();
        const lensR = (mobileRef.current ? 112 : 170) / 2;
        const hTop = r1.top - hr.top, hBot = r1.bottom - hr.top, fTop = rf.top - hr.top;
        const cpx = Math.max(lensR * 0.6, (hTop + hBot) / 2 - 8);
        const maxDown = fTop - lensR * 0.35 - cpx;
        const rpx = Math.max(8, Math.min((hBot - hTop) * 0.55 + 20, maxDown / 1.26));
        cy = cpx / H; ry = rpx / H;
      }
      geo = { W, H, cy, ry, n: 0 };
      return geo;
    };

    const repel = (tm: number) => {
      if (lite) return;
      if (!fw || !fw.dims[0] || !fw.dims[0].isConnected || Math.abs(fw.w - hero.clientWidth) > 2) {
        const dims = Array.from(hero.querySelectorAll<HTMLElement>('[data-field="dim"] > span'));
        if (!dims.length) return;
        fw = {
          w: hero.clientWidth, dims,
          cx: dims.map((s) => s.offsetLeft + s.offsetWidth / 2), cy: dims.map((s) => s.offsetTop + s.offsetHeight / 2),
          ox: dims.map(() => 0), oy: dims.map(() => 0), moved: dims.map(() => false),
        };
      }
      const W = hero.clientWidth, Hh = hero.clientHeight;
      const src: Array<[number, number, number, number]> = [];
      if (mouse.current.on && !mobileRef.current) src.push([mouse.current.x, mouse.current.y, 130, 30]);
      if (mobileRef.current) {
        const k = (tm / 1000) * 0.21;
        src.push([(0.5 + Math.cos(k * 0.8 + 2.1) * 0.42) * W, (0.5 + Math.sin(k * 1.1 + 0.4) * 0.44) * Hh, 92, 24]);
        const t = tap.current;
        if (t) {
          const age = (tm - t.t) / 1000;
          if (age < 1.1) src.push([t.x, t.y, 50 + age * 220, 30 * (1 - age / 1.1)]);
          else tap.current = null;
        }
      }
      const F = fw;
      for (let i = 0; i < F.dims.length; i++) {
        let tx = 0, ty = 0;
        for (const [sx, sy, R, P] of src) {
          const dx = F.cx[i] - sx, dy = F.cy[i] - sy, d = Math.hypot(dx, dy);
          if (d < R && d > 0.01) { const f = Math.pow(1 - d / R, 2) * P; tx += (dx / d) * f; ty += (dy / d) * f; }
        }
        const ox = F.ox[i] + (tx - F.ox[i]) * 0.24, oy = F.oy[i] + (ty - F.oy[i]) * 0.24;
        if (Math.abs(ox - F.ox[i]) + Math.abs(oy - F.oy[i]) < 0.01 && Math.abs(ox) + Math.abs(oy) < 0.05 && !F.moved[i]) continue;
        F.ox[i] = ox; F.oy[i] = oy;
        const mag = Math.hypot(ox, oy), still = mag < 0.05;
        const el = F.dims[i];
        el.style.transform = still ? "" : `translate(${ox.toFixed(2)}px,${oy.toFixed(2)}px) rotate(${(ox * 0.12).toFixed(2)}deg)`;
        el.style.opacity = (0.12 + Math.min(1, mag / 30) * 0.3).toFixed(3);
        F.moved[i] = !still;
      }
    };

    const loop = (tm: number) => {
      raf = requestAnimationFrame(loop);
      if (document.hidden) return;
      const E = heroEls();
      if (!E) return;
      if (reduced) { L.tx = 0.78; L.ty = 0.3; }
      else {
        const mb = mobileRef.current;
        const k = (tm / 1000) * (mb ? 0.36 : 0.2);
        const G = lensGeo();
        const RX = mb ? 0.17 : 0.3, RY = G.ry, CY = G.cy;
        const wob = 1 + Math.sin(k * 0.63) * 0.14 + Math.sin(k * 1.7 + 1) * 0.06;
        L.tx = 0.5 + Math.cos(k) * RX * wob + Math.sin(k * 0.41 + 2) * RX * 0.08;
        L.ty = CY + Math.sin(k) * RY * wob + Math.sin(k * 2.3) * RY * 0.18;
      }
      L.x += (L.tx - L.x) * 0.045; L.y += (L.ty - L.y) * 0.045;
      L.px += ((L.x - 0.5) * 2 - L.px) * 0.08; L.py += ((L.y - 0.5) * 2 - L.py) * 0.08;
      const frozen = mobileRef.current || shield.current || E.shield.contains(document.activeElement);
      L.fx += ((frozen ? 0 : L.px) - L.fx) * 0.12; L.fy += ((frozen ? 0 : L.py) - L.fy) * 0.12;
      const bx = L.px * -22, by = L.py * -16;
      E.back.style.transform = `translate3d(${bx.toFixed(1)}px,${by.toFixed(1)}px,0)`;
      E.rings.style.transform = `translate3d(${(L.px * -9).toFixed(1)}px,${(L.py * -7).toFixed(1)}px,0)`;
      E.shield.style.transform = Math.abs(L.fx) + Math.abs(L.fy) < 0.002 ? "" :
        `translate3d(${(L.fx * 5).toFixed(2)}px,${(L.fy * 4).toFixed(2)}px,0) rotateY(${(L.fx * -1.5).toFixed(2)}deg) rotateX(${(L.fy * 1.5).toFixed(2)}deg)`;
      const X = L.x * E.W, Y = L.y * E.H, D = E.D, S = 1.08;
      const p = `translate3d(${(X - D / 2).toFixed(1)}px,${(Y - D / 2).toFixed(1)}px,0)`;
      E.win.style.transform = p; E.ring.style.transform = p;
      E.inner.style.transform = `translate3d(${(D / 2 - (X - bx) * S).toFixed(1)}px,${(D / 2 - (Y - by) * S).toFixed(1)}px,0) scale(${S})`;
      if ((frame++ & 1) === 0) repel(tm); // magnet runs every other frame
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  const onMove = useCallback((e: React.PointerEvent<HTMLElement>) => {
    if (mobileRef.current || e.pointerType !== "mouse") return;
    shield.current = !!(e.target as HTMLElement).closest?.("[data-lens-shield]");
    const r = e.currentTarget.getBoundingClientRect();
    mouse.current = { x: e.clientX - r.left, y: e.clientY - r.top, on: true };
  }, []);
  const onDown = useCallback((e: React.PointerEvent<HTMLElement>) => {
    if (e.pointerType === "mouse") return;
    const r = e.currentTarget.getBoundingClientRect();
    tap.current = { x: e.clientX - r.left, y: e.clientY - r.top, t: performance.now() };
  }, []);
  const onLeave = useCallback(() => {
    shield.current = false;
    mouse.current = { x: 0, y: 0, on: false };
  }, []);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const q = (inputRef.current?.value || "").trim() || DEFAULT_Q;
    savePendingQuestion(q);
    router.push(user ? "/dashboard/chat" : "/register");
  };

  /** A mission template only fills the input; the visitor edits it and sends it (to sign-up). */
  const useTemplate = (prompt: string) => {
    const el = inputRef.current;
    if (!el) return;
    el.value = prompt;
    setHasText(true);
    setPicked(null);
    el.focus();
    try { el.setSelectionRange(el.value.length, el.value.length); } catch { /* not supported */ }
  };

  const useExample = (i: number) => {
    const el = inputRef.current;
    if (!el) return;
    el.value = PROMPTS[i];
    setHasText(true);
    setPicked(i);
    el.focus();
    try { el.setSelectionRange(el.value.length, el.value.length); } catch { /* not supported */ }
  };

  return (
    <section
      ref={heroRef}
      onPointerMove={onMove}
      onPointerLeave={onLeave}
      onPointerDown={onDown}
      className="relative flex min-h-[max(640px,calc(100dvh-64px))] flex-col items-center justify-center overflow-hidden px-5 pb-20 pt-[110px] min-[760px]:min-h-screen"
      style={{ perspective: 1400 }}
    >
      {/* back layer: blurred records */}
      <div
        data-px-back="1"
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 will-change-transform"
        style={{ WebkitMaskImage: "radial-gradient(ellipse 85% 80% at 50% 50%,#000 45%,transparent 100%)", maskImage: "radial-gradient(ellipse 85% 80% at 50% 50%,#000 45%,transparent 100%)" }}
      >
        <RecordField items={items} variant="dim" />
      </div>

      {/* the lens: sharp copy of the field, masked to a circle */}
      <div
        data-lens-win="1"
        aria-hidden="true"
        className="pointer-events-none absolute left-0 top-0 overflow-hidden rounded-full bg-bg will-change-transform"
        style={{ width: mobile ? 112 : 170, height: mobile ? 112 : 170, transform: "translate3d(-9999px,0,0)", contain: "strict" }}
      >
        <RecordField items={items} variant="hi" />
      </div>
      <div
        data-lens-ring="1"
        aria-hidden="true"
        className="pointer-events-none absolute left-0 top-0 rounded-full will-change-transform"
        style={{
          width: mobile ? 112 : 170, height: mobile ? 112 : 170, transform: "translate3d(-9999px,0,0)",
          border: "1.5px solid var(--gold)", background: "radial-gradient(circle at 32% 28%,rgba(255,255,255,.22),transparent 55%)",
          boxShadow: "0 0 0 10px rgba(200,150,62,.07),0 40px 70px -24px rgba(0,0,0,.3)",
        }}
      >
        <span style={{ position: "absolute", left: "14.6%", top: "85.4%", width: "30%", height: 5, marginTop: -2.5, borderRadius: 9, background: "var(--gold)", transformOrigin: "left center", transform: "rotate(135deg)" }} />
      </div>

      {/* middle layer: breathing rings */}
      <div
        aria-hidden="true"
        data-px-rings="1"
        className="pointer-events-none absolute will-change-transform"
        style={{ left: "50%", top: "50%", width: "min(1000px,160cqi)", aspectRatio: "1", margin: "calc(min(1000px,160cqi) / -2) 0 0 calc(min(1000px,160cqi) / -2)" }}
      >
        <span className="absolute inset-0 rounded-full border border-ln2" style={{ animation: "ring 9s linear infinite" }} />
        <span className="absolute inset-0 rounded-full border border-ln2" style={{ animation: "ring 9s 3s linear infinite" }} />
        <span className="absolute inset-0 rounded-full" style={{ border: "1px solid rgba(200,150,62,.5)", animation: "ring 9s 6s linear infinite" }} />
      </div>

      {/* front layer: protected zone */}
      <div data-lens-shield="1" className="relative z-[2] w-full max-w-[760px] text-center will-change-transform">
        <p className="m-0 inline-block max-w-[560px] rounded-[22px] px-4 py-1.5 text-[15px] font-normal leading-[1.8] text-ink2 min-[760px]:text-[17px]" style={{ background: "color-mix(in oklab,var(--bg) 90%,transparent)", animation: "up 1s .1s both" }}>
          اسأل بالعربية، واستلم بيانات منظّمة من مصادر كثيرة في ملف إكسل أو بي دي إف
        </p>
        <h1
          className="mt-[18px] mb-0 font-display text-ink"
          style={{
            fontSize: "clamp(52px,9.6cqi,116px)", lineHeight: 1.1, letterSpacing: 0,
            WebkitTextStroke: "7px var(--bg)", paintOrder: "stroke fill",
            textShadow: "0 0 3px var(--bg),0 0 8px var(--bg),0 0 16px var(--bg),0 0 34px var(--bg)",
            animation: "up 1.2s .2s cubic-bezier(.2,.7,.2,1) both",
          }}
        >
          ماذا تريد أن تعرف؟
        </h1>
        <form
          onSubmit={submit}
          className="relative mx-auto mt-11 flex max-w-[680px] items-center gap-1.5 rounded-full border border-ln bg-sf p-2"
          style={{ boxShadow: "var(--shadow)", animation: "up 1.1s .45s both" }}
        >
          <span className="h-2.5 w-2.5 shrink-0 rounded-full border-2 border-gold" style={{ marginInlineStart: 16 }} />
          <div className="relative min-w-0 flex-1">
            <input
              ref={inputRef}
              type="text"
              placeholder="اسأل ديجر"
              aria-label="سؤالك البحثي"
              maxLength={500}
              onChange={(e) => {
                const v = e.target.value;
                setHasText(v.length > 0);
                setPicked(PROMPTS.indexOf(v) >= 0 ? PROMPTS.indexOf(v) : null);
              }}
              className="w-full min-h-[52px] border-0 bg-transparent px-3 text-[17px] font-light text-ink outline-none"
            />
          </div>
          <button
            type="submit"
            aria-label="اسأل ديجر"
            className="flex h-[52px] w-[52px] shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-ac text-onac transition-[opacity,transform] duration-200 hover:scale-105"
            style={{ opacity: hasText ? 1 : 0.4 }}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 19V5M5.5 11.5L12 5l6.5 6.5" /></svg>
          </button>
        </form>
        <div className="mx-auto mt-5 flex max-w-[680px] flex-wrap items-center justify-center gap-x-5 gap-y-2" style={{ animation: "up 1s .6s both" }}>
          <Link href={user ? "/dashboard/chat" : "/register"} className="inline-flex min-h-12 items-center rounded-full bg-ac px-7 text-[15px] text-onac no-underline">{user ? "ابدأ طلبك" : "أنشئ حسابك وابدأ طلبك"}</Link>
          <Link href="/services" className="inline-flex min-h-12 items-center rounded-full px-3 text-[15px] text-ink underline underline-offset-4" style={{ background: "color-mix(in oklab,var(--bg) 90%,transparent)" }}>خدماتنا</Link>
        </div>
        <div className="mx-auto mt-3 max-w-[680px]" style={{ animation: "up 1s .7s both" }}>
          <button
            type="button"
            aria-expanded={ideasOpen}
            aria-controls="landing-ideas"
            onClick={() => setIdeasOpen(!ideasOpen)}
            className="min-h-11 cursor-pointer rounded-full border-0 px-4 text-[13px] font-normal text-mut"
            style={{ background: "color-mix(in oklab,var(--bg) 90%,transparent)" }}
          >
            {ideasOpen ? "إخفاء الأمثلة" : "أمثلة جاهزة للبدء"}
          </button>
        </div>
        {ideasOpen && <div id="landing-ideas">
        <div className="mx-auto mt-[14px] max-w-[680px]">
          <p className="m-0 mb-2.5 text-xs font-normal text-mut">
            <span className="inline-block rounded-full px-3 py-[3px]" style={{ background: "color-mix(in oklab,var(--bg) 90%,transparent)", WebkitBackdropFilter: "blur(12px)", backdropFilter: "blur(12px)" }}>أو ابدأ بمثال</span>
          </p>
          <div className={mobile ? "grid grid-cols-2 gap-2 pb-2 pt-1" : "flex flex-wrap justify-center gap-2 pb-2 pt-1"}>
            {EXAMPLES.map((label, i) => (
              <button
                key={label}
                type="button"
                onClick={() => useExample(i)}
                className={`flex min-w-0 cursor-pointer items-center gap-2.5 rounded-full border bg-transparent p-0 text-right text-[13px] font-normal leading-[1.4] text-ink transition-[border-color,transform,box-shadow] duration-[250ms] hover:-translate-y-0.5 hover:border-gold hover:shadow-[var(--shadow)] ${mobile ? "min-h-[54px] whitespace-normal" : "min-h-[46px] whitespace-nowrap"} ${picked === i ? "border-gold" : "border-ln"}`}
                style={{ background: "color-mix(in oklab,var(--sf) 94%,transparent)", paddingInlineStart: 6, paddingInlineEnd: 16 }}
              >
                <span className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-full bg-sf2 text-goldT">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d={CHIP_ICONS[i]} /></svg>
                </span>
                <span>{label}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="mx-auto mt-3 max-w-[680px]">
          <p className="m-0 mb-2.5 text-xs font-normal text-mut">
            <span className="inline-block rounded-full px-3 py-[3px]" style={{ background: "color-mix(in oklab, var(--bg) 90%, transparent)", WebkitBackdropFilter: "blur(12px)", backdropFilter: "blur(12px)" }}>أو مهمة كبيرة</span>
          </p>
          <div className={mobile ? "grid grid-cols-1 gap-2 pb-2" : "flex flex-wrap justify-center gap-2 pb-2"} data-testid="landing-mission-templates">
            {MISSION_TEMPLATES.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => useTemplate(t.promptAr)}
                className="min-h-[46px] cursor-pointer rounded-full border border-ln px-4 py-2 text-right text-[13px] font-normal leading-[1.5] text-ink transition-[border-color,transform] duration-[250ms] hover:-translate-y-0.5 hover:border-gold"
                style={{ background: "color-mix(in oklab, var(--sf) 94%, transparent)" }}
              >
                {t.titleAr}
              </button>
            ))}
          </div>
        </div>
        </div>}
        <p className="mb-0 mt-9 inline-block rounded-full px-4 py-1.5 text-xs font-normal text-mut" style={{ background: "color-mix(in oklab,var(--bg) 90%,transparent)", animation: "fade 1.2s .9s both" }}>
          لا يبدأ أي جمع ولا يُخصم أي رصيد قبل موافقتك
        </p>
      </div>
    </section>
  );
}
