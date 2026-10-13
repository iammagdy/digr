import { NextRequest, NextResponse } from "next/server";
import { createServerSideClient, createAdminClient } from "@/lib/supabase/server";
import { normalizeDataset, detectPlatform } from "@/lib/server/normalizationPipeline";

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

    const normalized = normalizeDataset(rawParsed || { profile: null, rows: [] }, {
      platform: jobDoc.platform || undefined,
      title: jobDoc.template_slug || jobDoc.endpoint_id,
      jobId,
    });

    const isProfileMode = Boolean(
      normalized.profile &&
      (normalized.metadata.entityType === "profile" || normalized.rows.length <= 1)
    );

    let methodologyStatement = "";

    if (isProfileMode) {
      const p = normalized.profile!;
      const facts = {
        platform: normalized.metadata.platform || "TikTok",
        account: p.username || `@${jobDoc.template_slug || "account"}`,
        displayName: p.display_name || "",
        verifiedStatus: p.verified ? "موثق رسمياً" : "غير موثق",
        followers: Number(p.followers_count || 0),
        likes: Number(p.likes_count || 0),
        videosCount: Number(p.posts_count || 0),
        date: (jobDoc.finished_at || jobDoc.created_at || new Date().toISOString()).split("T")[0],
        recordsCount: normalized.rows.length || 1,
      };

      methodologyStatement = `### توثيق المنهجية الأكاديمية (Academic Methodology Statement)

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
    } else {
      const k = normalized.kpis;
      const dateStr = (jobDoc.finished_at || jobDoc.created_at || new Date().toISOString()).split("T")[0];
      const timeRange = k.earliestDate && k.latestDate ? `من ${k.earliestDate} إلى ${k.latestDate}` : `بتاريخ ${dateStr}`;

      methodologyStatement = `### توثيق المنهجية الأكاديمية (Academic Methodology Statement)

1. أصل ومصدر البيانات (Data Provenance & Collection Strategy):
تم استخراج بيانات هذه الدراسة بصورة مؤتمتة ومطابقة للأصول المنهجية عبر منصة Diger للبيانات العامة، استناداً إلى واجهات البيانات العامة المتاحة لمنصة ${normalized.metadata.platform}.
- موضوع / نطاق البحث: ${normalized.metadata.title}
- نوع الكيانات المستخرجة: ${normalized.metadata.entityType === "posts" ? "منشورات وتغريدات عامة" : normalized.metadata.entityType === "comments" ? "سلاسل تعليقات وردود تفاعلية" : "سجلات بيانات عامة"}
- إجمالي السجلات المستخلصة بعد تدقيق التكرار: ${k.totalRecords} سجل
- السجلات المكررة التي تم استبعادها آلياً: ${k.duplicatesRemoved} سجل

2. النطاق الزمني ومؤشرات التفاعل المرصودة (Temporal Bounds & Engagement Metrics):
تم حصر البيانات للفترة الزمنية (${timeRange})، وتلخص المؤشرات الإجمالية التالية التفاعل العام المرصود:
- إجمالي المشاهدات المسجلة: ${k.totalViews.toLocaleString("en-US")}
- إجمالي الإعجابات والتفاعلات: ${k.totalLikes.toLocaleString("en-US")}
- إجمالي إعادة النشر والمشاركات: ${k.totalShares.toLocaleString("en-US")}
- إجمالي الردود والتعليقات: ${k.totalComments.toLocaleString("en-US")}
- نسبة اكتمال الحقول الخالية من القيم المفقودة: ${k.dataCompletenessPct}%

3. النزاهة المنهجية ومحددات التحليل (Methodological Integrity & Limitations):
- نقل المؤشرات: جرى نقل النصوص والمقاييس الرقمية بدقة دون أي تحوير أو ترجيح إحصائي أو توليد اصطناعي.
- طبيعة العينة: تمثل هذه البيانات عينة رصدية عامة محددة بضوابط ومعايير الاستعلام المعتمدة، ولا تشكل بالضرورة عينة احتمالية عشوائية تمثيلية لكافة مجتمع المنصة.
- أخلاقيات البحث: اقتصر الجمع على المحتوى المنشور علناً دون الالتفاف على أي قيود خصوصية.`;
    }

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
