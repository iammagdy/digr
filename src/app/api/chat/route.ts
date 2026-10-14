import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { ChatHandler } from "../../../functions/shared/chatHandler";
import { setLastLlmFallbackReason } from "../../../functions/shared/llmClient";
import {
  checkUserRateLimits,
  checkGlobalDailySpendCap,
  checkMessageLength,
  type RateLimitCheckResult,
} from "../../../functions/shared/rateLimits";
import {
  formatStructuredClarificationAnswers,
  validateStructuredClarificationAnswers,
} from "../../../functions/shared/clarification";
import { createServerSideClient, createAdminClient } from "../../../lib/supabase/server";
import { parseExclusionFile } from "../../../lib/server/exclusionFileParser";
import { sanitizeCustomerErrorMessage } from "../../../functions/shared/catalogClient";
import { toSafeReasonCode, reasonCodeToCustomerMessage } from "../../../functions/shared/chatErrors";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const requestId = `req_${crypto.randomUUID()}`;
  let currentStep = "parse_request";
  try {
    const body = await req.json().catch(() => ({}));
    const { conversationId } = body;
    const structuredAnswers = body.clarificationAnswers === undefined
      ? null
      : validateStructuredClarificationAnswers(body.clarificationAnswers);
    if (body.clarificationAnswers !== undefined && !structuredAnswers) {
      return NextResponse.json(
        { success: false, requestId, error: "إجابات الاستكشاف غير مكتملة أو غير صالحة" },
        { status: 400 },
      );
    }
    const message = structuredAnswers
      ? formatStructuredClarificationAnswers(structuredAnswers)
      : body.message;

    // Validate message content (friendly messages, setting-driven limits)
    if (!message || typeof message !== "string" || message.trim().length === 0) {
      return NextResponse.json(
        { success: false, requestId, error: "اكتب رسالتك الأول وبعدين ابعتها." },
        { status: 400 }
      );
    }
    const lengthCheck = checkMessageLength(message);
    if (!lengthCheck.allowed) {
      return NextResponse.json(
        { success: false, requestId, error: lengthCheck.reasonAr },
        { status: lengthCheck.statusCode || 400 }
      );
    }

    // 1. Authenticate user: strictly via Supabase session or verified Bearer token
    currentStep = "authenticate_user";
    let verifiedUserId: string | null = null;
    let emailVerified = false;

    try {
      const supabase = await createServerSideClient();
      const authHeader = req.headers.get("authorization");
      const bearer = authHeader?.startsWith("Bearer ") ? authHeader.substring(7).trim() : null;
      let user = null;
      if (bearer) {
        const { data, error } = await supabase.auth.getUser(bearer);
        if (!error) user = data?.user;
      } else {
        const { data, error } = await supabase.auth.getUser();
        if (!error) user = data?.user;
      }
      if (user) {
        verifiedUserId = user.id;
        emailVerified = !!(user.email_confirmed_at || user.user_metadata?.email_verified);
      }
    } catch {}

    if (!verifiedUserId) {
      return NextResponse.json(
        {
          success: false,
          requestId,
          error: "غير مصرح. يرجى تسجيل الدخول أولاً للوصول للمساعد الذكي.",
        },
        { status: 401 }
      );
    }

    // Research is blocked until the email is verified
    if (!emailVerified) {
      return NextResponse.json(
        { success: false, requestId, error: "فعّل بريدك الإلكتروني أولًا لبدء البحث." },
        { status: 403 }
      );
    }

    // Strict Security Guard: If request body maliciously claimed another user's id, REJECT
    if (body.userId && body.userId !== verifiedUserId) {
      return NextResponse.json(
        {
          success: false,
          requestId,
          error: "محاولة انتحال هوية مستخدم آخر مرفوضة أمنياً.",
        },
        { status: 403 }
      );
    }

    // Determine tables DAL: Supabase Admin client exclusively
    currentStep = "init_db_client";
    const tables = createAdminClient();

    // 2. Global daily spend cap (platform protection)
    currentStep = "global_spend_cap";
    let spendCheck: RateLimitCheckResult;
    try {
      spendCheck = await checkGlobalDailySpendCap(tables);
    } catch {
      setLastLlmFallbackReason("spend_cap");
      console.warn("[llm:SPEND_CAP_STORAGE_UNAVAILABLE]");
      return NextResponse.json(
        { success: false, requestId, error: "المساعد متوقف مؤقتاً للحماية. يرجى المحاولة لاحقاً." },
        { status: 503 },
      );
    }
    if (!spendCheck.allowed) {
      setLastLlmFallbackReason("spend_cap");
      console.warn("[llm:error] reason=spend_cap");
      return NextResponse.json(
        { success: false, requestId, error: spendCheck.reasonAr },
        { status: spendCheck.statusCode || 503 }
      );
    }

    // 3. Per-User Rate Limits Guard (messages per minute)
    currentStep = "user_rate_limit";
    const rateCheck = await checkUserRateLimits(tables, verifiedUserId);
    if (!rateCheck.allowed) {
      return NextResponse.json(
        { success: false, requestId, error: rateCheck.reasonAr },
        { status: rateCheck.statusCode || 429 }
      );
    }

    // 4. Validate uploaded exclusion files (XLSX/CSV) if provided
    currentStep = "validate_uploaded_files";
    const rawUploadedFiles = Array.isArray(body.uploadedFiles)
      ? body.uploadedFiles
      : body.uploadedFile
      ? [body.uploadedFile]
      : [];
    const verifiedUploadedFiles: Array<{
      name: string;
      type: "xlsx" | "csv";
      baselineRowCount: number;
      companyNames: string[];
      corporateDomains: string[];
      normalizedEntities: Array<{ name: string; domain?: string; crNumber?: string }>;
    }> = [];

    const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB
    const MAX_EXCLUSION_ROWS = 5000;

    for (const rawFile of rawUploadedFiles) {
      if (!rawFile || typeof rawFile !== "object") continue;

      const rawName = typeof rawFile.name === "string" ? rawFile.name.trim() : "exclusion_file.xlsx";
      const cleanName = rawName.replace(/[^a-zA-Z0-9_\u0600-\u06FF.-]/g, "_").slice(0, 100);
      const ext = cleanName.split(".").pop()?.toLowerCase();

      if (ext !== "xlsx" && ext !== "csv") {
        return NextResponse.json(
          {
            success: false,
            requestId,
            error: "صيغة الملف غير مدعومة. الصيغ المقبولة لاستبعاد الشركات هي Excel (.xlsx) أو CSV (.csv).",
          },
          { status: 400 }
        );
      }

      let fileBuffer: Buffer | null = null;

      // Option A: File provided as content (base64 or text)
      if (typeof rawFile.content === "string") {
        if (rawFile.content.length > MAX_FILE_SIZE_BYTES * 1.4) {
          return NextResponse.json(
            {
              success: false,
              requestId,
              error: "حجم الملف يتجاوز الحد الأقصى المسموح به (5 ميجابايت).",
            },
            { status: 400 }
          );
        }

        if (ext === "csv" && !rawFile.content.startsWith("data:") && !/^[A-Za-z0-9+/=]+$/.test(rawFile.content.slice(0, 100))) {
          fileBuffer = Buffer.from(rawFile.content, "utf-8");
        } else {
          const base64Data = rawFile.content.includes("base64,")
            ? rawFile.content.split("base64,")[1]
            : rawFile.content;
          fileBuffer = Buffer.from(base64Data, "base64");
        }
      }
      // Option B: File reference stored in storage path - Prohibit repurposing payment receipts storage
      else if (typeof rawFile.storagePath === "string") {
        return NextResponse.json(
          {
            success: false,
            requestId,
            error: "غير مصرح باستخدام مسارات التخزين أو إعادة توجيه حاوية إيصالات الدفع. يتم رفع ملفات الاستبعاد مباشرة وبشكل آمن ومحمي عبر محتوى المرفقات المشفر (Direct In-Memory Payload).",
          },
          { status: 403 }
        );
      }

      if (!fileBuffer || fileBuffer.length === 0) {
        return NextResponse.json(
          {
            success: false,
            requestId,
            error: "الملف المرفق فارغ أو غير صالح.",
          },
          { status: 400 }
        );
      }

      if (fileBuffer.length > MAX_FILE_SIZE_BYTES) {
        return NextResponse.json(
          {
            success: false,
            requestId,
            error: "حجم الملف يتجاوز الحد الأقصى المسموح به (5 ميجابايت).",
          },
          { status: 400 }
        );
      }

      try {
        const spec = await parseExclusionFile(fileBuffer, ext as "xlsx" | "csv");

        if (spec.baselineRowCount > MAX_EXCLUSION_ROWS) {
          return NextResponse.json(
            {
              success: false,
              requestId,
              error: `قائمة الاستبعاد تتجاوز الحد الأقصى المسموح به (${MAX_EXCLUSION_ROWS.toLocaleString()} شركة). يرجى تقليص حجم الملف.`,
            },
            { status: 400 }
          );
        }

        verifiedUploadedFiles.push({
          name: cleanName,
          type: ext as "xlsx" | "csv",
          baselineRowCount: spec.baselineRowCount,
          companyNames: spec.companyNames,
          corporateDomains: spec.corporateDomains,
          normalizedEntities: spec.normalizedEntities,
        });
      } catch (parseErr: any) {
        return NextResponse.json(
          {
            success: false,
            requestId,
            error: "تعذر قراءة ملف الاستبعاد. يرجى التأكد من سلامة ملف Excel أو CSV.",
          },
          { status: 400 }
        );
      }
    }

    // 5. Verify conversation ownership if conversationId is specified
    if (conversationId && typeof conversationId === "string") {
      const { data: convCheck, error: convErr } = await tables
        .from("conversations")
        .select("id, user_id")
        .eq("id", conversationId)
        .maybeSingle();

      if (!convErr && convCheck) {
        if (convCheck.user_id && convCheck.user_id !== verifiedUserId) {
          return NextResponse.json(
            {
              success: false,
              requestId,
              error: "غير مصرح لك بالوصول إلى هذه المحادثة أو تعديل بياناتها.",
            },
            { status: 403 }
          );
        }
      }
    }

    // 6. Delegate to ChatHandler
    currentStep = "chat_handler";
    const chatHandler = new ChatHandler(tables);
    const result = await chatHandler.handleUserMessage({
      userId: verifiedUserId,
      conversationId: conversationId || undefined,
      message: message.trim(),
      answers: structuredAnswers?.answers || body.answers,
      uploadedFiles: verifiedUploadedFiles,
    });

    return NextResponse.json({
      success: true,
      requestId,
      exclusionConfirmation: verifiedUploadedFiles.length > 0 ? {
        fileName: verifiedUploadedFiles[0].name,
        baselineRowCount: verifiedUploadedFiles[0].baselineRowCount,
        companiesCount: verifiedUploadedFiles[0].companyNames.length,
        domainsCount: verifiedUploadedFiles[0].corporateDomains.length,
      } : undefined,
      ...result,
    });
  } catch (err: any) {
    const failingStep =
      (err && typeof err === "object" && typeof err.chatStep === "string" && err.chatStep) ||
      currentStep;
    const reason = toSafeReasonCode(err, failingStep);
    const statusCode = typeof err?.statusCode === "number" ? err.statusCode : 500;
    console.error(
      `[chat:request_failed] requestId=${requestId} step=${failingStep} reason=${reason}`,
    );
    const customerError =
      (statusCode === 403 || statusCode === 404) && err.message
        ? sanitizeCustomerErrorMessage(err.message)
        : reasonCodeToCustomerMessage(reason, err?.message);

    return NextResponse.json(
      {
        success: false,
        requestId,
        step: failingStep,
        reason,
        error: customerError,
      },
      { status: statusCode }
    );
  }
}

