import { NextRequest, NextResponse } from "next/server";
import { createServerSideClient, createAdminClient } from "@/lib/supabase/server";
import { generateMethodologyText, generatePdfReport } from "@/functions/shared/fileGenerators";

export const dynamic = "force-dynamic";

const METHODOLOGY_DEFAULT_POINTS = 10;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: jobId } = await params;
    if (!jobId) {
      return NextResponse.json({ success: false, error: "معرف الطلب مطلوب" }, { status: 400 });
    }
    const confirmation = await req.json().catch(() => null);
    if (confirmation?.confirmed !== true) {
      return NextResponse.json({ success: false, error: "يلزم تأكيد الطلب داخل الصفحة قبل الخصم." }, { status: 400 });
    }

    // 1. Authenticate caller strictly via Supabase JWT or session
    const supabase = await createServerSideClient();
    const authHeader = req.headers.get("authorization");
    let user = null;

    if (authHeader?.startsWith("Bearer ")) {
      const bearerJwt = authHeader.substring(7).trim();
      const { data } = await supabase.auth.getUser(bearerJwt);
      user = data?.user;
    } else {
      const { data } = await supabase.auth.getUser();
      user = data?.user;
    }

    if (!user) {
      return NextResponse.json({ success: false, error: "غير مصرح. يرجى تسجيل الدخول أولاً." }, { status: 401 });
    }

    const verifiedUserId = user.id;
    const adminClient = createAdminClient();

    // 2. Fetch Job Document & verify ownership
    const { data: jobDoc, error: jobErr } = await adminClient
      .from("jobs")
      .select("*")
      .eq("id", jobId)
      .single();

    if (jobErr || !jobDoc) {
      return NextResponse.json({ success: false, error: "الطلب غير موجود." }, { status: 404 });
    }

    const isAdmin = user.app_metadata?.role === "admin";
    if (jobDoc.user_id !== verifiedUserId && !isAdmin) {
      return NextResponse.json({ success: false, error: "غير مصرح بالوصول لهذا الطلب." }, { status: 403 });
    }
    if (!["done", "completed"].includes(String(jobDoc.status).toLowerCase())) {
      return NextResponse.json({ success: false, error: "ستتاح صياغة المنهجية بعد اكتمال تسليم نتائج الطلب." }, { status: 409 });
    }

    // Read the completed dataset and render the add-on before charging. A
    // failed read or generation therefore never changes the customer's balance.
    let rawParsed: any = null;

    try {
      const candidatePaths = [
        `${verifiedUserId}/${jobId}/data.json`,
        `${jobDoc.user_id}/${jobId}/data.json`,
        `${jobId}/data.json`,
        `json_${jobId}`,
      ];

      for (const bucketName of ["results", "partials"]) {
        if (rawParsed) break;
        const bucket = adminClient.storage?.from?.(bucketName);
        if (!bucket || typeof bucket.download !== "function") continue;
        for (const path of candidatePaths) {
          const { data: blob, error: dlErr } = await bucket.download(path);
          if (!dlErr && blob) {
            rawParsed = JSON.parse(await blob.text());
            break;
          }
        }
      }
    } catch {
      // Fallback
    }

    const reportPayload = rawParsed && typeof rawParsed === "object"
      ? {
          ...rawParsed,
          metadata: {
            ...(rawParsed.metadata || {}),
            collectedAt: rawParsed.metadata?.collectedAt || jobDoc.finished_at || jobDoc.created_at,
            methodology: generateMethodologyText(rawParsed),
          },
        }
      : {
          metadata: { collectedAt: jobDoc.finished_at || jobDoc.created_at },
          rows: [],
        };
    const methodologyStatement = generateMethodologyText(reportPayload);

    if (!rawParsed || !Array.isArray(rawParsed.rows) || rawParsed.rows.length === 0) {
      return NextResponse.json({ success: false, error: "تعذر العثور على بيانات الطلب المكتملة؛ لم يتم خصم أي نقاط." }, { status: 409 });
    }

    const methodologyPath = `${verifiedUserId}/${jobId}/methodology-addon.pdf`;
    const methodologyBucket = adminClient.storage.from("results");
    let methodologyPdf: Buffer;
    try {
      methodologyPdf = await generatePdfReport({
        ...reportPayload,
        metadata: { ...(reportPayload.metadata || {}), methodology: methodologyStatement },
      });
    } catch {
      return NextResponse.json({ success: false, error: "تعذر تجهيز ملف المنهجية؛ لم يتم خصم أي نقاط." }, { status: 503 });
    }
    const { error: saveError } = await methodologyBucket.upload(
      methodologyPath,
      methodologyPdf,
      { contentType: "application/pdf", upsert: true },
    );
    if (saveError) {
      return NextResponse.json({ success: false, error: "تعذر تجهيز ملف المنهجية؛ لم يتم خصم أي نقاط." }, { status: 503 });
    }
    const { data: methodologySigned, error: signError } = await methodologyBucket.createSignedUrl(methodologyPath, 60 * 60 * 24 * 90, {
      download: `منهجية البحث - ${jobId.slice(0, 8)}.pdf`,
    });
    if (signError || !methodologySigned?.signedUrl) {
      await methodologyBucket.remove([methodologyPath]);
      return NextResponse.json({ success: false, error: "تعذر تجهيز رابط تحميل المنهجية؛ لم يتم خصم أي نقاط." }, { status: 503 });
    }

    const methChgId = `chg_meth_${jobId}`;
    const { data: existingMeth, error: existingErr } = await adminClient
      .from("credit_ledger")
      .select("id")
      .eq("id", methChgId)
      .maybeSingle();
    if (existingErr) {
      await methodologyBucket.remove([methodologyPath]);
      return NextResponse.json({ success: false, error: "تعذر التحقق من عملية الشراء؛ لم يتم خصم أي نقاط." }, { status: 503 });
    }

    let chargedPoints = 0;
    let currentBalance = 0;
    if (!existingMeth) {
      const { data: purchaseRes, error: purchaseErr } = await adminClient.rpc("purchase_methodology_atomic", {
        p_user_id: verifiedUserId,
        p_job_id: jobId,
        p_amount: METHODOLOGY_DEFAULT_POINTS,
        p_note: `شراء صياغة المنهجية الأكاديمية للطلب ${jobId}`,
      });
      if (purchaseErr || !purchaseRes?.success) {
        await methodologyBucket.remove([methodologyPath]);
        if (purchaseRes?.error === "insufficient_balance") {
          return NextResponse.json({ success: false, insufficient_balance: true, balance: purchaseRes.balance ?? 0, required: METHODOLOGY_DEFAULT_POINTS, error: "رصيد النقاط غير كافٍ؛ لم يتم الخصم." }, { status: 402 });
        }
        return NextResponse.json({ success: false, error: "تعذر إتمام طلب صياغة المنهجية؛ لم يتم خصم أي نقاط." }, { status: 503 });
      }
      chargedPoints = Number(purchaseRes.charged ?? METHODOLOGY_DEFAULT_POINTS);
      currentBalance = Number(purchaseRes.balance ?? 0);
    } else {
      const { data: ledgerRows } = await adminClient
        .from("credit_ledger")
        .select("delta")
        .eq("user_id", verifiedUserId);
      currentBalance = (ledgerRows || []).reduce((sum, row) => sum + (Number(row.delta) || 0), 0);
    }

    return NextResponse.json({
      success: true,
      jobId,
      chargedPoints,
      remainingBalance: currentBalance,
      methodologyText: methodologyStatement,
      downloadPath: methodologyPath,
      downloadUrl: methodologySigned.signedUrl,
    });
  } catch (err: any) {
    console.error("Error in /api/jobs/[id]/methodology:", err);
    return NextResponse.json(
      { success: false, error: "تعذر إعداد التوثيق المنهجي حالياً. يرجى المحاولة لاحقاً." },
      { status: 500 }
    );
  }
}
