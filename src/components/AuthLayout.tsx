"use client";

import Link from "next/link";
import { authFailureMessageAr } from "@/lib/authHelp";
import { useEffect, useState, type ReactNode } from "react";
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

export function PasswordInput({
  value, onChange, placeholder = "كلمة المرور · 8 خانات على الأقل", autoComplete,
}: { value: string; onChange: (v: string) => void; placeholder?: string; autoComplete: string }) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <input
        type={show ? "text" : "password"} dir="ltr" required autoComplete={autoComplete}
        value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
        className={`${authInput} text-left`} style={{ paddingInline: "76px 22px", paddingLeft: 76, paddingRight: 22 }}
      />
      <button
        type="button" onClick={() => setShow((v) => !v)} aria-pressed={show}
        className="absolute left-2.5 top-2.5 h-10 cursor-pointer rounded-[14px] border-0 bg-sf2 px-3.5 text-[13px] text-mut"
      >
        {show ? "إخفاء" : "إظهار"}
      </button>
    </div>
  );
}

/** Auth errors are English; show the design's Arabic tone instead. */
export function authErrorMessage(err: unknown, fallback: string): string {
  return authFailureMessageAr(err, fallback);
}
