/** Auth errors are English; show the design's Arabic tone instead. */
export function authErrorMessage(err: unknown, fallback: string): string {
  const e = err as { code?: number | string; type?: string; message?: string; status?: number } | undefined;
  const msg = (e?.message || "").toLowerCase();
  const code = String(e?.code || "").toLowerCase();
  const status = e?.status || (typeof e?.code === "number" ? e.code : undefined);

  if (
    code === "email_not_confirmed" ||
    code === "email_not_verified" ||
    msg.includes("email not confirmed") ||
    msg.includes("email not verified")
  ) {
    return "لم يتم تأكيد البريد الإلكتروني بعد. افتح رسالة التأكيد أو أعد إرسالها ثم حاول تسجيل الدخول.";
  }
  if (
    status === 401 ||
    e?.type === "user_invalid_credentials" ||
    code === "invalid_credentials" ||
    code === "invalid_grant" ||
    msg.includes("invalid login credentials") ||
    msg.includes("invalid credentials")
  ) {
    return "البريد الإلكتروني أو كلمة المرور غير صحيحة.";
  }
  if (
    status === 409 ||
    e?.type === "user_already_exists" ||
    code === "user_already_exists" ||
    msg.includes("already registered") ||
    msg.includes("already exists")
  ) {
    return "هذا البريد مسجّل بالفعل — جرّب تسجيل الدخول.";
  }
  if (status === 429 || code === "over_request_rate_limit" || msg.includes("rate limit")) {
    return "محاولات كثيرة. انتظر قليلًا ثم حاول مجددًا.";
  }
  return fallback;
}
