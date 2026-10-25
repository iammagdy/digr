"use client";

import { memo, useEffect, useRef, useState } from "react";
import { buildFieldItems } from "./heroField";

/**
 * The hero's background: a blurred field of records, a lens that drifts over it and shows the same records sharp, and three slow rings.
 * It is decoration only: every layer is aria-hidden, takes no pointer events and sits behind the question box, and it is added after the page
 * is shown, so it never moves the text and is not part of the first HTML.
 *
 * Reduced motion: nothing moves. The field, the lens (fixed on the upper right) and the rings are drawn once and left still.
 * Contrast is kept low (DIM_OPACITY, LENS_OPACITY) so the Arabic headline above it stays easy to read; the headline carries its own halo.
 */
export const DIM_OPACITY = 0.09;
export const LENS_OPACITY = 0.62;
/** How far the field lights up around the pointer (on top of DIM_OPACITY). */
const REPEL_GAIN = 0.24;

const FIELD_STYLE: React.CSSProperties = {
  position: "absolute", inset: 0, padding: 12, fontSize: 13, lineHeight: 2.2, display: "flex", flexWrap: "wrap",
  alignContent: "flex-start", columnGap: 22, userSelect: "none", overflow: "hidden",
};

/* Memoised: nothing the visitor types ever re-renders the records. */
const RecordField = memo(function RecordField({ items, variant }: { items: string[]; variant: "dim" | "hi" }) {
  if (variant === "dim") {
    return (
      <div
        data-field="dim"
        style={{ ...FIELD_STYLE, color: "transparent", textShadow: "0 0 2.5px var(--ink),4px 1px 2.5px var(--ink),-3px 0 2.5px var(--ink)" }}
      >
        {items.map((w, i) => (
          <span key={i} style={{ display: "inline-block", whiteSpace: "nowrap", opacity: DIM_OPACITY }}>{w}</span>
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
        <span key={i} style={{ display: "inline-block", whiteSpace: "nowrap", opacity: LENS_OPACITY }}>{w}</span>
      ))}
    </div>
  );
});

/** The layers only (no behaviour): a test can draw them with fixed records. */
export function HeroBackdropLayers({ items, mobile, rootRef }: { items: string[]; mobile: boolean; rootRef?: React.Ref<HTMLDivElement> }) {
  const lens = mobile ? 112 : 170;
  return (
    <div
      ref={rootRef}
      data-testid="hero-backdrop"
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 overflow-hidden [animation:fade_1.4s_ease_both] motion-reduce:[animation:none]"
    >
      {/* back layer: the blurred records */}
      <div
        data-px-back="1"
        className="pointer-events-none absolute inset-0 will-change-transform"
        style={{ WebkitMaskImage: "radial-gradient(ellipse 85% 80% at 50% 50%,#000 45%,transparent 100%)", maskImage: "radial-gradient(ellipse 85% 80% at 50% 50%,#000 45%,transparent 100%)" }}
      >
        <RecordField items={items} variant="dim" />
      </div>

      {/* the lens: a sharp copy of the field, cut to a circle */}
      <div
        data-lens-win="1"
        className="pointer-events-none absolute left-0 top-0 overflow-hidden rounded-full bg-bg will-change-transform"
        style={{ width: lens, height: lens, transform: "translate3d(-9999px,0,0)", contain: "strict" }}
      >
        <RecordField items={items} variant="hi" />
      </div>
      <div
        data-lens-ring="1"
        className="pointer-events-none absolute left-0 top-0 rounded-full will-change-transform"
        style={{
          width: lens, height: lens, transform: "translate3d(-9999px,0,0)",
          border: "1.5px solid var(--gold)", background: "radial-gradient(circle at 32% 28%,rgba(255,255,255,.18),transparent 55%)",
          boxShadow: "0 0 0 10px rgba(200,150,62,.06),0 40px 70px -24px rgba(0,0,0,.26)",
        }}
      >
        <span style={{ position: "absolute", left: "14.6%", top: "85.4%", width: "30%", height: 5, marginTop: -2.5, borderRadius: 9, background: "var(--gold)", transformOrigin: "left center", transform: "rotate(135deg)" }} />
      </div>

      {/* middle layer: three slow rings (still when motion is reduced) */}
      <div
        data-px-rings="1"
        className="pointer-events-none absolute will-change-transform"
        style={{ left: "50%", top: "50%", width: "min(1000px,160cqi)", aspectRatio: "1", margin: "calc(min(1000px,160cqi) / -2) 0 0 calc(min(1000px,160cqi) / -2)" }}
      >
        <span className="absolute inset-0 rounded-full border border-ln2 [animation:ring_9s_linear_infinite] motion-reduce:[animation:none] motion-reduce:scale-[.62] motion-reduce:opacity-60" />
        <span className="absolute inset-0 rounded-full border border-ln2 [animation:ring_9s_3s_linear_infinite] motion-reduce:[animation:none] motion-reduce:scale-[.9] motion-reduce:opacity-40" />
        <span className="absolute inset-0 rounded-full motion-reduce:scale-[1.2] motion-reduce:opacity-25 [animation:ring_9s_6s_linear_infinite] motion-reduce:[animation:none]" style={{ border: "1px solid rgba(200,150,62,.4)" }} />
      </div>
    </div>
  );
}

export default function HeroBackdrop() {
  const rootRef = useRef<HTMLDivElement>(null);
  const [items, setItems] = useState<string[]>([]);
  const [mobile, setMobile] = useState(false);
  const mobileRef = useRef(false);
  mobileRef.current = mobile;

  // the records are made in the browser, after the first paint; fewer on a phone
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 759px)");
    const on = () => setMobile(mq.matches);
    on();
    mq.addEventListener("change", on);
    setItems(buildFieldItems());
    return () => mq.removeEventListener("change", on);
  }, []);

  const shown = mobile ? items.slice(0, 80) : items.slice(0, 190);

  /* ── one rAF loop: lens, parallax, magnet. CSS transforms only, no setState. ── */
  useEffect(() => {
    const root = rootRef.current;
    const hero = root?.parentElement;
    if (!root || !hero || items.length === 0) return;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const nav = navigator as Navigator & { deviceMemory?: number };
    const lite = reduced || (nav.hardwareConcurrency || 8) <= 4 || (nav.deviceMemory || 8) <= 4;

    const mouse = { x: 0, y: 0, on: false };
    let tap: { x: number; y: number; t: number } | null = null;
    let shield = false;

    const L = { x: 0.78, y: 0.29, tx: 0.78, ty: 0.29, px: 0, py: 0, fx: 0, fy: 0 };
    let geo: { W: number; H: number; cy: number; ry: number; n: number } | null = null;
    let els: null | { back: HTMLElement; win: HTMLElement; inner: HTMLElement; ring: HTMLElement; rings: HTMLElement; shield: HTMLElement; W: number; H: number; D: number } = null;
    let fw: null | { w: number; dims: HTMLElement[]; cx: number[]; cy: number[]; ox: number[]; oy: number[]; moved: boolean[] } = null;
    let raf = 0;
    let frame = 0;
    let visible = true;

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
      if (mouse.on && !mobileRef.current) src.push([mouse.x, mouse.y, 130, 30]);
      if (mobileRef.current) {
        const k = (tm / 1000) * 0.21;
        src.push([(0.5 + Math.cos(k * 0.8 + 2.1) * 0.42) * W, (0.5 + Math.sin(k * 1.1 + 0.4) * 0.44) * Hh, 92, 24]);
        if (tap) {
          const age = (tm - tap.t) / 1000;
          if (age < 1.1) src.push([tap.x, tap.y, 50 + age * 220, 30 * (1 - age / 1.1)]);
          else tap = null;
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
        el.style.opacity = (DIM_OPACITY + Math.min(1, mag / 30) * REPEL_GAIN).toFixed(3);
        F.moved[i] = !still;
      }
    };

    /** One picture of the scene. With reduced motion it is drawn once (the lens parked on the upper right, no parallax) and on a resize. */
    const draw = (tm: number) => {
      const E = heroEls();
      if (!E) return;
      if (reduced) {
        L.tx = 0.78; L.ty = 0.3; L.x = L.tx; L.y = L.ty; L.px = 0; L.py = 0; L.fx = 0; L.fy = 0;
      } else {
        const mb = mobileRef.current;
        const k = (tm / 1000) * (mb ? 0.36 : 0.2);
        const G = lensGeo();
        const RX = mb ? 0.17 : 0.3, RY = G.ry, CY = G.cy;
        const wob = 1 + Math.sin(k * 0.63) * 0.14 + Math.sin(k * 1.7 + 1) * 0.06;
        L.tx = 0.5 + Math.cos(k) * RX * wob + Math.sin(k * 0.41 + 2) * RX * 0.08;
        L.ty = CY + Math.sin(k) * RY * wob + Math.sin(k * 2.3) * RY * 0.18;
        L.x += (L.tx - L.x) * 0.045; L.y += (L.ty - L.y) * 0.045;
        L.px += ((L.x - 0.5) * 2 - L.px) * 0.08; L.py += ((L.y - 0.5) * 2 - L.py) * 0.08;
        const frozen = mobileRef.current || shield || E.shield.contains(document.activeElement);
        L.fx += ((frozen ? 0 : L.px) - L.fx) * 0.12; L.fy += ((frozen ? 0 : L.py) - L.fy) * 0.12;
      }
      const bx = L.px * -22, by = L.py * -16;
      E.back.style.transform = `translate3d(${bx.toFixed(1)}px,${by.toFixed(1)}px,0)`;
      E.rings.style.transform = `translate3d(${(L.px * -9).toFixed(1)}px,${(L.py * -7).toFixed(1)}px,0)`;
      E.shield.style.transform = Math.abs(L.fx) + Math.abs(L.fy) < 0.002 ? "" :
        `translate3d(${(L.fx * 5).toFixed(2)}px,${(L.fy * 4).toFixed(2)}px,0) rotateY(${(L.fx * -1.5).toFixed(2)}deg) rotateX(${(L.fy * 1.5).toFixed(2)}deg)`;
      const X = L.x * E.W, Y = L.y * E.H, D = E.D, S = 1.08;
      const p = `translate3d(${(X - D / 2).toFixed(1)}px,${(Y - D / 2).toFixed(1)}px,0)`;
      E.win.style.transform = p; E.ring.style.transform = p;
      E.inner.style.transform = `translate3d(${(D / 2 - (X - bx) * S).toFixed(1)}px,${(D / 2 - (Y - by) * S).toFixed(1)}px,0) scale(${S})`;
    };

    const loop = (tm: number) => {
      raf = requestAnimationFrame(loop);
      if (document.hidden || !visible) return;
      draw(tm);
      if ((frame++ & 1) === 0) repel(tm); // magnet runs every other frame
    };

    const onMove = (e: PointerEvent) => {
      if (mobileRef.current || e.pointerType !== "mouse") return;
      shield = !!(e.target as HTMLElement).closest?.("[data-lens-shield]");
      const r = hero.getBoundingClientRect();
      mouse.x = e.clientX - r.left; mouse.y = e.clientY - r.top; mouse.on = true;
    };
    const onDown = (e: PointerEvent) => {
      if (e.pointerType === "mouse") return;
      const r = hero.getBoundingClientRect();
      tap = { x: e.clientX - r.left, y: e.clientY - r.top, t: performance.now() };
    };
    const onLeave = () => { shield = false; mouse.on = false; };
    const onResize = () => draw(0);

    if (reduced) {
      draw(0);
      window.addEventListener("resize", onResize);
      return () => window.removeEventListener("resize", onResize);
    }

    // not drawn while the hero is out of view
    const watcher = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver((entries) => { visible = entries[entries.length - 1]?.isIntersecting ?? true; });
    watcher?.observe(hero);
    hero.addEventListener("pointermove", onMove, { passive: true });
    hero.addEventListener("pointerdown", onDown, { passive: true });
    hero.addEventListener("pointerleave", onLeave);
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      watcher?.disconnect();
      hero.removeEventListener("pointermove", onMove);
      hero.removeEventListener("pointerdown", onDown);
      hero.removeEventListener("pointerleave", onLeave);
      const shieldEl = hero.querySelector<HTMLElement>("[data-lens-shield]");
      if (shieldEl) shieldEl.style.transform = "";
    };
  }, [items, mobile]);

  return <HeroBackdropLayers items={shown} mobile={mobile} rootRef={rootRef} />;
}
