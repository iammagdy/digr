import { NextRequest, NextResponse } from "next/server";
import { createServerSideClient, createAdminClient } from "../../../../lib/supabase/server";

export const dynamic = "force-dynamic";

const GRACE_DAYS = 30;

export async function POST(req: NextRequest) {
  try {
    // 1. Authenticate user strictly via Supabase Auth
    const supabase = await createServerSideClient();
    const authHeader = req.headers.get("authorization");
    let user = null;

    if (authHeader?.startsWith("Bearer ")) {
      const token = authHeader.substring(7).trim();
      const { data, error } = await supabase.auth.getUser(token);
      if (!error && data?.user) {
        user = data.user;
      }
    } else {
      const { data, error } = await supabase.auth.getUser();
      if (!error && data?.user) {
        user = data.user;
      }
    }

    if (!user) {
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

    // 3. Mark deletion_scheduled_for strictly in public.profiles (clients cannot edit this column)
    // NOTE: We do NOT store deletion date in auth user_metadata because users can edit user_metadata!
    const { error: profileErr } = await adminClient
      .from("profiles")
      .update({
        deletion_scheduled_for: scheduledFor,
        updated_at: new Date().toISOString(),
      })
      .eq("id", user.id);

    if (profileErr) {
      console.error("Failed to update profile deletion_scheduled_for:", profileErr);
      return NextResponse.json(
        { success: false, error: "تعذّر تسجيل طلب الحذف في الملف الشخصي." },
        { status: 500 }
      );
    }

    // 4. Revoke sessions and disable/ban user login immediately
    try {
      await adminClient.auth.admin.updateUserById(user.id, {
        ban_duration: `${GRACE_DAYS * 24}h`,
      });
      await adminClient.auth.admin.signOut(user.id, "global");
    } catch (authErr) {
      console.warn("Failed to ban/signOut user during deletion request:", authErr);
    }

    // 5. Audit log entry
    try {
      const auditRes = await adminClient.from("admin_audit_log").insert({
        actor_id: user.id,
        action: "account_delete_requested",
        target_type: "user",
        target_id: user.id,
        details: {
          scheduledFor,
          ip: req.headers.get("x-forwarded-for") || req.headers.get("x-real-ip") || "unknown",
        },
      });
      if (auditRes?.error) {
        console.error(
          `[account_delete:audit_insert_failed] reason=db_error code=${
            auditRes.error.code || "unknown"
          }`
        );
      }
    } catch (auditErr: any) {
      console.error(
        `[account_delete:audit_insert_failed] reason=exception code=${
          auditErr?.code || "unknown"
        }`
      );
    }

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
