import { NextRequest, NextResponse } from "next/server";
import { createServerSideClient, createAdminClient } from "@/lib/supabase/server";

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

    // 3. Verify points balance before charging
    const { data: ledgerRows, error: ledgerErr } = await adminClient
      .from("credit_ledger")
      .select("delta")
      .eq("user_id", verifiedUserId);

    if (ledgerErr) {
      throw ledgerErr;
    }

    const currentBalance = (ledgerRows || []).reduce((sum, r) => sum + (Number(r.delta) || 0), 0);

    if (currentBalance < METHODOLOGY_DEFAULT_POINTS) {
      return NextResponse.json(
        {
          success: false,
          error: `الرصيد غير كافٍ. يلزم ${METHODOLOGY_DEFAULT_POINTS} نقاط لصياغة المنهجية الأكاديمية (رصيدك الحالي: ${currentBalance} نقطة).`,
        },
        { status: 400 }
      );
    }

    // 4. Ledger Flow: Deterministic Reserve then Release-First Charge
    const methResId = `res_meth_${jobId}`;
    const methRelId = `rel_meth_${jobId}`;
    const methChgId = `chg_meth_${jobId}`;

    const { data: existingMeth } = await adminClient
      .from("credit_ledger")
      .select("id")
      .eq("id", methChgId)
      .maybeSingle();

    if (!existingMeth) {
      // Write reserve (-10)
      await adminClient.from("credit_ledger").insert({
        id: methResId,
        user_id: verifiedUserId,
        delta: -METHODOLOGY_DEFAULT_POINTS,
        type: "reserve",
        note: "حجز نقاط صياغة المنهجية",
      });

      // Write release (+10)
      await adminClient.from("credit_ledger").insert({
        id: methRelId,
        user_id: verifiedUserId,
        delta: METHODOLOGY_DEFAULT_POINTS,
        type: "release",
        note: "استرداد حجز نقاط المنهجية",
      });

      // Write charge (-10)
      await adminClient.from("credit_ledger").insert({
        id: methChgId,
        user_id: verifiedUserId,
        delta: -METHODOLOGY_DEFAULT_POINTS,
        type: "charge",
        note: "خصم تكلفة صياغة المنهجية الأكاديمية",
      });
    }

    // 5. Read real run facts from server storage
    let profileData: any = null;
    let rowsCount = jobDoc.delivered_units || 1;

    try {
      const candidatePaths = [
        `${verifiedUserId}/${jobId}/data.json`,
        `${jobId}/data.json`,
        `json_${jobId}`,
      ];

      for (const path of candidatePaths) {
        const { data: blob, error: dlErr } = await adminClient.storage
          .from("results")
          .download(path);

        if (!dlErr && blob) {
          const parsed = JSON.parse(await blob.text());
          profileData = parsed.profile || null;
          if (Array.isArray(parsed.rows) && parsed.rows.length > 0) {
            rowsCount = parsed.rows.length;
          }
          break;
        }
      }
    } catch {
      // Fallback
    }

    const facts = {
      platform: "TikTok",
      account: profileData?.uniqueId ? `@${profileData.uniqueId}` : profileData?.username || `@${jobDoc.template_slug || "account"}`,
      displayName: profileData?.nickname || profileData?.displayName || "",
      verifiedStatus: profileData?.verified ? "موثق رسمياً" : "غير موثق",
      followers: Number(profileData?.followerCount ?? profileData?.followers ?? 0),
      likes: Number(profileData?.heartCount ?? profileData?.likes ?? 0),
      videosCount: Number(profileData?.videoCount ?? profileData?.videosCount ?? 0),
      date: (jobDoc.finished_at || jobDoc.created_at || new Date().toISOString()).split("T")[0],
      recordsCount: rowsCount,
    };

    // 6. Strict Academic Methodology text
    const methodologyStatement = `### توثيق المنهجية الأكاديمية (Academic Methodology Statement)

1. مصدر البيانات وأصلها (Data Provenance):
تم جمع بيانات هذه الدراسة بصورة آلية ومباشرة عبر منصة Diger من المصدر العلني المتاح على منصة ${facts.platform} للحساب (${facts.account})${facts.displayName ? ` - [${facts.displayName}]` : ""}، وحالة التوثيق (${facts.verifiedStatus}).

2. النطاق الزمني والتغطية (Temporal Bounds & Coverage):
أُجريت عملية الاستخراج بتاريخ ${facts.date}. وتمثل المؤشرات الرقمية لقطة مقطعية (Cross-sectional Snapshot) لحظية دقيقة للحساب في تاريخ الجمع:
- إجمالي عدد المتابعين: ${facts.followers}
- إجمالي عدد الإعجابات: ${facts.likes}
- إجمالي عدد المقاطع المنشورة: ${facts.videosCount}
- إجمالي السجلات المستخرجة: ${facts.recordsCount} سجل

3. النزاهة المنهجية ومحددات التحليل (Integrity & Methodological Constraints):
- سلامة المؤشرات: نُقلت الأرقام كما هي معلنة دون أي معالجة أو تقريب أو ترجيح إحصائي اصطناعي.
- حدود العينة: هذه البيانات مستخلصة لحساب فردي محدد وتصلح لأغراض دراسة الحالة (Case Study) والتحليل المقارن، ولا تمثل عينة احتمالية عشوائية لعموم مستخدمي المنصة.`;

    const remainingBalance = existingMeth
      ? currentBalance
      : currentBalance - METHODOLOGY_DEFAULT_POINTS;

    return NextResponse.json({
      success: true,
      jobId,
      chargedPoints: METHODOLOGY_DEFAULT_POINTS,
      remainingBalance,
      methodologyText: methodologyStatement,
    });
  } catch (err: any) {
    console.error("Error in /api/jobs/[id]/methodology:", err);
    return NextResponse.json(
      { success: false, error: err.message || "حدث خطأ أثناء إعداد توثيق المنهجية." },
      { status: 500 }
    );
  }
}
