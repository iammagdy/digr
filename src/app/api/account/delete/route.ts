import { NextRequest, NextResponse } from "next/server";
import { createServerSideClient, createAdminClient } from "../../../../lib/supabase/server";

export const dynamic = "force-dynamic";

const GRACE_DAYS = 30;

export async function POST(req: NextRequest) {
  try {
    // 1. Authenticate user strictly via Supabase Auth
    const supabase = await createServerSideClient();
    const {
      data: { user },
      error: authErr,
    } = await supabase.auth.getUser();

    if (authErr || !user) {
      return NextResponse.json(
        { success: false, error: "غير مصرح. يرجى تسجيل الدخول أولاً." },
        { status: 401 }
      );
    }

    // 2. Validate confirmation payload
    const body = await req.json().catch(() => ({}));
    if (String(body?.confirm ?? "").trim() !== "حذف") {
      return NextResponse.json(
        { success: false, error: "اكتب «حذف» للتأكيد" },
        { status: 400 }
      );
    }

    const scheduledFor = new Date(Date.now() + GRACE_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const adminClient = createAdminClient();

    // 3. Mark deletion_scheduled_for in public.profiles
    const { error: profileErr } = await adminClient
      .from("profiles")
      .update({ deletion_scheduled_for: scheduledFor })
      .eq("id", user.id);

    if (profileErr) {
      console.error("Failed to update profile deletion_scheduled_for:", profileErr);
      return NextResponse.json(
        { success: false, error: "تعذّر تسجيل طلب الحذف في الملف الشخصي." },
        { status: 500 }
      );
    }

    // 4. Update auth user metadata
    await adminClient.auth.admin.updateUserById(user.id, {
      user_metadata: {
        ...user.user_metadata,
        deletion_scheduled_for: scheduledFor,
      },
    });

    // 5. Audit log entry
    try {
      await adminClient.from("admin_audit_log").insert({
        actor_id: user.id,
        action: "account_delete_requested",
        target_type: "user",
        target_id: user.id,
        details: {
          scheduledFor,
          ip: req.headers.get("x-forwarded-for") || req.headers.get("x-real-ip") || "unknown",
        },
      });
    } catch {}

    return NextResponse.json({
      success: true,
      scheduledFor,
      messageAr: "تم جدولة حذف الحساب بنجاح خلال 30 يوماً.",
    });
  } catch (err: any) {
    console.error("Account delete route error:", err);
    return NextResponse.json(
      { success: false, error: err.message || "تعذّر تنفيذ طلب حذف الحساب." },
      { status: 500 }
    );
  }
}
