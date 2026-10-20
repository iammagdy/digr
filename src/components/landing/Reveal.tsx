"use client";

import { useEffect, useRef } from "react";

type Kind = "up" | "scale" | "fan";

/**
 * Scroll reveal: translateY(34px) + blur(10px) → sharp, staggered via `delay`.
 * IntersectionObserver (works in Safari). Styles are applied after mount, so
 * content stays visible without JS, and prefers-reduced-motion skips the effect.
 */
export function Reveal({
  as: Tag = "div", kind = "up", delay = 0, fan, className, style, children, "data-testid": testId,
}: {
  as?: "div" | "p" | "h2" | "span";
  kind?: Kind;
  delay?: number;
  fan?: string;
  className?: string;
  style?: React.CSSProperties;
  children: React.ReactNode;
  "data-testid"?: string;
}) {
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || matchMedia("(prefers-reduced-motion: reduce)").matches) {
      if (el && fan) el.style.transform = fan;
      return;
    }
    if (kind !== "fan") {
      el.style.opacity = "0";
      el.style.filter = "blur(10px)";
      el.style.transform = kind === "scale" ? "scale(.9)" : "translateY(34px)";
      el.style.transition = `opacity 1s ${delay}ms ease, transform 1.2s ${delay}ms cubic-bezier(.2,.7,.2,1), filter 1s ${delay}ms ease`;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        io.disconnect();
        if (kind === "fan") { el.style.transform = fan || "none"; return; }
        el.style.opacity = "1"; el.style.transform = "none"; el.style.filter = "none";
      },
      { threshold: 0.12, rootMargin: "0px 0px -6% 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [kind, delay, fan]);

  const Comp = Tag as React.ElementType;
  return <Comp ref={ref} className={className} style={style} data-testid={testId}>{children}</Comp>;
}
