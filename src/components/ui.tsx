"use client";

import { useEffect, useId, type ReactNode } from "react";

/* ------------------------------------------------------------------ */
/* Buttons                                                             */
/* ------------------------------------------------------------------ */

type ButtonVariant = "primary" | "accent" | "secondary" | "ghost" | "danger";
type ButtonSize = "sm" | "md" | "lg";

const buttonVariants: Record<ButtonVariant, string> = {
  primary: "bg-primary text-white hover:bg-primary-hover shadow-xs",
  accent: "bg-accent text-white hover:bg-accent-hover shadow-xs",
  secondary: "bg-white text-ink-900 border border-sand-300 hover:bg-sand-100",
  ghost: "text-ink-700 hover:bg-sand-100",
  danger: "bg-danger text-white hover:bg-danger/90 shadow-xs",
};

const buttonSizes: Record<ButtonSize, string> = {
  sm: "min-h-9 px-3 text-xs",
  md: "min-h-11 px-4 text-sm",
  lg: "min-h-12 px-6 text-base",
};

export function Button({
  variant = "primary",
  size = "md",
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
}) {
  return (
    <button
      type="button"
      className={`inline-flex cursor-pointer items-center justify-center gap-2 rounded-xl font-semibold transition-colors duration-150 motion-reduce:transition-none disabled:cursor-not-allowed disabled:opacity-40 ${buttonVariants[variant]} ${buttonSizes[size]} ${className}`}
      {...props}
    />
  );
}

export function IconButton({
  label,
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={`touch-target inline-flex cursor-pointer items-center justify-center rounded-xl text-sand-600 transition-colors hover:bg-sand-100 hover:text-ink-900 disabled:cursor-not-allowed disabled:opacity-40 ${className}`}
      {...props}
    />
  );
}

/* ------------------------------------------------------------------ */
/* Surfaces                                                            */
/* ------------------------------------------------------------------ */

export function Card({
  className = "",
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={`rounded-2xl border border-sand-200 bg-white shadow-[var(--shadow-card)] ${className}`}
      {...props}
    />
  );
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-center gap-2 text-xs font-semibold text-accent">
      <span aria-hidden="true" className="inline-block h-px w-6 bg-accent/50" />
      {children}
    </p>
  );
}

/* ------------------------------------------------------------------ */
/* Status                                                              */
/* ------------------------------------------------------------------ */

export type StatusTone = "neutral" | "info" | "success" | "warning" | "danger" | "accent";

const toneStyles: Record<StatusTone, string> = {
  neutral: "bg-sand-100 text-sand-700 border-sand-300",
  info: "bg-info-bg text-info border-info/25",
  success: "bg-success-bg text-success border-success/25",
  warning: "bg-warning-bg text-warning border-warning/30",
  danger: "bg-danger-bg text-danger border-danger/25",
  accent: "bg-accent-light text-accent-ink border-accent/25",
};

export function Badge({
  tone = "neutral",
  className = "",
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & { tone?: StatusTone }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold whitespace-nowrap ${toneStyles[tone]} ${className}`}
      {...props}
    />
  );
}

export function Stamp({
  tone = "neutral",
  children,
}: {
  tone?: StatusTone;
  children: ReactNode;
}) {
  const ink: Record<StatusTone, string> = {
    neutral: "text-sand-600",
    info: "text-info",
    success: "text-success",
    warning: "text-warning",
    danger: "text-danger",
    accent: "text-accent",
  };
  return (
    <span className={`stamp ${ink[tone]}`} role="status">
      {children}
    </span>
  );
}

export function StatusDot({ tone = "neutral", pulse = false }: { tone?: StatusTone; pulse?: boolean }) {
  const dot: Record<StatusTone, string> = {
    neutral: "bg-sand-400",
    info: "bg-info",
    success: "bg-success",
    warning: "bg-warning",
    danger: "bg-danger",
    accent: "bg-accent",
  };
  return (
    <span className="relative inline-flex h-2.5 w-2.5 shrink-0" aria-hidden="true">
      {pulse && (
        <span className={`absolute inline-flex h-full w-full rounded-full opacity-60 motion-safe:animate-ping motion-reduce:animate-none ${dot[tone]}`} />
      )}
      <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${dot[tone]}`} />
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Forms                                                               */
/* ------------------------------------------------------------------ */

const fieldInput =
  "w-full rounded-xl border border-sand-300 bg-white px-3.5 py-2.5 text-sm text-ink-900 placeholder:text-sand-400 transition-colors focus:border-accent focus:outline-none disabled:bg-sand-100 disabled:opacity-60";

export function Field({
  label,
  error,
  hint,
  children,
  htmlFor,
}: {
  label: string;
  error?: string;
  hint?: string;
  children: ReactNode;
  htmlFor?: string;
}) {
  const id = useId();
  const inputId = htmlFor ?? `field-${id}`;
  return (
    <div className="space-y-1.5">
      <label htmlFor={inputId} className="block text-sm font-semibold text-ink-900">
        {label}
      </label>
      {children}
      {hint && !error && <p className="text-xs text-sand-500">{hint}</p>}
      {error && (
        <p role="alert" className="text-xs font-medium text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${fieldInput} min-h-11 ${props.className ?? ""}`} />;
}

export function TextArea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={`${fieldInput} resize-y ${props.className ?? ""}`} />;
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...props} className={`${fieldInput} min-h-11 cursor-pointer ${props.className ?? ""}`} />
  );
}

/* ------------------------------------------------------------------ */
/* Overlays: Modal & Drawer                                            */
/* ------------------------------------------------------------------ */

function useLockBody(locked: boolean) {
  useEffect(() => {
    if (!locked) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [locked]);
}

function useEscape(onClose: () => void, active: boolean) {
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [active, onClose]);
}

export function Modal({
  open,
  onClose,
  title,
  children,
  wide = false,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  wide?: boolean;
}) {
  useLockBody(open);
  useEscape(onClose, open);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-label={title}>
      <div className="absolute inset-0 bg-ink-900/45 backdrop-blur-xs animate-fade" onClick={onClose} aria-hidden="true" />
      <div className={`relative flex max-h-[92dvh] w-full flex-col overflow-hidden rounded-t-3xl bg-white shadow-2xl animate-rise sm:rounded-3xl ${wide ? "sm:max-w-2xl" : "sm:max-w-lg"}`}>
        <div className="flex items-center justify-between border-b border-sand-200 px-5 py-4">
          <h2 className="text-base font-bold text-ink-900">{title}</h2>
          <IconButton label="إغلاق" onClick={onClose}>
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </IconButton>
        </div>
        <div className="overflow-y-auto p-5">{children}</div>
      </div>
    </div>
  );
}

export function Drawer({
  open,
  onClose,
  title,
  children,
  side = "start",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  side?: "start" | "end";
}) {
  useLockBody(open);
  useEscape(onClose, open);
  if (!open) return null;
  const pos = side === "start" ? "right-0" : "left-0";
  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label={title}>
      <div className="absolute inset-0 bg-ink-900/45 backdrop-blur-xs animate-fade" onClick={onClose} aria-hidden="true" />
      <div className={`absolute inset-y-0 ${pos} flex w-full max-w-sm flex-col bg-white shadow-2xl animate-rise`}>
        <div className="flex items-center justify-between border-b border-sand-200 px-5 py-4">
          <h2 className="text-base font-bold text-ink-900">{title}</h2>
          <IconButton label="إغلاق" onClick={onClose}>
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </IconButton>
        </div>
        <div className="flex-1 overflow-y-auto p-5">{children}</div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Tabs                                                                */
/* ------------------------------------------------------------------ */

export function Tabs<T extends string>({
  tabs,
  active,
  onChange,
}: {
  tabs: Array<{ id: T; label: string; count?: number }>;
  active: T;
  onChange: (id: T) => void;
}) {
  return (
    <div role="tablist" aria-label="تبويبات" className="flex gap-1 overflow-x-auto border-b border-sand-200">
      {tabs.map((tab) => {
        const selected = tab.id === active;
        return (
          <button
            key={tab.id}
            role="tab"
            aria-selected={selected}
            type="button"
            onClick={() => onChange(tab.id)}
            className={`relative min-h-11 shrink-0 cursor-pointer px-4 text-sm font-semibold transition-colors ${
              selected ? "text-ink-900" : "text-sand-500 hover:text-ink-700"
            }`}
          >
            {tab.label}
            {typeof tab.count === "number" && (
              <span className="tnum ms-1.5 rounded-full bg-sand-100 px-1.5 py-0.5 text-xs text-sand-600">
                {tab.count}
              </span>
            )}
            {selected && <span aria-hidden="true" className="absolute inset-x-3 -bottom-px h-0.5 rounded-full bg-accent" />}
          </button>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Progress — honest: value only when real, otherwise stage label      */
/* ------------------------------------------------------------------ */

export function Progress({
  value,
  label,
}: {
  value?: number | null;
  label?: string;
}) {
  if (value == null || Number.isNaN(value)) {
    return (
      <div className="flex items-center gap-2.5" role="status">
        <span className="h-2 flex-1 overflow-hidden rounded-full bg-sand-200">
          <span className="block h-full w-1/3 rounded-full bg-accent/70 motion-safe:animate-pulse motion-reduce:animate-none" />
        </span>
        {label && <span className="text-xs font-medium text-sand-600">{label}</span>}
      </div>
    );
  }
  const pct = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <div className="space-y-1.5" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={label ?? "التقدم"}>
      <div className="h-2 overflow-hidden rounded-full bg-sand-200">
        <div className="h-full rounded-full bg-accent transition-[width] duration-500 motion-reduce:transition-none" style={{ width: `${pct}%` }} />
      </div>
      {label && (
        <div className="flex items-center justify-between text-xs">
          <span className="font-medium text-sand-600">{label}</span>
          <span className="tnum font-bold text-ink-900">{pct}٪</span>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Feedback: Alert, EmptyState, Skeleton, Spinner, Stat                 */
/* ------------------------------------------------------------------ */

export function Alert({
  tone = "info",
  title,
  children,
}: {
  tone?: StatusTone;
  title?: string;
  children: ReactNode;
}) {
  return (
    <div role={tone === "danger" ? "alert" : "status"} className={`flex gap-3 rounded-2xl border p-4 text-sm ${toneStyles[tone]}`}>
      <StatusDot tone={tone} />
      <div className="min-w-0">
        {title && <p className="font-bold">{title}</p>}
        <div className="mt-0.5 leading-relaxed opacity-90">{children}</div>
      </div>
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center px-6 py-12 text-center">
      {icon && (
        <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-sand-100 text-sand-500">
          {icon}
        </div>
      )}
      <h3 className="text-base font-bold text-ink-900">{title}</h3>
      {description && <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-sand-600">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <div aria-hidden="true" className={`skeleton rounded-xl ${className}`} />;
}

export function Spinner({ label = "جاري التحميل" }: { label?: string }) {
  return (
    <span role="status" aria-label={label} className="inline-flex items-center gap-2 text-sm text-sand-600">
      <svg className="h-4 w-4 motion-safe:animate-spin motion-reduce:animate-none" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" className="opacity-20" />
        <path d="M22 12a10 10 0 00-10-10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
      </svg>
      <span className="sr-only">{label}</span>
    </span>
  );
}

export function Stat({
  label,
  value,
  sub,
  tone = "neutral",
}: {
  label: string;
  value: ReactNode;
  sub?: string;
  tone?: StatusTone;
}) {
  return (
    <div className={`rounded-2xl border p-4 ${toneStyles[tone]}`}>
      <p className="text-xs font-semibold opacity-80">{label}</p>
      <p className="tnum mt-1 text-2xl font-bold">{value}</p>
      {sub && <p className="mt-1 text-xs opacity-75">{sub}</p>}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Avatar                                                              */
/* ------------------------------------------------------------------ */

export function Avatar({ name, size = "md" }: { name?: string; size?: "sm" | "md" | "lg" }) {
  const sizes = { sm: "h-8 w-8 text-xs", md: "h-10 w-10 text-sm", lg: "h-14 w-14 text-lg" };
  const initial = (name ?? "؟").trim().charAt(0) || "؟";
  return (
    <span aria-hidden="true" className={`inline-flex shrink-0 items-center justify-center rounded-full bg-pine-800 font-bold text-white ${sizes[size]}`}>
      {initial}
    </span>
  );
}
