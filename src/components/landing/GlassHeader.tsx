"use client";

import Link from "next/link";
import { Logo } from "@/components/Brand";
import { ThemeToggle } from "@/components/ThemeToggle";
import { useUser } from "@/hooks/useUser";

export function GlassHeader({ initialSignedIn }: { initialSignedIn?: boolean } = {}) {
  const { user, loading } = useUser();
  const signedIn = loading ? Boolean(initialSignedIn) : Boolean(user);
  const resolving = loading && initialSignedIn === undefined;

  return (
    <header className="sticky top-0 z-30 h-0 overflow-visible">
      <div className="px-3 py-2.5 min-[760px]:px-5 min-[760px]:py-3.5">
        <div
          className="relative mx-auto flex h-[58px] max-w-[1100px] items-center justify-between gap-3 rounded-full ps-3.5 pe-2 min-[760px]:h-[62px] min-[760px]:ps-5"
          style={{
            border: "1px solid var(--pill-bd)", background: "var(--pill-bg)",
            WebkitBackdropFilter: "blur(16px) saturate(1.7)", backdropFilter: "blur(16px) saturate(1.7)",
            boxShadow: "var(--pill-sh)", animation: "up .9s .05s both",
          }}
        >
          <span aria-hidden="true" className="pointer-events-none absolute inset-0 rounded-[inherit]" style={{ background: "linear-gradient(180deg,var(--pill-gloss),transparent 55%)" }} />
          <div className="relative flex items-center gap-3.5">
            <Link href="/" aria-label="ديجر" className="flex min-h-11 items-center"><Logo height={28} className="min-[760px]:[&_img]:!h-8" /></Link>
            <span className="hidden h-[22px] w-px bg-ln2 min-[760px]:block" />
            <span className="hidden whitespace-nowrap text-sm font-light text-mut min-[760px]:block">بحثك يبدأ من هنا</span>
          </div>
          <div className="relative flex items-center gap-1">
            <ThemeToggle className="!text-mut" />
            <Link href="/calculator" className="flex h-11 items-center rounded-full px-3.5 text-sm text-ink transition-colors hover:bg-sf2">حاسبة التكلفة</Link>
            {resolving ? null : signedIn ? (
              <Link href="/dashboard/chat" className="relative flex h-11 items-center whitespace-nowrap rounded-full bg-ac px-[18px] text-sm text-onac">لوحة التحكم</Link>
            ) : (
              <>
                <Link href="/login" className="flex h-11 items-center rounded-full px-3.5 text-sm text-ink transition-colors hover:bg-sf2">دخول</Link>
                <Link href="/register" className="relative flex h-11 items-center whitespace-nowrap rounded-full bg-ac px-[18px] text-sm text-onac">حساب جديد</Link>
              </>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}

