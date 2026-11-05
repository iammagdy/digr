import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { clientKey, createRateLimiter, RATE_LIMITED_MESSAGE_AR } from "@/lib/server/publicRateLimit";
import { unsubscribeVerifyKeysFromEnv, verifyUnsubscribeToken } from "@/lib/server/unsubscribeToken";

export const dynamic = "force-dynamic";

/**
 * One-click unsubscribe from the news e-mails (RFC 8058).
 *  - POST (the one-click, sent by the mail provider or by the confirmation page's form): verifies the signed token and sets
 *    `user_metadata.prefs.notif.news = false` with the admin client, MERGING the existing metadata so nothing else is lost. Idempotent.
 *  - GET: only SHOWS a small confirmation page with a form that POSTs. A GET never changes anything: mail scanners and link previewers open links.
 * A bad, malformed or unknown token gets the same generic 400: the answer never tells whether an account exists. The token can only switch `news` OFF.
 */
const limiter = createRateLimiter({ windowMs: 60_000, max: 300 });

const NO_STORE = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex", "Referrer-Policy": "no-referrer" };
const GENERIC_BAD = { ok: false, error: "invalid_request" } as const;
const TOKEN_SHAPE = /^[A-Za-z0-9_.-]{1,512}$/;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function page(title: string, message: string, form?: { action: string; button: string }, status = 200): NextResponse {
  const body = `<!DOCTYPE html>
<html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>body{margin:0;background:#F3F0E8;color:#16201F;font-family:Tahoma,Arial,sans-serif;direction:rtl}main{max-width:480px;margin:12vh auto;padding:28px 24px;background:#FFFDF9;border:1px solid #E6E1D7;border-radius:20px}h1{font-size:22px;margin:0 0 12px}p{font-size:16px;line-height:1.8;margin:0 0 18px}button{font:inherit;font-weight:700;color:#FAF8F4;background:#0E3B43;border:0;border-radius:999px;padding:12px 28px;cursor:pointer}</style></head>
<body><main><h1>${esc(title)}</h1><p>${esc(message)}</p>${form ? `<form method="post" action="${esc(form.action)}"><input type="hidden" name="from" value="page"><button type="submit">${esc(form.button)}</button></form>` : ""}</main></body></html>`;
  return new NextResponse(body, { status, headers: { "Content-Type": "text/html; charset=utf-8", ...NO_STORE } });
}

function tokenOf(req: NextRequest): string | null {
  const t = req.nextUrl.searchParams.get("t");
  return t && TOKEN_SHAPE.test(t) ? t : null;
}

export async function GET(req: NextRequest) {
  const token = tokenOf(req);
  // verifying the signature touches no database: the page is the same for an unknown or a deleted account
  if (!token || !verifyUnsubscribeToken(token, unsubscribeVerifyKeysFromEnv())) {
    return page("الرابط غير صالح", "هذا الرابط غير صالح أو غير مكتمل. يمكنك إيقاف أخبار ديجر من إعدادات حسابك.");
  }
  return page("إلغاء الاشتراك من أخبار ديجر", "اضغط الزر لإيقاف رسائل الأخبار. رسائل حسابك الضرورية (الشحن واكتمال الطلبات) لا تتأثر.", {
    action: `/api/email/unsubscribe?t=${encodeURIComponent(token)}`,
    button: "إلغاء الاشتراك",
  });
}

export async function POST(req: NextRequest) {
  const decision = limiter.check(clientKey(req.headers));
  if (!decision.allowed) {
    return NextResponse.json({ ok: false, error: RATE_LIMITED_MESSAGE_AR }, { status: 429, headers: { ...NO_STORE, "Retry-After": String(decision.retryAfterSeconds) } });
  }

  // the confirmation page's form says `from=page`: it gets a page back; the mail provider's one-click POST gets JSON
  let fromPage = false;
  try {
    const type = req.headers.get("content-type") || "";
    if (type.includes("application/x-www-form-urlencoded") || type.includes("multipart/form-data")) {
      fromPage = (await req.formData()).get("from") === "page";
    }
  } catch { /* an unreadable body is a one-click POST without a form */ }

  const bad = () => (fromPage
    ? page("الرابط غير صالح", "هذا الرابط غير صالح أو غير مكتمل. يمكنك إيقاف أخبار ديجر من إعدادات حسابك.")
    : NextResponse.json(GENERIC_BAD, { status: 400, headers: NO_STORE }));

  const token = tokenOf(req);
  const userId = token ? verifyUnsubscribeToken(token, unsubscribeVerifyKeysFromEnv()) : null;
  if (!userId) return bad();

  try {
    const admin = createAdminClient();
    const { data, error } = await admin.auth.admin.getUserById(userId);
    const user = data?.user;
    // a deleted account answers like a bad token (never reveals whether an account exists); ANY other failure of the sign-in service (5xx, rate limit,
    // network) is a retryable 503: answering "invalid link" would tell the mail provider the request is permanently void while the person is still subscribed
    const notFound = Boolean(error) && (Number((error as any).status) === 404 || (error as any).code === "user_not_found");
    if (notFound || (!error && !user)) return bad();
    if (error || !user) throw new Error("auth_unavailable");

    const meta = (user.user_metadata && typeof user.user_metadata === "object" ? user.user_metadata : {}) as Record<string, any>;
    const prefs = (meta.prefs && typeof meta.prefs === "object" ? meta.prefs : {}) as Record<string, any>;
    const notif = (prefs.notif && typeof prefs.notif === "object" ? prefs.notif : {}) as Record<string, any>;

    if (notif.news !== false) {
      const { error: updateError } = await admin.auth.admin.updateUserById(userId, {
        user_metadata: { ...meta, prefs: { ...prefs, notif: { ...notif, news: false } } },
      });
      if (updateError) throw new Error("update_failed");
    }
  } catch {
    // never claim success when the preference was not saved; no detail (no id, no address) in the answer or the log
    console.error("[email:unsubscribe_failed]");
    return fromPage
      ? page("تعذّر الحفظ الآن", "الخدمة مشغولة مؤقتًا ولم نحفظ طلبك بعد. اضغط الزر مرة أخرى بعد لحظات.", { action: `/api/email/unsubscribe?t=${encodeURIComponent(token ?? "")}`, button: "حاول مرة أخرى" }, 503)
      : NextResponse.json({ ok: false, error: "unavailable" }, { status: 503, headers: NO_STORE });
  }

  return fromPage
    ? page("تم إلغاء الاشتراك", "أوقفنا رسائل الأخبار لحسابك. يمكنك إعادة تفعيلها في أي وقت من إعدادات حسابك.")
    : NextResponse.json({ ok: true }, { status: 200, headers: NO_STORE });
}
