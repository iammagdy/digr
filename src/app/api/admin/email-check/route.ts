import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authenticateAdmin } from "@/lib/server/adminAuth";
import { longJobDriverMode } from "@/lib/driverMode";
import { renderEmailTemplate } from "../../../../../supabase/functions/send-email/templates";
import { sendPlatformEmail } from "@/lib/server/sendPlatformEmail";
import {
  buildTestEmail,
  emailConfigStatus,
  FUNCTION_PROBE_LABEL_AR,
  probeSendEmailFunction,
  SEND_FAILURE_LABEL_AR,
  TEST_EMAIL_KINDS,
} from "@/lib/server/emailCheck";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ kind: z.enum(TEST_EMAIL_KINDS) });

const siteUrl = () => (process.env.NEXT_PUBLIC_SITE_URL || "https://diger.tech").replace(/\/+$/, "");

/**
 * Admin only. GET: a diagnosis of customer e-mail (booleans and a verdict; never a secret or a value). POST {kind}: sends ONE test e-mail
 * (completion, partial completion, failure or start) to the signed-in admin's OWN address, built by the same code as the customer's e-mail,
 * and answers with the real result: sent, or the fixed reason it was not. No arbitrary recipient exists here by design.
 */
export async function GET(req: NextRequest) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;
  const config = emailConfigStatus();
  const probe = await probeSendEmailFunction();
  return NextResponse.json({
    success: true,
    config,
    function: { state: probe, labelAr: FUNCTION_PROBE_LABEL_AR[probe] },
    driver: { mode: longJobDriverMode() },
    senderAr: "المُرسِل ثابت: Diger <noreply@diger.tech>، ومفتاح الإرسال RESEND_API_KEY يُقرأ من أسرار دالة البريد على Supabase فقط.",
  });
}

export async function POST(req: NextRequest) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;
  const { adminId, adminEmail, adminName } = auth.ctx;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ success: false, error: "body غير صالح" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ success: false, error: "نوع الرسالة غير معروف" }, { status: 400 });
  if (!adminEmail || !adminEmail.includes("@")) {
    return NextResponse.json({ success: false, error: "حساب الإدارة ليس عليه بريد إلكتروني." }, { status: 400 });
  }

  const email = buildTestEmail(parsed.data.kind, adminName || "الإدارة", siteUrl());
  const { subject } = renderEmailTemplate(email.template, email.vars);
  const result = await sendPlatformEmail(email.template, adminEmail, email.vars, `admin-test:${adminId}:${Date.now()}`);
  return NextResponse.json({
    success: result.ok,
    kind: parsed.data.kind,
    template: email.template,
    subject,
    ...(result.ok ? {} : { reason: result.reason, reasonAr: SEND_FAILURE_LABEL_AR[result.reason!] }),
  });
}
