import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authenticateAdmin } from "@/lib/server/adminAuth";
import { createAdminClient } from "@/lib/supabase/server";
import { sendPlatformEmail } from "@/lib/server/sendPlatformEmail";
import { resolveSiteUrl } from "@/functions/shared/emailTemplates";
import { unsubscribeKeyFromEnv } from "@/lib/server/unsubscribeToken";
import { isTestAccount } from "@/lib/server/testAccounts";
import { runNewsCampaign } from "@/lib/launch/newsCampaign";
import { createNewsCampaignDeps } from "@/lib/launch/newsCampaignWiring";
import { acquireLaunchLock, releaseLaunchLock } from "@/lib/launch/launchLock";

export const dynamic = "force-dynamic";
/** One call sends at most what fits in this time (the runner stops cleanly at its own 45 s budget); a larger audience is sent in repeated calls. */
export const maxDuration = 60;

const schema = z.object({
  campaign: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, "اسم الحملة غير صالح"),
  cap: z.number().int().min(1, "الحد الأقصى مطلوب"),
  dryRun: z.boolean().optional(),
  confirm: z.string().max(200).optional(),
  /** Extra user ids to leave out (on top of the shared test-account rule). */
  excludeUserIds: z.array(z.string().min(1).max(128)).max(5000).optional(),
  /** A bounded test send to the owner's own accounts (1 to 5 ids): ONLY these may be mailed, and the test-account exclusion is lifted for them. Every other check (opt-in, confirmed address, guest, suppression, mark) still applies. */
  onlyUserIds: z.array(z.string().min(1).max(128)).min(1).max(5).optional(),
  /** Addresses the owner knows are suppressed (bounced / complained); matched case-insensitively and never echoed back. */
  suppressedEmails: z.array(z.string().min(3).max(254)).max(20000).optional(),
});

/**
 * Admin-only: the launch announcement. DOUBLE LOCK: a real send (`dryRun: false`) is refused unless the server environment variable
 * LAUNCH_EMAIL_ENABLED is exactly `on` (unset = off, so deploying this changes nothing) AND the body carries the exact confirmation
 * `SEND <campaign> <cap>`. A dry run is always allowed and returns the genuine eligible count; it changes nothing and sends nothing.
 * The audit log records counts only, never an address or a body.
 */
export async function POST(req: NextRequest) {
  const auth = await authenticateAdmin(req);
  if (!auth.ok) return auth.response;
  const { ctx } = auth;

  let raw: unknown;
  try { raw = await req.json(); } catch { return NextResponse.json({ success: false, error: "body غير صالح" }, { status: 400 }); }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return NextResponse.json({ success: false, error: parsed.error.issues[0]?.message || "مدخلات غير صالحة" }, { status: 400 });
  const body = parsed.data;
  const dryRun = body.dryRun !== false;

  const signingKey = unsubscribeKeyFromEnv();
  const siteUrl = resolveSiteUrl();
  if (!dryRun) {
    if (process.env.LAUNCH_EMAIL_ENABLED !== "on") {
      await ctx.audit("launch-email", "refused: LAUNCH_EMAIL_ENABLED is off", body.campaign);
      return NextResponse.json({ success: false, error: "إرسال بريد الإطلاق مقفل (LAUNCH_EMAIL_ENABLED ليس on). التشغيل التجريبي متاح دائمًا." }, { status: 403 });
    }
    if (!signingKey || !siteUrl.startsWith("https://")) {
      return NextResponse.json({ success: false, error: "إعداد الإرسال ناقص: مفتاح الخادم أو عنوان الموقع (https)." }, { status: 500 });
    }
  }

  let admin: any;
  try { admin = createAdminClient(); } catch { return NextResponse.json({ success: false, error: "تعذّر الاتصال بخدمة الحسابات." }, { status: 500 }); }

  const deps = createNewsCampaignDeps({
    admin,
    env: process.env,
    siteUrl,
    signingKey,
    send: (i) => sendPlatformEmail("news", i.to, i.vars, i.idempotencyKey, { unsubscribeUrl: i.unsubscribeUrl }),
    testAccountIds: new Set(body.excludeUserIds ?? []),
    // a bounded seed send names its recipients itself; otherwise the shared test-account rule keeps test accounts out
    isTestAccount: body.onlyUserIds ? undefined : (u) => isTestAccount({ id: u.id, email: u.email ?? null }),
    onlyUserIds: body.onlyUserIds ? new Set(body.onlyUserIds) : undefined,
    suppressed: new Set((body.suppressedEmails ?? []).map((e) => e.trim().toLowerCase())),
  });

  // A REAL run is the only one at a time (the per-recipient claim is not atomic): a second request while one is running is refused BEFORE anything is claimed.
  const holder = crypto.randomUUID();
  if (!dryRun && !(await acquireLaunchLock(admin, body.campaign, holder))) {
    await ctx.audit("launch-email", "refused: another run holds the lock", body.campaign);
    return NextResponse.json({ success: false, error: "حملة الإطلاق تعمل الآن أو لم يتأكد القفل. لا يُسمح بتشغيلين معًا: انتظر انتهاء التشغيل الحالي (أو مرور دقيقتين ونصف إن توقف)." }, { status: 409 });
  }
  let result: Awaited<ReturnType<typeof runNewsCampaign>>;
  try {
    result = await runNewsCampaign(deps, { campaign: body.campaign, cap: body.cap, dryRun, confirm: body.confirm });
  } finally {
    if (!dryRun) await releaseLaunchLock(admin, body.campaign, holder);
  }

  await ctx.audit(
    "launch-email",
    `${result.mode} eligible=${result.eligible} sent=${result.sent} ambiguous=${result.ambiguous} failed=${result.failed} cap=${result.cap}${result.stopped ? ` stopped=${result.stopped}` : ""}${result.refused ? ` refused=${result.refused}` : ""}`,
    body.campaign,
  );
  return NextResponse.json({ success: result.mode !== "refused", result }, { status: result.mode === "refused" ? 400 : 200 });
}
