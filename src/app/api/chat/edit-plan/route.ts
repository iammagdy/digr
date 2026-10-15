import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createServerSideClient, createAdminClient } from "@/lib/supabase/server";
import {
  EditPlanOperationSchema,
  applyPlanOperations,
  validatePlanAgainstSchemas,
  createAndSaveManagedQuote,
  PlanState,
} from "@/functions/shared/planManager";
import { getEnabledCapabilities, getCatalogCapabilities } from "@/functions/shared/capabilityRegistry";
import { sanitizeCustomerErrorMessage } from "@/functions/shared/catalogClient";
import { calculateBalance } from "@/lib/supabase/ledger";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const { quoteId, operations } = body;

    if (!quoteId || !Array.isArray(operations) || operations.length === 0) {
      return NextResponse.json(
        { success: false, error: "معرف عرض السعر وعمليات التعديل مطلوبة" },
        { status: 400 }
      );
    }

    // 1. Authenticate user strictly via Supabase JWT or session
    const supabase = await createServerSideClient();
    const authHeader = req.headers.get("authorization");
    const bearerJwt = authHeader?.startsWith("Bearer ") ? authHeader.substring(7).trim() : null;
    const bodyJwt = typeof body.jwt === "string" ? body.jwt.trim() : null;
    const effectiveJwt = bearerJwt || bodyJwt;

    let user = null;
    if (effectiveJwt) {
      const { data } = await supabase.auth.getUser(effectiveJwt);
      user = data?.user;
    } else {
      const { data } = await supabase.auth.getUser();
      user = data?.user;
    }

    if (!user) {
      return NextResponse.json(
        { success: false, error: "غير مصرح. يرجى تسجيل الدخول أولاً." },
        { status: 401 }
      );
    }

    const verifiedUserId = user.id;

    // 2. Validate operations with strict Zod schema
    const parsedOps = z.array(EditPlanOperationSchema).safeParse(operations);
    if (!parsedOps.success) {
      return NextResponse.json(
        { success: false, error: "عمليات تعديل الخطة غير مطابقة للمخطط الأمني المعتمد." },
        { status: 400 }
      );
    }

    const adminClient = createAdminClient();

    // 3. Fetch existing quote
    const { data: quoteDoc, error: quoteErr } = await adminClient
      .from("plans_quotes")
      .select("*")
      .eq("id", quoteId)
      .single();

    if (quoteErr || !quoteDoc) {
      return NextResponse.json(
        { success: false, error: "عرض السعر غير موجود." },
        { status: 404 }
      );
    }

    if (quoteDoc.user_id !== verifiedUserId) {
      return NextResponse.json(
        { success: false, error: "غير مصرح لك بتعديل هذا العرض." },
        { status: 403 }
      );
    }

    if (quoteDoc.status === "accepted") {
      return NextResponse.json(
        { success: false, error: "لا يمكن تعديل الخطة بعد بدء التنفيذ بالفعل." },
        { status: 400 }
      );
    }

    // 4. Construct current plan state and apply operations
    const currentItems = Array.isArray(quoteDoc.items)
      ? quoteDoc.items
      : JSON.parse(quoteDoc.items_json || "[]");

    const currentPlan: PlanState = {
      summaryAr: quoteDoc.summary_ar || "خطة استخراج بيانات",
      items: currentItems,
      outputFormats: quoteDoc.output_formats || ["xlsx", "pdf", "csv"],
    };

    const updatedPlan = applyPlanOperations(currentPlan, parsedOps.data);

    // 5. Validate updated plan against all capability schemas (static + catalog)
    const [capabilities, catalogCapabilities] = await Promise.all([
      getEnabledCapabilities(adminClient),
      getCatalogCapabilities(adminClient),
    ]);
    const allCapabilities = [...capabilities, ...catalogCapabilities];
    const valResult = validatePlanAgainstSchemas(updatedPlan.items, allCapabilities);
    if (!valResult.valid) {
      const sanitizedError = sanitizeCustomerErrorMessage(valResult.errors.join("، "));
      return NextResponse.json(
        { success: false, error: `خطأ في معاملات الخطة: ${sanitizedError}` },
        { status: 400 }
      );
    }

    // 6. Generate NEW quote (supersedes old quote and recalculates price)
    const userBalance = await calculateBalance(adminClient, verifiedUserId);
    const newQuote = await createAndSaveManagedQuote(adminClient as any, {
      conversationId: quoteDoc.conversation_id || "",
      userId: verifiedUserId,
      plan: updatedPlan,
      userBalance,
      capabilities: allCapabilities,
    });

    return NextResponse.json({
      success: true,
      quote: newQuote,
      planQuote: newQuote,
      messageAr: "تم تحديث الخطة وإعادة احتساب عرض السعر بنجاح!",
    });
  } catch (err: any) {
    console.error("Edit plan API error:", err);
    return NextResponse.json(
      { success: false, error: sanitizeCustomerErrorMessage(err.message || "حدث خطأ أثناء تعديل الخطة.") },
      { status: 500 }
    );
  }
}
