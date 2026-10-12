"use client";

import { appBaseUrl } from "@/lib/site";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useUser } from "@/hooks/useUser";
import { AuthLayout, AuthToast, authPrimaryBtn } from "@/components/AuthLayout";

const RESEND_SECONDS = 30;

export default function VerifyPage() {
  const { user, loading, refresh, logout } = useUser();
  const router = useRouter();
  const [toast, setToast] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [wait, setWait] = useState(0);
  const [busy, setBusy] = useState(false);
  const handled = useRef(false);

  // Arriving from the email link: /verify?code=… or /verify?token_hash=… or /verify?userId=…&secret=…
  useEffect(() => {
    if (handled.current) return;
    const q = new URLSearchParams(window.location.search);
    const code = q.get("code");
    const tokenHash = q.get("token_hash");
    const type = (q.get("type") as any) || "signup";
    const userId = q.get("userId"), secret = q.get("secret");

    if (!code && !tokenHash && (!userId || !secret)) return;
    handled.current = true;

    (async () => {
      try {
        const supabase = createClient();
        if (code) {
          const { error } = await supabase.auth.exchangeCodeForSession(code);
          if (error) throw error;
        } else if (tokenHash) {
          const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type });
          if (error) throw error;
        }
        const u = await refresh();
        setToast({ tone: "ok", text: "تم تأكيد بريدك بنجاح." });
        if (u) setTimeout(() => router.replace("/dashboard/chat"), 900);
      } catch {
        setToast({ tone: "bad", text: "رابط التأكيد غير صالح أو منتهي. اطلب رسالة جديدة." });
      }
    })();
  }, [refresh, router]);

  useEffect(() => {
    if (!loading && !user && !handled.current) router.replace("/login");
    if (!loading && user?.emailVerification && !handled.current) router.replace("/dashboard/chat");
  }, [user, loading, router]);

  useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);

  const resend = useCallback(async () => {
    if (wait > 0 || !user?.email) return;
    try {
      const supabase = createClient();
      const { error } = await supabase.auth.resend({
        type: "signup",
        email: user.email,
        options: {
          emailRedirectTo: `${appBaseUrl()}/verify`,
        },
      });
      if (error) throw error;
      setToast({ tone: "ok", text: "أرسلنا رسالة تأكيد جديدة." });
    } catch {
      setToast({ tone: "bad", text: "تعذّر إرسال الرسالة الآن. حاول بعد قليل." });
    }
    setWait(RESEND_SECONDS);
  }, [wait, user?.email]);

  const done = async () => {
    setBusy(true);
    const u = await refresh();
    setBusy(false);
    if (u?.emailVerification) router.replace("/dashboard/chat");
    else setToast({ tone: "bad", text: "لم يصلنا التأكيد بعد. افتح الرسالة واضغط «تأكيد البريد»." });
  };

  const changeEmail = async () => {
    await logout();
    router.replace("/register");
  };

  return (
    <AuthLayout title="تحقق من بريدك" subtitle="خطوة أخيرة لحماية حسابك ورصيدك.">
      <div className="mt-7 flex flex-col gap-3.5" style={{ animation: "up .5s both" }}>
        <div className="flex items-center gap-3.5 rounded-[20px] bg-sf2 px-[18px] py-4">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-sf text-goldT">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 6h18v12H3zM3 7l9 6 9-6" /></svg>
          </span>
          <span className="min-w-0">
            <span className="block text-xs text-fnt">أرسلنا رابط التأكيد إلى</span>
            <span dir="ltr" className="block truncate text-right text-[15px] font-medium text-ink">{user?.email ?? ""}</span>
          </span>
        </div>
        <p className="m-0 text-sm font-light leading-[1.9] text-mut">افتح الرسالة واضغط «تأكيد البريد». لن تتمكن من شحن الرصيد أو بدء بحث قبل التأكيد. لم تجدها؟ راجع مجلد الرسائل غير المرغوب فيها.</p>
        <button type="button" onClick={done} disabled={busy} className={`${authPrimaryBtn} min-h-[58px] text-[15px]`}>أكّدت بريدي — متابعة</button>
        <div className="flex flex-wrap justify-center gap-x-[18px] gap-y-1">
          <button type="button" onClick={resend} disabled={wait > 0} className="min-h-11 cursor-pointer border-0 bg-transparent text-[13px]" style={{ color: wait > 0 ? "var(--fnt)" : "var(--ink)" }}>
            {wait > 0 ? `أُرسلت — يمكنك الطلب مجددًا بعد ${new Intl.NumberFormat("ar-EG").format(wait)} ثانية` : "إعادة إرسال الرسالة"}
          </button>
          <button type="button" onClick={changeEmail} className="min-h-11 cursor-pointer border-0 bg-transparent text-[13px] text-mut">تغيير البريد</button>
        </div>
      </div>
      {toast && <AuthToast tone={toast.tone}>{toast.text}</AuthToast>}
    </AuthLayout>
  );
}
