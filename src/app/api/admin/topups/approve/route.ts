import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createServerSideClient, createAdminClient } from "@/lib/supabase/server";
import { applyTopup, getBalance } from "@/lib/supabase/ledger";
import { sendPlatformEmail, getRecipient } from "@/lib/server/sendPlatformEmail";
import { normalizeDigits, toArabicDigits } from "@/lib/arabicDigits";
import { callAtomicOrFallback } from "@/functions/shared/atomicRpc";

export const dynamic = "force-dynamic";

const approveSchema = z.object({
  topupId: z.string().min(1),
  action: z.enum(["approve", "reject"]),
  confirmedAmountEgp: z.preprocess(
    (v) => (typeof v === "string" ? Number(normalizeDigits(v)) : v),
    z.number().positive().optional()
  ),
  rejectReason: z.string().trim().min(3, "سبب الرفض مطلوب").max(256).optional(),
});

export async function POST(req: NextRequest) {
  try {
    // 1. Authenticate caller strictly as Admin via Supabase app_metadata
    const supabase = await createServerSideClient();
    const { data: { user }, error: authErr } = await supabase.auth.getUser();

    if (authErr || !user) {
      return NextResponse.json({ success: false, error: "غير مصرح" }, { status: 401 });
    }

    const isAdmin = user.app_metadata?.role === "admin";
    if (!isAdmin) {
      return NextResponse.json(
        { success: false, error: "هذا الإجراء مخصص للمسؤولين فقط" },
        { status: 403 }
      );
    }

    const rawBody = await req.json().catch(() => ({}));
    const { topupId, action, confirmedAmountEgp, rejectReason } = approveSchema.parse(rawBody);

    if (action === "reject" && !rejectReason) {
      return NextResponse.json(
        { success: false, error: "سبب الرفض مطلوب" },
        { status: 400 }
      );
    }

    const adminClient = createAdminClient();

    // 2. Fetch topup row
    const { data: topup, error: topupErr } = await adminClient
      .from("topups")
      .select("*")
      .eq("id", topupId)
      .single();

    if (topupErr || !topup) {
      return NextResponse.json(
        { success: false, error: "طلب الشحن غير موجود" },
        { status: 404 }
      );
    }

    if (topup.status !== "pending") {
      return NextResponse.json(
        { success: false, error: "تمت مراجعة هذا الطلب مسبقاً" },
        { status: 400 }
      );
    }

    const now = new Date().toISOString();
    const egp = (n: number) => `${toArabicDigits(Math.round(n))} ج.م`;

    if (action === "approve") {
      const effectiveAmount = confirmedAmountEgp || Number(topup.amount_egp);
      const approval = await callAtomicOrFallback<any>({
        rpc: () => Promise.resolve(adminClient.rpc("approve_topup_atomic", {
          p_topup_id: topupId,
          p_confirmed_amount_egp: confirmedAmountEgp ?? null,
        })),
        functionName: "approve_topup_atomic",
        fallback: async () => {
          const { data: settingsPub } = await adminClient.from("settings_public")
            .select("value").eq("key", "pricing").maybeSingle();
          const creditValueEgp = Number(settingsPub?.value?.creditValueEgp) || 0.1;
          const credits = Math.floor(effectiveAmount / creditValueEgp);
          await applyTopup(adminClient, topup.user_id, topupId, credits,
            `شحن عبر انستاباي (مرجع: ${topup.reference})`);
          const { error: statusError } = await adminClient.from("topups")
            .update({ status: "approved" }).eq("id", topupId);
          if (statusError) throw statusError;
          return { success: true, credits, effective_amount_egp: effectiveAmount };
        },
        log: (line) => console.warn(line),
      });
      if (!approval.data?.success) {
        return NextResponse.json({ success: false, error: "تعذر اعتماد طلب الشحن" }, { status: 409 });
      }
      const credits = Number(approval.data.credits) || 0;
      const confirmedAmount = Number(approval.data.effective_amount_egp ?? effectiveAmount);

      // 6. User notification
      await adminClient.from("notifications").insert({
        id: `notif_${topupId}`,
        user_id: topup.user_id,
        title: "تم اعتماد شحن رصيدك",
          body: `أُضيف ${toArabicDigits(credits)} نقطة إلى محفظتك (${egp(confirmedAmount)}).`,
        link: "/dashboard/topup",
        read: false,
        created_at: now,
      });

      // Email: topup-approved (never blocks or fails the request)
      try {
        const rcpt = await getRecipient(adminClient, topup.user_id, "topup-approved");
        if (rcpt) {
          const balance = Number(approval.data.balance) || await getBalance(adminClient, topup.user_id);
          await sendPlatformEmail("topup-approved", rcpt.email, {
            Name: rcpt.name,
            Credits: toArabicDigits(credits),
            ConfirmedAmountEgp: toArabicDigits(confirmedAmount),
            Reference: toArabicDigits(topup.reference),
            Balance: toArabicDigits(balance),
          }, `topup-approved:${topupId}`);
        }
      } catch (emailErr) {
        console.error("[email:topup-approved_failed]", emailErr);
      }

      // 7. Admin audit log
      await adminClient.from("admin_audit_log").insert({
        actor_id: user.id,
        action: "approve_topup",
        target_type: "topup",
        target_id: topupId,
        details: {
          amountEgp: confirmedAmount,
          credits,
          userId: topup.user_id,
        },
        created_at: now,
      });

      return NextResponse.json({
        success: true,
        messageAr: `تم اعتماد شحن الرصيد بنجاح (+${toArabicDigits(credits)} نقطة).`,
      });
    }

    if (action === "reject") {
      if (!rejectReason) {
        return NextResponse.json(
          { success: false, error: "سبب الرفض مطلوب" },
          { status: 400 }
        );
      }
      const confirmedRejectReason: string = rejectReason;

      const rejection = await callAtomicOrFallback<any>({
        rpc: () => Promise.resolve(adminClient.rpc("reject_topup_atomic", { p_topup_id: topupId })),
        functionName: "reject_topup_atomic",
        fallback: async () => {
          const { error } = await adminClient.from("topups")
            .update({ status: "rejected" }).eq("id", topupId);
          if (error) throw error;
          return { success: true };
        },
        log: (line) => console.warn(line),
      });
      if (!rejection.data?.success) {
        return NextResponse.json({ success: false, error: "تعذر رفض طلب الشحن" }, { status: 409 });
      }

      // User notification
      await adminClient.from("notifications").insert({
        id: `notif_${topupId}`,
        user_id: topup.user_id,
        title: "تم رفض طلب الشحن",
        body: `تم رفض طلب الشحن (مرجع: ${topup.reference}). السبب: ${confirmedRejectReason}`,
        link: "/dashboard/topup",
        read: false,
        created_at: now,
      });

      // Email: topup-rejected (never blocks or fails the request)
      try {
        const rcpt = await getRecipient(adminClient, topup.user_id, "topup-rejected");
        if (rcpt) {
          await sendPlatformEmail("topup-rejected", rcpt.email, {
            Name: rcpt.name,
            AmountEgp: String(topup.amount_egp),
            Reference: topup.reference,
            RejectReason: confirmedRejectReason,
          });
        }
      } catch (emailErr) {
        console.error("[email:topup-rejected_failed]", emailErr);
      }

      // Admin audit log
      await adminClient.from("admin_audit_log").insert({
        actor_id: user.id,
        action: "reject_topup",
        target_type: "topup",
        target_id: topupId,
        details: {
          rejectReason,
          userId: topup.user_id,
        },
        created_at: now,
      });

      return NextResponse.json({
        success: true,
        messageAr: "تم رفض طلب الشحن.",
      });
    }

    return NextResponse.json({ success: false, error: "إجراء غير صالح" }, { status: 400 });
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return NextResponse.json(
        { success: false, error: err.issues[0]?.message || "بيانات غير صالحة" },
        { status: 400 }
      );
    }
    console.error("Approve topup error:", err);
    return NextResponse.json(
      { success: false, error: err.message || "حدث خطأ غير متوقع" },
      { status: 500 }
    );
  }
}
