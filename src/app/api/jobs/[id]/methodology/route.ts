import { NextRequest, NextResponse } from "next/server";
import { createServerSideClient, createAdminClient } from "@/lib/supabase/server";
import { generateMethodologyText } from "@/functions/shared/fileGenerators";

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

    // 3. Ledger Flow Check: Check if methodology was already purchased
    const methChgId = `chg_meth_${jobId}`;
    const { data: existingMeth } = await adminClient
      .from("credit_ledger")
      .select("id")
      .eq("id", methChgId)
      .maybeSingle();

    let chargedPoints = 0;
    let currentBalance = 0;

    if (!existingMeth) {
      const { data: purchaseRes, error: purchaseErr } = await adminClient.rpc(
        "purchase_methodology_atomic",
        {
          p_user_id: verifiedUserId,
          p_job_id: jobId,
          p_amount: METHODOLOGY_DEFAULT_POINTS,
          p_note: `شراء صياغة المنهجية الأكاديمية للطلب ${jobId}`,
        }
      );

      if (purchaseErr) {
        return NextResponse.json(
          { success: false, error: "تعذر إتمام طلب صياغة المنهجية حالياً." },
          { status: 500 }
        );
      }

      if (!purchaseRes?.success) {
        if (purchaseRes?.error === "insufficient_balance") {
          return NextResponse.json(
            {
              success: false,
              insufficient_balance: true,
              balance: purchaseRes?.balance ?? 0,
              required: METHODOLOGY_DEFAULT_POINTS,
              error: "رصيد النقاط غير كافٍ لشراء صياغة المنهجية الأكاديمية (المطلوب: ١٠ نقاط).",
            },
            { status: 402 }
          );
        }
        return NextResponse.json(
          { success: false, error: "تعذر إتمام طلب صياغة المنهجية حالياً." },
          { status: 400 }
        );
      }
      chargedPoints = METHODOLOGY_DEFAULT_POINTS;
      currentBalance = Number(purchaseRes?.balance ?? 0);
    } else {
      const { data: ledgerRows } = await adminClient
        .from("credit_ledger")
        .select("delta")
        .eq("user_id", verifiedUserId);
      currentBalance = (ledgerRows || []).reduce((sum, r) => sum + (Number(r.delta) || 0), 0);
    }

    // 5. Read real run facts from server storage
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
          },
        }
      : {
          metadata: { collectedAt: jobDoc.finished_at || jobDoc.created_at },
          rows: [],
        };
    const methodologyStatement = generateMethodologyText(reportPayload);

    return NextResponse.json({
      success: true,
      jobId,
      chargedPoints,
      remainingBalance: currentBalance,
      methodologyText: methodologyStatement,
    });
  } catch (err: any) {
    console.error("Error in /api/jobs/[id]/methodology:", err);
    return NextResponse.json(
      { success: false, error: "تعذر إعداد التوثيق المنهجي حالياً. يرجى المحاولة لاحقاً." },
      { status: 500 }
    );
  }
}
