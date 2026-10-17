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
import { getEndpointDetails, sanitizeCustomerErrorMessage } from "@/functions/shared/catalogClient";
import { calculateBalance } from "@/lib/supabase/ledger";
import { markEditedQuoteCurrent, persistEditedQuoteMessage, resolveQuoteConversationId } from "@/functions/shared/quoteMessagePersistence";

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

    // The production plans_quotes schema does not contain conversation_id.
    // Resolve the owning conversation from the saved message before creating a
    // replacement quote, so superseding and message persistence use the same id.
    const conversationId = await resolveQuoteConversationId(adminClient, {
      userId: verifiedUserId,
      quoteId,
      fallbackConversationId: quoteDoc.conversation_id,
    });

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
    const additionalEndpoints = await Promise.all(updatedPlan.items.map(async (item) => {
      const alreadyResolved = allCapabilities.some((capability) =>
        capability.slug === item.capabilitySlug ||
        capability.tregEndpointId === item.capabilitySlug ||
        (item.endpointId && (
          capability.tregEndpointId === item.endpointId ||
          capability.slug === item.endpointId
        ))
      );
      if (alreadyResolved) return null;

      for (const endpointId of Array.from(new Set([item.endpointId, item.capabilitySlug].filter(Boolean) as string[]))) {
        const endpoint = await getEndpointDetails(endpointId);
        if (endpoint) return endpoint;
      }
      return null;
    }));
    const valResult = validatePlanAgainstSchemas(
      updatedPlan.items,
      allCapabilities,
      additionalEndpoints.filter((endpoint): endpoint is NonNullable<typeof endpoint> => endpoint !== null),
    );
    if (!valResult.valid) {
      const sanitizedError = sanitizeCustomerErrorMessage(valResult.errors.join("، "));
      return NextResponse.json(
        { success: false, error: `خطأ في معاملات الخطة: ${sanitizedError}` },
        { status: 400 }
      );
    }

    // Update summaryAr on updatedPlan if parameters were edited
    const primaryItem = updatedPlan.items[0];
    if (primaryItem) {
      const { extractInterpretedParameters } = await import("@/lib/planParameters");
      const interp = extractInterpretedParameters(primaryItem.params, updatedPlan.summaryAr);
      updatedPlan.summaryAr = `خطة حصر حتى ${primaryItem.targetVolumeMax || 50} سجل: ${interp.industryAr} في ${interp.countryAr}`;
    }

    // 6. Generate NEW quote (supersedes old quote and recalculates price)
    const userBalance = await calculateBalance(adminClient, verifiedUserId);
    const newQuote = await createAndSaveManagedQuote(adminClient as any, {
      conversationId,
      userId: verifiedUserId,
      plan: updatedPlan,
      userBalance,
      capabilities: allCapabilities,
    });
    // Supabase stores live quotes as `quoted`, while the shared quote builder
    // returns the Appwrite-era `proposed` label. The editor immediately swaps
    // the current card with this response, so return the status the DB saved.
    const currentQuote = markEditedQuoteCurrent(newQuote);

    // The restored chat card is hydrated from messages.quote. Persist the
    // replacement there as well as in plans_quotes so reloads show this quote.
    await persistEditedQuoteMessage(adminClient, {
      conversationId,
      userId: verifiedUserId,
      previousQuoteId: quoteId,
      quote: currentQuote,
    });

    return NextResponse.json({
      success: true,
      quote: currentQuote,
      planQuote: currentQuote,
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
