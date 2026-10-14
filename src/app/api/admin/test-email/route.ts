import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authenticateAdmin } from "@/lib/server/adminAuth";
import { renderEmailTemplate, type PlatformEmailTemplateId } from "@/functions/shared/emailTemplates";
import { sendPlatformEmail } from "@/lib/server/sendPlatformEmail";

export const dynamic = "force-dynamic";

const TEMPLATE_IDS: PlatformEmailTemplateId[] = [
  "welcome",
  "topup-received",
  "topup-approved",
  "topup-rejected",
  "job-done",
  "refund",
];

const testEmailSchema = z.object({
  template: z.enum(TEMPLATE_IDS as [PlatformEmailTemplateId, ...PlatformEmailTemplateId[]]),
  userId: z.string().min(1, "userId مطلوب"),
  vars: z.record(z.string(), z.string()).optional(),
});

/**
 * Admin-only: send one branded platform email template to an existing user (by userId).
 * Used to verify the logo + template rendering in a real inbox before/after deploy.
 * Supabase Edge Function (Resend) delivers to the user's registered email; there is no
 * arbitrary recipient address here by design.
 */
export async function POST(req: NextRequest) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;
  const { users } = auth.ctx;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ success: false, error: "body غير صالح" }, { status: 400 });
  }
  const parsed = testEmailSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: parsed.error.issues[0]?.message || "مدخلات غير صالحة" }, { status: 400 });
  }
  const { template, userId, vars } = parsed.data;

  let target: any;
  try {
    target = await users.get({ userId });
  } catch {
    return NextResponse.json({ success: false, error: "المستخدم غير موجود" }, { status: 404 });
  }
  if (!target.email) {
    return NextResponse.json({ success: false, error: "المستخدم ليس لديه بريد إلكتروني مسجّل" }, { status: 400 });
  }

  const { subject } = renderEmailTemplate(template, { Name: target.name || "مستخدم", ...vars });
  await sendPlatformEmail(template, target.email, { Name: target.name || "مستخدم", ...(vars ?? {}) });

  return NextResponse.json({ success: true, template, to: target.email, subject });
}
