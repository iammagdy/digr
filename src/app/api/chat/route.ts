import { NextRequest, NextResponse } from "next/server";
import { Client as ServerClient, TablesDB, Client as UserClient, Account } from "node-appwrite";
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

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const endpoint = process.env.NEXT_PUBLIC_APPWRITE_ENDPOINT || "https://fra.cloud.appwrite.io/v1";
    const projectId = process.env.NEXT_PUBLIC_APPWRITE_PROJECT_ID || "6ac947090008606ef482";
    const apiKey = process.env.APPWRITE_API_KEY || "";

    const serverClient = new ServerClient()
      .setEndpoint(endpoint)
      .setProject(projectId)
      .setKey(apiKey);

    const body = await req.json().catch(() => ({}));
    const { conversationId } = body;
    const structuredAnswers = body.clarificationAnswers === undefined
      ? null
      : validateStructuredClarificationAnswers(body.clarificationAnswers);
    if (body.clarificationAnswers !== undefined && !structuredAnswers) {
      return NextResponse.json(
        { success: false, error: "إجابات الاستكشاف غير مكتملة أو غير صالحة" },
        { status: 400 },
      );
    }
    const message = structuredAnswers
      ? formatStructuredClarificationAnswers(structuredAnswers)
      : body.message;

    // Validate message content (friendly messages, setting-driven limits)
    if (!message || typeof message !== "string" || message.trim().length === 0) {
      return NextResponse.json(
        { success: false, error: "اكتب رسالتك الأول وبعدين ابعتها." },
        { status: 400 }
      );
    }
    const lengthCheck = checkMessageLength(message);
    if (!lengthCheck.allowed) {
      return NextResponse.json(
        { success: false, error: lengthCheck.reasonAr },
        { status: lengthCheck.statusCode || 400 }
      );
    }

    // 1. Authenticate user: check Supabase session or verified Appwrite JWT/session cookie
    let verifiedUserId: string | null = null;
    let emailVerified = false;
    let isSupabaseSession = false;

    // Check Supabase session or bearer token first
    try {
      const supabase = await createServerSideClient();
      const authHeader = req.headers.get("authorization");
      const bearer = authHeader?.startsWith("Bearer ") ? authHeader.substring(7).trim() : null;
      let user = null;
      if (bearer) {
        const { data } = await supabase.auth.getUser(bearer);
        user = data?.user;
      } else {
        const { data } = await supabase.auth.getUser();
        user = data?.user;
      }
      if (user) {
        verifiedUserId = user.id;
        emailVerified = !!(user.email_confirmed_at || user.user_metadata?.email_verified);
        isSupabaseSession = true;
      }
    } catch {}

    // Fall back to Appwrite authentication if no Supabase session
    if (!verifiedUserId) {
      const authHeader = req.headers.get("authorization");
      const bearerJwt = authHeader?.startsWith("Bearer ") ? authHeader.substring(7).trim() : null;
      const bodyJwt = typeof body.jwt === "string" ? body.jwt.trim() : null;
      const effectiveJwt = bearerJwt || bodyJwt;

      const sessionCookie =
        req.cookies.get(`a_session_${projectId}`)?.value ||
        req.cookies.get(`a_session_${projectId}_legacy`)?.value;

      if (!effectiveJwt && !sessionCookie) {
        return NextResponse.json(
          {
            success: false,
            error: "غير مصرح. يرجى تسجيل الدخول أولاً للوصول للمساعد الذكي.",
          },
          { status: 401 }
        );
      }

      const userClient = new UserClient().setEndpoint(endpoint).setProject(projectId);
      if (effectiveJwt) {
        userClient.setJWT(effectiveJwt);
      } else if (sessionCookie) {
        userClient.setSession(sessionCookie);
      }

      try {
        const userAccount = new Account(userClient);
        const userDoc = await userAccount.get();
        verifiedUserId = userDoc.$id;
        emailVerified = userDoc.emailVerification === true;
      } catch (authErr: any) {
        return NextResponse.json(
          {
            success: false,
            error: "انتهت صلاحية جلسة تسجيل الدخول أو أنها غير صالحة. يرجى تسجيل الدخول مجدداً.",
          },
          { status: 401 }
        );
      }
    }

    // Research is blocked until the email is verified
    if (!emailVerified) {
      return NextResponse.json({ success: false, error: "فعّل بريدك الإلكتروني أولًا لبدء البحث." }, { status: 403 });
    }

    // Strict Security Guard: If request body maliciously claimed another user's id, REJECT
    if (body.userId && body.userId !== verifiedUserId) {
      return NextResponse.json(
        {
          success: false,
          error: "محاولة انتحال هوية مستخدم آخر مرفوضة أمنياً.",
        },
        { status: 403 }
      );
    }

    // Determine tables DAL: Supabase Admin client or Appwrite TablesDB
    let tables: any;
    if (isSupabaseSession && process.env.SUPABASE_SERVICE_ROLE_KEY) {
      try {
        tables = createAdminClient();
      } catch {
        tables = new TablesDB(serverClient);
      }
    } else {
      tables = new TablesDB(serverClient);
    }

    // 2. Global daily spend cap (platform protection)
    let spendCheck: RateLimitCheckResult;
    try {
      spendCheck = await checkGlobalDailySpendCap(tables);
    } catch {
      setLastLlmFallbackReason("spend_cap");
      console.warn("[llm:SPEND_CAP_STORAGE_UNAVAILABLE]");
      return NextResponse.json(
        { success: false, error: "المساعد متوقف مؤقتاً للحماية. يرجى المحاولة لاحقاً." },
        { status: 503 },
      );
    }
    if (!spendCheck.allowed) {
      setLastLlmFallbackReason("spend_cap");
      console.warn("[llm:error] reason=spend_cap");
      return NextResponse.json(
        { success: false, error: spendCheck.reasonAr },
        { status: spendCheck.statusCode || 503 }
      );
    }

    // 3. Per-User Rate Limits Guard (messages per minute)
    const rateCheck = await checkUserRateLimits(tables, verifiedUserId);
    if (!rateCheck.allowed) {
      return NextResponse.json(
        { success: false, error: rateCheck.reasonAr },
        { status: rateCheck.statusCode || 429 }
      );
    }

    // 4. Delegate to ChatHandler
    const chatHandler = new ChatHandler(tables);
    const result = await chatHandler.handleUserMessage({
      userId: verifiedUserId,
      conversationId: conversationId || undefined,
      message: message.trim(),
    });

    return NextResponse.json({
      success: true,
      ...result,
    });
  } catch {
    console.error("[chat:request_failed]");
    return NextResponse.json(
      {
        success: false,
        error: "حدث خطأ أثناء معالجة المحادثة. يرجى المحاولة مرة أخرى.",
      },
      { status: 500 }
    );
  }
}
