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
import { getEnabledCapabilitiesWithCoreServices, getCatalogCapabilities } from "@/functions/shared/capabilityRegistry";
import { getEndpointDetails, sanitizeCustomerErrorMessage } from "@/functions/shared/catalogClient";
import { calculateBalance } from "@/lib/supabase/ledger";
import { applyCustomerCap } from "@/lib/pointsCap";
import { editedPlanSummaryAr } from "@/lib/planParameters";
import { getSocialCapability, normalizeXAccountPlanItem, socialPlanSummaryAr } from "@/lib/socialSources";
import { toArabicDigits } from "@/lib/arabicDigits";
import { MODEL_PLAN_SLUG } from "@/lib/modelPlanner/constants";
import { editModelPlanQuote } from "@/lib/modelPlanner/editPlan";
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

    // The customer's own budget cap (points): it lowers the volume to what the reserve can hold under it. It never raises a plan.
    let operationsToApply = parsedOps.data;
    const requestedCap = body?.pointsCap === undefined || body?.pointsCap === null || body?.pointsCap === "" ? null : Number(body.pointsCap);
    if (requestedCap !== null) {
      const capItem = currentItems[0];
      const limitOp = parsedOps.data.find((op) => op.action === "set_limit") as { targetVolumeMax?: number } | undefined;
      const currentVolume = Number(limitOp?.targetVolumeMax) || Number(capItem?.targetVolumeMax) || 1;
      const unit = Number(capItem?.unitPricePoints);
      if (!Number.isInteger(requestedCap) || requestedCap < 1 || requestedCap > 10_000_000 || !Number.isFinite(unit) || unit <= 0 || !capItem?.capabilitySlug) {
        return NextResponse.json({ success: false, error: "الحد الأقصى للنقاط غير صالح." }, { status: 400 });
      }
      const capped = applyCustomerCap({ capPoints: requestedCap, unitPricePoints: unit, currentVolume });
      if (!capped.ok) return NextResponse.json({ success: false, error: capped.reasonAr }, { status: 400 });
      operationsToApply = [
        ...parsedOps.data.filter((op) => op.action !== "set_limit"),
        { action: "set_limit", capabilitySlug: capItem.capabilitySlug, targetVolumeMax: capped.volume } as any,
      ];
    }

    // A MODEL-PLANNED quote: the same edit button, but the edit is validated and priced again by the model planner's own code (volume and formats only), never by the old schemas.
    const modelItem = currentItems[0]?.capabilitySlug === MODEL_PLAN_SLUG ? currentItems[0] : null;
    let newQuote: any;
    if (modelItem) {
      const edited = await editModelPlanQuote({
        tables: adminClient as any, conversationId, userId: verifiedUserId, userBalance: await calculateBalance(adminClient, verifiedUserId),
        quoteItem: modelItem, summaryAr: currentPlan.summaryAr, outputFormats: currentPlan.outputFormats as any, operations: operationsToApply as any,
      });
      if (!edited.ok) return NextResponse.json({ success: false, error: edited.messageAr }, { status: 400 });
      newQuote = { ...edited.quote, modelPlanned: true };
    } else {
      const updatedPlan = applyPlanOperations(currentPlan, operationsToApply);

      // An X account plan is edited through its account: a keyword written beside it must never turn it into a topic search.
      for (const planItem of updatedPlan.items) {
        const accountError = normalizeXAccountPlanItem(planItem);
        if (accountError) return NextResponse.json({ success: false, error: accountError }, { status: 400 });
      }

      // 5. Validate updated plan against all capability schemas (static + catalog)
      const [capabilities, catalogCapabilities] = await Promise.all([
        getEnabledCapabilitiesWithCoreServices(adminClient),
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

      // Update summaryAr on updatedPlan if parameters were edited (a missing country or activity is left out of the sentence, never written into it)
      const primaryItem = updatedPlan.items[0];
      if (primaryItem) {
        updatedPlan.summaryAr = editedPlanSummaryAr(primaryItem, updatedPlan.summaryAr, toArabicDigits);
        // An X account plan keeps the sentence the plan itself writes («أحدث المنشورات للحساب المحدد»): the generic edit line named the account like a sector («خطة حصر … : elonmusk و billgates»).
        const xPosts = getSocialCapability("social-x-posts");
        if (xPosts && primaryItem.capabilitySlug === "social-x-posts" && typeof primaryItem.params?.channel === "string" && primaryItem.params.channel.trim()) {
          updatedPlan.summaryAr = socialPlanSummaryAr(xPosts, primaryItem.params, Math.max(1, Number(primaryItem.targetVolumeMax) || 1), (value) => toArabicDigits(value));
        }
      }

      // 6. Generate NEW quote (supersedes old quote and recalculates price)
      const userBalance = await calculateBalance(adminClient, verifiedUserId);
      newQuote = await createAndSaveManagedQuote(adminClient as any, {
        conversationId,
        userId: verifiedUserId,
        plan: updatedPlan,
        userBalance,
        capabilities: allCapabilities,
        enforceScope: true,
      });
    }
    // Supabase stores live quotes as `quoted`, while the shared quote builder
    // returns the Appwrite-era `proposed` label. The editor immediately swaps
    // the current card with this response, so return the status the DB saved.
    // A small priced sample of the same plan («استكشاف»): the flag and the full-plan figures only travel with the
    // returned card and its saved message, so the chat can explain the sample's result later. They change no price.
    const fullVolume = Number(body?.exploration?.fullVolume);
    const fullQuotedPoints = Number(body?.exploration?.fullQuotedPoints);
    const explorationFlag: Record<string, any> = body?.exploration && Number.isInteger(fullVolume) && fullVolume > 0 && fullVolume <= 1_000_000 &&
      Number.isInteger(fullQuotedPoints) && fullQuotedPoints > 0 && fullQuotedPoints <= 10_000_000
      ? { exploration: { fullVolume, fullQuotedPoints } }
      : {};
    const editedQuote: any = markEditedQuoteCurrent(newQuote);
    // The «فهمت أنك تريد …» sentence belongs to the plan as first made: an edited plan never carries it (its count, title and price may have changed).
    delete editedQuote.understoodAr;
    const currentQuote = { ...editedQuote, ...explorationFlag };

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
