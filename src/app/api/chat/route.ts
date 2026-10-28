import { extractCustomerName } from "../../../lib/customerName";
import { lastAssistantAskedForName } from "../../../lib/server/customerNameStore";
import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { ChatHandler } from "../../../functions/shared/chatHandler";
import { setLastLlmFallbackReason } from "../../../functions/shared/llmClient";
import {
  checkUserRateLimits,
  checkGlobalDailySpendCap,
  SPEND_READ_CACHE_MS,
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
import { findUnresolvedResearchPlaceholder, unresolvedResearchPlaceholderMessageAr } from "../../../lib/researchPlaceholders";
import { withDeadline } from "../../../functions/shared/deadline";
import { AGENT_SERVES_CHAT } from "../../../lib/agentMission/constants";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
/** Answer before the platform's 60 s limit kills the function, so the page gets a coded error instead of a dropped connection. */
const CHAT_DEADLINE_MS = 50_000;

function guestSessionToUuid(sessionId: string): string {
  const hash = crypto.createHash("sha256").update(`guest_session:${sessionId}`).digest("hex");
  return [
    hash.substring(0, 8),
    hash.substring(8, 12),
    "4" + hash.substring(13, 16),
    ((parseInt(hash.substring(16, 18), 16) & 0x3f) | 0x80).toString(16) + hash.substring(18, 20),
    hash.substring(20, 32),
  ].join("-");
}

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
    // Reject unresolved starter-template slots before authentication side effects,
    // persistence, rate-limit consumption, or any model call.
    if (findUnresolvedResearchPlaceholder(message)) {
      return NextResponse.json(
        { success: false, requestId, error: unresolvedResearchPlaceholderMessageAr() },
        { status: 400 },
      );
    }

    // 1. Authenticate user or initialize guest session
    currentStep = "authenticate_user";
    let verifiedUserId: string | null = null;
    let emailVerified = false;
    let verifiedUserEmail: string | null = null;
    let capturedName: string | undefined;
    let isGuest = false;
    let personaProfile: { persona?: unknown; purposes?: unknown; topic?: unknown; name?: unknown; full_name?: unknown } | undefined;

    let guestSessionCookie = req.cookies.get("guest_session_id")?.value || null;
    let newGuestCookieToSet: string | null = null;
    const isGuestHeader = req.headers.get("x-guest-mode") === "true";
    const isGuestBody = body.isGuest === true;

    const authHeader = req.headers.get("authorization");
    const bearer = authHeader?.startsWith("Bearer ") ? authHeader.substring(7).trim() : null;
    const tAuthStart = Date.now();

    try {
      const supabase = await createServerSideClient();
      let user = null;
      if (bearer) {
        const { data, error } = await supabase.auth.getUser(bearer);
        if (error || !data?.user) {
          return NextResponse.json(
            { success: false, requestId, error: "غير مصرح لك بالوصول: رمز الدخول غير صالح أو منتهي الصلاحية." },
            { status: 401 }
          );
        }
        user = data.user;
      } else {
        const { data, error } = await supabase.auth.getUser();
        if (!error) user = data?.user;
      }
      if (user) {
        verifiedUserId = user.id;
        emailVerified = !!(user.email_confirmed_at || user.user_metadata?.email_verified);
        // only a verified account's e-mail counts for the model-planner allowlist (a guest has none)
        verifiedUserEmail = emailVerified && typeof user.email === "string" ? user.email : null;
        // The name is stored in the customer's own account profile through their own session (owner decision D2).
        // "اسمي X" always counts; a bare short reply counts only right after Diger AI asked for the name.
        const askedForName = typeof conversationId === "string" && conversationId
          ? await lastAssistantAskedForName(createAdminClient(), user.id, conversationId)
          : false;
        capturedName = extractCustomerName(message, askedForName) || undefined;
        if (capturedName) {
          const { data: updated, error: nameError } = await supabase.auth.updateUser({ data: { name: capturedName, full_name: capturedName } });
          if (!nameError && updated.user) user = updated.user;
          else capturedName = undefined;
        }
        personaProfile = user.user_metadata;
      }
    } catch {
      if (bearer) {
        return NextResponse.json(
          { success: false, requestId, error: "غير مصرح لك بالوصول: رمز الدخول غير صالح." },
          { status: 401 }
        );
      }
    }

    const tables = createAdminClient();

    if (!verifiedUserId) {
      // Must be an explicit guest (has guest cookie, or guest header/body flag)
      if (!guestSessionCookie && !isGuestHeader && !isGuestBody) {
        return NextResponse.json(
          { success: false, requestId, error: "غير مصرح لك بالوصول: يرجى تسجيل الدخول أو إرسال رمز مصادقة صالح." },
          { status: 401 }
        );
      }

      isGuest = true;
      let existingGuestId: string | null = null;
      if (guestSessionCookie && guestSessionCookie.startsWith("gst_")) {
        const potentialUuid = guestSessionCookie.slice(4);
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(potentialUuid)) {
          if (tables.auth?.admin?.getUserById) {
            try {
              const { data: userCheck } = await tables.auth.admin.getUserById(potentialUuid);
              if (userCheck?.user?.id) {
                existingGuestId = userCheck.user.id;
              }
            } catch {}
          } else {
            existingGuestId = potentialUuid;
          }
        }
      }

      if (existingGuestId) {
        verifiedUserId = existingGuestId;
      } else if (tables.auth?.admin?.createUser) {
        try {
          // Hard safety limit: cap guest users to protect MAU limits and prune oldest guest if needed
          const MAX_CONCURRENT_GUESTS = 500;
          if (typeof tables.auth.admin.listUsers === "function") {
            try {
              const { data: oldGuests } = await tables.auth.admin.listUsers({ page: 1, perPage: 10 });
              const guestUsers = (oldGuests?.users || []).filter((u: any) => u.user_metadata?.is_guest);
              if (guestUsers.length >= MAX_CONCURRENT_GUESTS) {
                const oldest = guestUsers[0];
                if (oldest?.id) {
                  await tables.auth.admin.deleteUser(oldest.id).catch(() => {});
                }
              }
            } catch {}
          }

          const { data: newGuestUser, error: createGuestErr } = await tables.auth.admin.createUser({
            email: `guest_${crypto.randomUUID().replace(/-/g, "")}@diger.tech`,
            password: crypto.randomUUID(),
            email_confirm: false,
            user_metadata: { is_guest: true },
          });
          if (newGuestUser?.user?.id) {
            verifiedUserId = newGuestUser.user.id;
            guestSessionCookie = `gst_${verifiedUserId}`;
            newGuestCookieToSet = guestSessionCookie;
          } else if (createGuestErr) {
            console.warn("[chat:create_guest_user_warn]", createGuestErr.message);
          }
        } catch (guestErr: any) {
          console.warn("[chat:create_guest_user_error]", guestErr?.message);
        }
      }

      if (!verifiedUserId) {
        if (!guestSessionCookie) {
          guestSessionCookie = `gst_${crypto.randomUUID()}`;
          newGuestCookieToSet = guestSessionCookie;
        }
        verifiedUserId = guestSessionCookie.startsWith("gst_") && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(guestSessionCookie.slice(4))
          ? guestSessionCookie.slice(4)
          : guestSessionToUuid(guestSessionCookie);
      }
      emailVerified = true;
    } else {
      // Authenticated user: migrate previous guest conversation if guest session cookie exists
      if (guestSessionCookie) {
        const prevGuestUuid = guestSessionCookie.startsWith("gst_") && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(guestSessionCookie.slice(4))
          ? guestSessionCookie.slice(4)
          : guestSessionToUuid(guestSessionCookie);
        try {
          await Promise.all([
            tables.from("conversations").update({ user_id: verifiedUserId }).eq("user_id", prevGuestUuid),
            tables.from("messages").update({ user_id: verifiedUserId }).eq("user_id", prevGuestUuid),
            // the guest's missions (a plan they looked at before signing up) follow them; deleting the guest account below is refused while any mission still points at it
            tables.from("missions").update({ user_id: verifiedUserId, created_by: verifiedUserId }).eq("user_id", prevGuestUuid),
          ]);
          if (tables.auth?.admin?.deleteUser) {
            await tables.auth.admin.deleteUser(prevGuestUuid).catch(() => {});
          }
        } catch (migErr) {
          console.warn("[chat:guest_migration_failed]", migErr);
        }
      }
    }

    const authMs = Date.now() - tAuthStart;

    // Research is blocked until the email is verified (for logged in accounts)
    if (!isGuest && !emailVerified) {
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

    const GUEST_MESSAGE_LIMIT = Number(process.env.GUEST_FREE_MESSAGE_LIMIT) || 3;
    let remainingGuestMessages = GUEST_MESSAGE_LIMIT;

    if (isGuest) {
      if (body.exclusionFile || (body.uploadedFiles && body.uploadedFiles.length > 0)) {
        return NextResponse.json(
          {
            success: false,
            requestId,
            isGuest: true,
            error: "رفع وتحليل الملفات متاح فقط بعد تسجيل الدخول.",
          },
          { status: 403 }
        );
      }

      // Count prior user messages sent by this guest UUID
      const { count: priorMessagesCount } = await tables
        .from("messages")
        .select("id", { count: "exact", head: true })
        .eq("user_id", verifiedUserId)
        .eq("role", "user");

      const usedCount = priorMessagesCount || 0;
      if (usedCount >= GUEST_MESSAGE_LIMIT) {
        const limitRes = NextResponse.json(
          {
            success: false,
            requestId,
            isGuest: true,
            guestLimitReached: true,
            remainingGuestMessages: 0,
            error: `لقد استهلكت الـ ${GUEST_MESSAGE_LIMIT} رسائل المجانية المتاحة كزائر. يرجى إنشاء حساب أو تسجيل الدخول لحفظ محادثتك والمتابعة.`,
          },
          { status: 403 }
        );
        if (newGuestCookieToSet) {
          limitRes.cookies.set("guest_session_id", newGuestCookieToSet, {
            httpOnly: true,
            secure: process.env.NODE_ENV === "production",
            sameSite: "lax",
            maxAge: 30 * 24 * 60 * 60,
            path: "/",
          });
        }
        return limitRes;
      }

      remainingGuestMessages = Math.max(0, GUEST_MESSAGE_LIMIT - (usedCount + 1));
    }

    currentStep = "init_db_client";

    // 2. Global daily spend cap (platform protection)
    currentStep = "global_spend_cap";
    let spendCheck: RateLimitCheckResult;
    try {
      spendCheck = await checkGlobalDailySpendCap(tables, undefined, { readCacheMs: SPEND_READ_CACHE_MS });
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
    const tRateStart = Date.now();
    const rateCheck = await checkUserRateLimits(tables, verifiedUserId);
    const rateLimitMs = Date.now() - tRateStart;
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
    // every research request goes to the agent (one rollback constant; false = the old planner path answers, exactly as before)
    chatHandler.agentChat = { enabled: AGENT_SERVES_CHAT };
    const result = await withDeadline(chatHandler.handleUserMessage({
      userId: verifiedUserId,
      conversationId: conversationId || undefined,
      plannerRequestId: typeof body.plannerRequestId === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(body.plannerRequestId) ? body.plannerRequestId : undefined,
      message: message.trim(),
      answers: structuredAnswers?.answers || body.answers,
      uploadedFiles: verifiedUploadedFiles,
      isGuest,
      userEmail: isGuest ? null : verifiedUserEmail,
      capturedName,
      personaProfile: isGuest ? undefined : personaProfile,
      resultColumns: Array.isArray(body.resultColumns) ? body.resultColumns.slice(0, 60) : undefined,
      authMs,
      rateLimitMs,
    }), CHAT_DEADLINE_MS, "chat_handler");

    const response = NextResponse.json({
      success: true,
      requestId,
      isGuest,
      remainingGuestMessages: isGuest ? remainingGuestMessages : undefined,
      exclusionConfirmation: verifiedUploadedFiles.length > 0 ? {
        fileName: verifiedUploadedFiles[0].name,
        baselineRowCount: verifiedUploadedFiles[0].baselineRowCount,
        companiesCount: verifiedUploadedFiles[0].companyNames.length,
        domainsCount: verifiedUploadedFiles[0].corporateDomains.length,
      } : undefined,
      ...result,
    });

    if (newGuestCookieToSet) {
      response.cookies.set("guest_session_id", newGuestCookieToSet, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        maxAge: 30 * 24 * 60 * 60,
        path: "/",
      });
    } else if (!isGuest && guestSessionCookie) {
      response.cookies.delete("guest_session_id");
    }

    return response;
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

