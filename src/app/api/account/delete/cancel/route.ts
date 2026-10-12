import { NextRequest, NextResponse } from "next/server";
import { createServerSideClient, createAdminClient } from "../../../../../lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * Cancel Account Deletion during the 30-day grace period.
 * Allows a user who requested deletion to reactivate their account
 * before the watchdog permanently anonymizes it.
 */
export async function POST(req: NextRequest) {
  try {
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

    const adminClient = createAdminClient();

    // Check if account has a scheduled deletion
    const { data: profile, error: profErr } = await adminClient
      .from("profiles")
      .select("deletion_scheduled_for")
      .eq("id", user.id)
      .single();

    if (profErr || !profile) {
      return NextResponse.json(
        { success: false, error: "الملف الشخصي غير موجود." },
        { status: 404 }
      );
    }

    if (!profile.deletion_scheduled_for) {
      return NextResponse.json(
        { success: false, error: "لا يوجد طلب حذف معلق لهذا الحساب." },
        { status: 400 }
      );
    }

    // 1. Clear deletion_scheduled_for in profiles
    const { error: updateProfErr } = await adminClient
      .from("profiles")
      .update({
        deletion_scheduled_for: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", user.id);

    if (updateProfErr) {
      throw updateProfErr;
    }

    // 2. Unban the auth user
    await adminClient.auth.admin.updateUserById(user.id, {
      ban_duration: "none",
    });

    return NextResponse.json({
      success: true,
      message: "تم إلغاء طلب حذف الحساب بنجاح واستعادة الحساب بالكامل.",
    });
  } catch (err: any) {
    console.error("Cancel account deletion error:", err);
    return NextResponse.json(
      { success: false, error: "حدث خطأ أثناء إلغاء طلب الحذف. يرجى المحاولة لاحقاً." },
      { status: 500 }
    );
  }
}
