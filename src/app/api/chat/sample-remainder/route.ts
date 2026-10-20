import { NextRequest, NextResponse } from "next/server";
import { createServerSideClient, createAdminClient } from "@/lib/supabase/server";
import { createAndSaveManagedQuote, PlanState } from "@/functions/shared/planManager";
import { getEnabledCapabilitiesWithCoreServices, getCatalogCapabilities } from "@/functions/shared/capabilityRegistry";
import { calculateBalance } from "@/lib/supabase/ledger";
import { markEditedQuoteCurrent, resolveQuoteConversationId } from "@/functions/shared/quoteMessagePersistence";
import { getJobIdForQuote } from "@/lib/md5";
import { buildRemainderPlan } from "@/lib/server/sampleRemainder";
import { sampleRestMessageAr } from "@/lib/sampleFirst";

export const dynamic = "force-dynamic";

/**
 * «اطلب الباقي» after a sample: a NEW quote for the rest of the request, on the remaining volume, excluding the rows the
 * sample delivered. Nothing is reserved or charged here: the customer approves the new quote like any other, and the
 * existing path reserves, settles and releases it. The sample's own charge is never touched.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const sampleQuoteId = typeof body?.sampleQuoteId === "string" ? body.sampleQuoteId : "";
    const fullVolume = Number(body?.fullVolume);
    if (!sampleQuoteId || !Number.isInteger(fullVolume) || fullVolume < 1 || fullVolume > 1_000_000) {
      return NextResponse.json({ success: false, error: "بيانات الطلب غير مكتملة." }, { status: 400 });
    }

    const supabase = await createServerSideClient();
    const authHeader = req.headers.get("authorization");
    const { data: authData } = authHeader?.startsWith("Bearer ")
      ? await supabase.auth.getUser(authHeader.substring(7).trim())
      : await supabase.auth.getUser();
    const user = authData?.user;
    if (!user) return NextResponse.json({ success: false, error: "غير مصرح. يرجى تسجيل الدخول أولاً." }, { status: 401 });

    const admin = createAdminClient();
    const { data: quoteDoc } = await admin.from("plans_quotes").select("*").eq("id", sampleQuoteId).maybeSingle();
    if (!quoteDoc) return NextResponse.json({ success: false, error: "عرض السعر غير موجود." }, { status: 404 });
    if (quoteDoc.user_id !== user.id) return NextResponse.json({ success: false, error: "غير مصرح بالوصول لهذا العرض." }, { status: 403 });

    const jobId = getJobIdForQuote(sampleQuoteId);
    const { data: job } = await admin.from("jobs").select("id,user_id,status,delivered_units,charged_credits,unit_price").eq("id", jobId).maybeSingle();
    if (!job || job.user_id !== user.id) return NextResponse.json({ success: false, error: "العينة غير موجودة." }, { status: 404 });
    if (!["done", "completed"].includes(String(job.status).toLowerCase())) {
      return NextResponse.json({ success: false, error: "تكتمل العينة أولًا، ثم يمكنك طلب الباقي." }, { status: 409 });
    }

    // The rows the sample delivered, read from its saved result (never from the browser).
    let sampleRows: Array<Record<string, any>> = [];
    try {
      const { data: blob } = await admin.storage.from("results").download(`${user.id}/${jobId}/data.json`);
      if (blob) {
        const parsed = JSON.parse(await blob.text());
        if (Array.isArray(parsed?.rows)) sampleRows = parsed.rows;
      }
    } catch {
      // No readable result: the rest is still quoted, without exclusions, and the customer is told below.
    }

    const items = Array.isArray(quoteDoc.items) ? quoteDoc.items : JSON.parse(quoteDoc.items_json || "[]");
    const unitPrice = Number(job.unit_price) || Number(items[0]?.unitPricePoints) || 1;
    const plan = buildRemainderPlan({
      items,
      fullVolume,
      sampleRows,
      sampleDelivered: Number(job.delivered_units) || 0,
      sampleChargedPoints: Number(job.charged_credits) || 0,
    }, unitPrice);
    if (!plan) return NextResponse.json({ success: false, error: "تعذر تجهيز الباقي لهذا الطلب." }, { status: 422 });
    const messageAr = sampleRestMessageAr(plan.rest);
    if (plan.remaining <= 0) return NextResponse.json({ success: true, remaining: 0, messageAr, rest: plan.rest });

    const conversationId = await resolveQuoteConversationId(admin, { userId: user.id, quoteId: sampleQuoteId, fallbackConversationId: quoteDoc.conversation_id });
    const [capabilities, catalogCapabilities] = await Promise.all([
      getEnabledCapabilitiesWithCoreServices(admin),
      getCatalogCapabilities(admin),
    ]);
    const planState: PlanState = {
      summaryAr: quoteDoc.summary_ar || "الباقي من طلبك",
      items: plan.items as any,
      outputFormats: quoteDoc.output_formats || ["xlsx"],
    };
    const userBalance = await calculateBalance(admin, user.id);
    const newQuote: any = markEditedQuoteCurrent(await createAndSaveManagedQuote(admin as any, {
      conversationId,
      userId: user.id,
      plan: planState,
      userBalance,
      capabilities: [...capabilities, ...catalogCapabilities],
      enforceScope: true,
    }));
    const planQuote = { ...newQuote, afterSample: plan.rest };

    // The new plan is a new assistant message of the conversation (reloading the page shows it).
    await admin.from("messages").insert({
      id: `rest_${newQuote.quoteId}`.slice(0, 64),
      conversation_id: conversationId,
      user_id: user.id,
      role: "assistant",
      content_ar: messageAr,
      quote: planQuote,
      created_at: new Date().toISOString(),
    });

    return NextResponse.json({ success: true, remaining: plan.remaining, messageAr, planQuote, quote: planQuote, rest: plan.rest });
  } catch (err: any) {
    console.error("sample-remainder error:", err?.message || err);
    return NextResponse.json({ success: false, error: "تعذر تجهيز الباقي حالياً. حاول مرة أخرى." }, { status: 500 });
  }
}
