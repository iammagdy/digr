import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createServerSideClient, createAdminClient } from "@/lib/supabase/server";
import {
  EG_MOBILE_RE,
  isThreePartName,
  normalizeDigits,
  normalizePhone,
  normalizeSenderName,
} from "@/lib/arabicDigits";
import crypto from "crypto";

export const dynamic = "force-dynamic";

const DEFAULT_MAX_PENDING = 3;

const submitTopupSchema = z.object({
  amountEgp: z.preprocess(
    (v) => (typeof v === "string" ? Number(normalizeDigits(v)) : v),
    z.number().positive("المبلغ يجب أن يكون أكبر من صفر")
  ),
  reference: z.preprocess(
    (v) => (typeof v === "string" ? normalizeDigits(v).trim() : v),
    z.string().min(3, "رقم العملية مطلوب").max(128, "رقم العملية مطلوب")
  ),
  senderName: z.preprocess(
    (v) => (typeof v === "string" ? normalizeSenderName(v) : v),
    z.string()
      .max(120, "اكتب اسم المحوِّل الثلاثي كما يظهر في إنستاباي")
      .refine(isThreePartName, "اكتب اسم المحوِّل الثلاثي كما يظهر في إنستاباي")
  ),
  senderPhone: z.preprocess(
    (v) => (typeof v === "string" ? normalizePhone(v) : v),
    z.string().regex(EG_MOBILE_RE, "رقم الموبايل غير صحيح — ١١ رقمًا يبدأ بـ 01")
  ),
  receiptFileId: z.string().min(1, "صورة إيصال التحويل مطلوبة لمراجعة الطلب"),
});

export async function POST(req: NextRequest) {
  try {
    // 1. Authenticate user strictly via Supabase
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
        { success: false, error: "غير مصرح — يرجى تسجيل الدخول أولاً" },
        { status: 401 }
      );
    }

    // Email verification check
    const emailVerified = !!user.email_confirmed_at || user.user_metadata?.email_verified === true;
    if (!emailVerified) {
      return NextResponse.json(
        { success: false, error: "يرجى تأكيد بريدك الإلكتروني أولاً قبل شحن الرصيد." },
        { status: 403 }
      );
    }

    const rawBody = await req.json().catch(() => ({}));
    const validated = submitTopupSchema.parse(rawBody);

    const adminClient = createAdminClient();

    // 2. Cap on pending top-ups per user
    let maxPending = DEFAULT_MAX_PENDING;
    const { data: pricingSetting } = await adminClient
      .from("settings_public")
      .select("value")
      .eq("key", "pricing")
      .maybeSingle();

    if (pricingSetting?.value?.maxPendingTopups && Number.isInteger(pricingSetting.value.maxPendingTopups)) {
      maxPending = pricingSetting.value.maxPendingTopups;
    }

    const { count: pendingCount, error: countErr } = await adminClient
      .from("topups")
      .select("*", { count: "exact", head: true })
      .eq("user_id", user.id)
      .eq("status", "pending");

    if (!countErr && typeof pendingCount === "number" && pendingCount >= maxPending) {
      return NextResponse.json(
        {
          success: false,
          error: `لديك ${maxPending} طلبات شحن معلقة بالفعل. يرجى انتظار معالجتها قبل تقديم طلب جديد.`,
        },
        { status: 400 }
      );
    }

    // 3. Unique reference check
    const { data: existingRef } = await adminClient
      .from("topups")
      .select("id")
      .eq("reference", validated.reference)
      .maybeSingle();

    if (existingRef) {
      return NextResponse.json(
        {
          success: false,
          error: "رقم العملية مسجل بالفعل في طلب سابق. إذا كنت تعتقد أن هناك خطأ، تواصل مع الدعم.",
        },
        { status: 400 }
      );
    }

    // 4. Insert Topup Row via Service Role (Clients forbidden from direct table insert by RLS)
    const topupId = `topup_${crypto.randomBytes(12).toString("hex")}`;
    const { data: newTopup, error: insertErr } = await adminClient
      .from("topups")
      .insert({
        id: topupId,
        user_id: user.id,
        amount_egp: validated.amountEgp,
        reference: validated.reference,
        sender_name: validated.senderName,
        sender_phone: validated.senderPhone,
        receipt_file_id: validated.receiptFileId,
        status: "pending",
        created_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (insertErr || !newTopup) {
      console.error("Topup insertion error:", insertErr);
      return NextResponse.json(
        { success: false, error: "تعذر تسجيل طلب الشحن. حاول مجدداً." },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      topupId: newTopup.id,
      messageAr: "تم استلام طلب الشحن بنجاح وستتم مراجعته وتأكيده قريباً.",
    });
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return NextResponse.json(
        { success: false, error: err.issues[0]?.message || "بيانات غير صالحة" },
        { status: 400 }
      );
    }
    console.error("Submit topup error:", err);
    return NextResponse.json(
      { success: false, error: err.message || "حدث خطأ غير متوقع" },
      { status: 500 }
    );
  }
}
