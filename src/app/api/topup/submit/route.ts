import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import crypto from "crypto";
import { createServerSideClient, createAdminClient } from "@/lib/supabase/server";
import {
  sendPlatformEmail,
  resolveDisplayName,
  formatArabicDate,
  isEmailPreferenceEnabled,
} from "@/lib/server/sendPlatformEmail";
import {
  normalizeDigits,
  normalizePhone,
  normalizeSenderName,
  toArabicDigits,
} from "@/lib/arabicDigits";
import { RECEIPTS_BUCKET } from "@/lib/constants";
import { TOPUP_ERROR_MESSAGES } from "@/lib/topupErrors";

export const dynamic = "force-dynamic";

const DEFAULT_MAX_PENDING = 3;
const MAX_RECEIPT_BYTES = 5 * 1024 * 1024;

const submitTopupSchema = z.object({
  amountEgp: z.preprocess(
    (v) => (typeof v === "string" ? Number(normalizeDigits(v)) : v),
    z.number().positive("المبلغ يجب أن يكون أكبر من صفر")
  ),
  receiptFileId: z.string().min(1, TOPUP_ERROR_MESSAGES.receipt_missing),
  senderName: z.preprocess(
    (v) => (typeof v === "string" ? normalizeSenderName(v) : v),
    z.string().max(120).optional()
  ),
  senderPhone: z.preprocess(
    (v) => (typeof v === "string" ? normalizePhone(v) : v),
    z.string().max(32).optional()
  ),
  reference: z.string().optional(),
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
        { success: false, reason: "unauthorized", error: TOPUP_ERROR_MESSAGES.unauthorized },
        { status: 401 }
      );
    }

    // Email verification check
    const emailVerified = !!user.email_confirmed_at || user.user_metadata?.email_verified === true;
    if (!emailVerified) {
      return NextResponse.json(
        { success: false, reason: "email_not_verified", error: TOPUP_ERROR_MESSAGES.email_not_verified },
        { status: 403 }
      );
    }

    const rawBody = await req.json().catch(() => ({}));
    const validated = submitTopupSchema.parse(rawBody);

    // Validate receiptFileId belongs to authenticated user and has no directory traversal
    if (
      !validated.receiptFileId ||
      !validated.receiptFileId.startsWith(`${user.id}/`) ||
      validated.receiptFileId.includes("..")
    ) {
      return NextResponse.json(
        { success: false, reason: "invalid_file_owner", error: TOPUP_ERROR_MESSAGES.invalid_file_owner },
        { status: 400 }
      );
    }

    const adminClient = createAdminClient();

    // 2. Validate IPA configuration
    const { data: pricingSetting } = await adminClient
      .from("settings_public")
      .select("value")
      .eq("key", "pricing")
      .maybeSingle();

    const ipa = pricingSetting?.value?.ipa?.trim() || process.env.NEXT_PUBLIC_INSTAPAY_HANDLE?.trim();
    if (!ipa) {
      return NextResponse.json(
        {
          success: false,
          reason: "payment_details_not_configured",
          error: TOPUP_ERROR_MESSAGES.payment_details_not_configured,
        },
        { status: 400 }
      );
    }

    // 3. Cap on pending top-ups per user
    let maxPending = DEFAULT_MAX_PENDING;
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
          reason: "pending_limit_reached",
          error: `لديك ${toArabicDigits(maxPending)} طلبات شحن معلقة بالفعل. يرجى انتظار معالجتها قبل تقديم طلب جديد.`,
        },
        { status: 400 }
      );
    }

    // 4. Download receipt file from storage and compute SHA-256 hash
    const { data: fileBlob, error: dlErr } = await adminClient.storage
      .from(RECEIPTS_BUCKET)
      .download(validated.receiptFileId);

    if (dlErr || !fileBlob) {
      return NextResponse.json(
        { success: false, reason: "receipt_missing", error: TOPUP_ERROR_MESSAGES.receipt_missing },
        { status: 400 }
      );
    }

    const fileBuffer = Buffer.from(await fileBlob.arrayBuffer());
    if (fileBuffer.length === 0) {
      return NextResponse.json(
        { success: false, reason: "receipt_missing", error: TOPUP_ERROR_MESSAGES.receipt_missing },
        { status: 400 }
      );
    }

    if (fileBuffer.length > MAX_RECEIPT_BYTES) {
      return NextResponse.json(
        { success: false, reason: "file_oversized", error: TOPUP_ERROR_MESSAGES.file_oversized },
        { status: 400 }
      );
    }

    const receiptHash = crypto.createHash("sha256").update(fileBuffer).digest("hex");
    const reference = `rcpt_${receiptHash}`;

    // 5. Unique receipt content check (deduplication)
    const { data: existingRef } = await adminClient
      .from("topups")
      .select("id")
      .eq("reference", reference)
      .maybeSingle();

    if (existingRef) {
      return NextResponse.json(
        {
          success: false,
          reason: "duplicate_receipt",
          error: TOPUP_ERROR_MESSAGES.duplicate_receipt,
        },
        { status: 400 }
      );
    }

    // 6. Graceful fallbacks for sender name and phone to satisfy schema without burdening user
    const resolvedSenderName =
      validated.senderName?.trim() ||
      resolveDisplayName(user) ||
      "عميل Diger";
    const resolvedSenderPhone =
      validated.senderPhone?.trim() ||
      user.user_metadata?.phone ||
      user.phone ||
      "غير مسجل";

    // 7. Insert Topup Row via Service Role (Clients forbidden from direct table insert by RLS)
    const topupId = `topup_${crypto.randomBytes(12).toString("hex")}`;
    const { data: newTopup, error: insertErr } = await adminClient
      .from("topups")
      .insert({
        id: topupId,
        user_id: user.id,
        amount_egp: validated.amountEgp,
        reference,
        sender_name: resolvedSenderName,
        sender_phone: resolvedSenderPhone,
        receipt_file_id: validated.receiptFileId,
        status: "pending",
        created_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (insertErr || !newTopup) {
      if (insertErr?.code === "23505") {
        return NextResponse.json(
          {
            success: false,
            reason: "duplicate_receipt",
            error: TOPUP_ERROR_MESSAGES.duplicate_receipt,
          },
          { status: 400 }
        );
      }
      console.error("Topup insertion error:", insertErr);
      return NextResponse.json(
        { success: false, reason: "server_error", error: TOPUP_ERROR_MESSAGES.server_error },
        { status: 500 }
      );
    }

    // 8. Email: topup-received (never blocks or fails the request)
    try {
      if (user.email && isEmailPreferenceEnabled("topup-received", user.user_metadata)) {
        const creditValueEgp =
          typeof pricingSetting?.value?.creditValueEgp === "number" &&
          pricingSetting.value.creditValueEgp > 0
            ? pricingSetting.value.creditValueEgp
            : 0.1;
        const expectedCredits = Math.floor(validated.amountEgp / creditValueEgp);
        await sendPlatformEmail("topup-received", user.email, {
          Name: resolveDisplayName(user),
          AmountEgp: String(validated.amountEgp),
          Credits: String(expectedCredits),
          Reference: reference,
          CreatedAt: formatArabicDate(newTopup.created_at),
        });
      } else if (user.email) {
        console.log(`[email:preference_disabled] template=topup-received category=topup userId=${user.id}`);
      }
    } catch (emailErr) {
      console.error("[email:topup-received_failed]", emailErr);
    }

    return NextResponse.json({
      success: true,
      topupId: newTopup.id,
      reference,
      messageAr: "تم استلام طلب الشحن بنجاح وستتم مراجعته وتأكيده قريباً.",
    });
  } catch (err: any) {
    if (err instanceof z.ZodError) {
      return NextResponse.json(
        { success: false, reason: "validation_error", error: err.issues[0]?.message || "بيانات غير صالحة" },
        { status: 400 }
      );
    }
    console.error("Submit topup error:", err);
    return NextResponse.json(
      { success: false, reason: "server_error", error: TOPUP_ERROR_MESSAGES.server_error },
      { status: 500 }
    );
  }
}
