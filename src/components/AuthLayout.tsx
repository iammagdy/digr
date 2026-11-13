"use client";

import Link from "next/link";
import { authFailureMessageAr } from "@/lib/authHelp";
import { useEffect, useId, useState, type InputHTMLAttributes, type ReactNode } from "react";
import { Logo } from "@/components/Brand";
import { ThemeToggle } from "@/components/ThemeToggle";
import { readPendingQuestion } from "@/lib/pendingQuestion";

export const authInput =
  "w-full min-h-[60px] rounded-[20px] border border-ln bg-sf px-[22px] text-base font-light text-ink outline-none transition-[border-color,box-shadow] focus:border-ln2 focus:shadow-[var(--shadow)]";
export const authPrimaryBtn =
  "flex min-h-[60px] w-full cursor-pointer items-center justify-center rounded-full border-0 bg-ac text-base text-onac transition-opacity disabled:cursor-not-allowed disabled:opacity-45";
export const authLink = "cursor-pointer border-0 bg-transparent p-0 text-mut";

/** Centered single column (max 440) shared by sign up, login, verify, forgot and reset. */
export function AuthLayout({
  title,
  subtitle,
  children,
  footer,
  showPending = true,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
  footer?: ReactNode;
  showPending?: boolean;
}) {
  const [pending, setPending] = useState("");
  useEffect(() => { setPending(readPendingQuestion()); }, []);

  return (
    <main className="flex min-h-dvh flex-col items-center bg-bg px-5 pb-10 pt-7 text-ink2">
      <div className="flex w-full max-w-[440px] items-center justify-between">
        <Link href="/" aria-label="ديجر" className="flex min-h-11 items-center"><Logo height={30} /></Link>
        <ThemeToggle className="!text-mut" />
      </div>
      <div className="flex w-full max-w-[440px] flex-1 flex-col justify-center py-12">
        {showPending && pending && (
          <div className="mb-8 rounded-[22px] bg-sf2 px-[18px] py-4" style={{ animation: "up .6s both" }}>
            <p className="m-0 text-xs text-fnt">سؤالك محفوظ — نكمل بعد التسجيل</p>
            <p className="mb-0 mt-1.5 text-[15px] leading-[1.85] text-ink">«{pending}»</p>
          </div>
        )}
        <h1 className="m-0 text-[44px] font-extralight leading-[1.2] text-ink" style={{ animation: "up .8s both" }}>{title}</h1>
        <p className="mb-0 mt-3 text-[15px] font-light leading-[1.9] text-mut">{subtitle}</p>
        {children}
        {footer}
      </div>
    </main>
  );
}

export function AuthToast({ tone = "ok", children }: { tone?: "ok" | "bad"; children: ReactNode }) {
  return (
    <p
      role={tone === "bad" ? "alert" : "status"}
      className={`mb-0 mt-4 rounded-2xl px-4 py-3 text-[13px] ${tone === "bad" ? "text-bad" : "text-ok"}`}
      style={{ background: `color-mix(in oklab, var(--${tone}) 12%, transparent)`, animation: "up .3s both" }}
    >
      {children}
    </p>
  );
}

export const authLabel = "block px-1 pb-1.5 text-sm font-medium text-ink";

/**
 * A sign-in field with a label that stays on screen while the customer types (a placeholder disappears at the first key).
 * The label is tied to the input by id; a hint and an error are announced with it (aria-describedby / aria-invalid).
 * The placeholder is only an example of what to type, never the field's name.
 */
export function AuthField({
  label, hint, error, id, className = "", adornment, ...input
}: Omit<InputHTMLAttributes<HTMLInputElement>, "id"> & { label: string; hint?: string; error?: string; id?: string; adornment?: ReactNode }) {
  const auto = useId();
  const inputId = id ?? `auth-${auto}`;
  const hintId = `${inputId}-hint`;
  const errorId = `${inputId}-error`;
  const describedBy = error ? errorId : hint ? hintId : undefined;
  return (
    <div className="flex flex-col">
      <label htmlFor={inputId} className={authLabel}>{label}</label>
      <div className="relative">
        <input
          {...input} id={inputId} aria-invalid={error ? true : undefined} aria-describedby={describedBy}
          className={`${authInput} ${className}`}
        />
        {adornment}
      </div>
      {hint && !error && <p id={hintId} className="m-0 mt-1.5 px-1 text-xs leading-[1.7] text-mut">{hint}</p>}
      {error && <p id={errorId} role="alert" className="m-0 mt-1.5 px-1 text-[13px] leading-[1.7] text-bad">{error}</p>}
    </div>
  );
}

export function PasswordInput({
  value, onChange, label = "كلمة المرور", hint, error, placeholder, autoComplete,
}: { value: string; onChange: (v: string) => void; label?: string; hint?: string; error?: string; placeholder?: string; autoComplete: string }) {
  const [show, setShow] = useState(false);
  return (
    <AuthField
      label={label} hint={hint} error={error}
      type={show ? "text" : "password"} dir="ltr" required autoComplete={autoComplete}
      value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
      className="text-left" style={{ paddingInline: "76px 22px", paddingLeft: 76, paddingRight: 22 }}
      adornment={
        <button
          type="button" onClick={() => setShow((v) => !v)} aria-label={show ? "إخفاء كلمة المرور" : "إظهار كلمة المرور"}
          className="absolute left-2.5 top-2.5 h-11 cursor-pointer rounded-[14px] border-0 bg-sf2 px-3.5 text-[13px] text-mut"
        >
          {show ? "إخفاء" : "إظهار"}
        </button>
      }
    />
  );
}

/** Auth errors are English; show the design's Arabic tone instead. */
export function authErrorMessage(err: unknown, fallback: string): string {
  return authFailureMessageAr(err, fallback);
}
