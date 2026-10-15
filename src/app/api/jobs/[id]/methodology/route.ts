import { NextRequest, NextResponse } from "next/server";
import { createServerSideClient, createAdminClient } from "@/lib/supabase/server";
import { normalizeDataset, detectPlatform } from "@/lib/server/normalizationPipeline";
import { toArabicDigits } from "@/lib/arabicDigits";

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
          { success: false, error: "فشل استقطاع رصيد المنهجية: " + purchaseErr.message },
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
          { success: false, error: purchaseRes?.error || "تعذر إتمام عملية شراء المنهجية." },
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

    const isCompanyJob =
      rawParsed?.metadata?.entityType === "companies" ||
      jobDoc.endpoint_id?.includes("compan") ||
      jobDoc.platform === "companies";

    const cleanTitle =
      rawParsed?.metadata?.title && !rawParsed.metadata.title.includes(".")
        ? rawParsed.metadata.title
        : isCompanyJob
          ? "دليل واستخراج بيانات الشركات والمؤسسات المعتمدة"
          : (jobDoc.template_slug && !jobDoc.template_slug.includes("."))
            ? jobDoc.template_slug
            : "تقرير البيانات والأبحاث الميدانية المعتمدة";

    const cleanPlatform =
      rawParsed?.metadata?.platform === "web" || jobDoc.platform === "web" || !jobDoc.platform
        ? "المصادر الرقمية المتاحة على شبكة الإنترنت"
        : rawParsed?.metadata?.platform || jobDoc.platform;

    const normalized = normalizeDataset(rawParsed || { profile: null, rows: [] }, {
      platform: cleanPlatform,
      title: cleanTitle,
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
        platform: cleanPlatform,
        account: p.username || `@${jobDoc.template_slug || "account"}`,
        displayName: p.display_name || "",
        verifiedStatus: p.verified ? "موثق رسمياً" : "غير موثق",
        followers: toArabicDigits(p.followers_count || 0),
        likes: toArabicDigits(p.likes_count || 0),
        videosCount: toArabicDigits(p.posts_count || 0),
        date: (jobDoc.finished_at || jobDoc.created_at || new Date().toISOString()).split("T")[0],
        recordsCount: toArabicDigits(normalized.rows.length || 1),
      };

      methodologyStatement = `### توثيق المنهجية الأكاديمية (Academic Methodology Statement)

1. مصدر البيانات وأصلها (Data Provenance):
تم جمع بيانات هذه الدراسة بصورة آلية ومباشرة عبر منصة Diger من المصدر العلني المتاح عبر (${facts.platform}) للحساب (${facts.account})${facts.displayName ? ` - [${facts.displayName}]` : ""}، وحالة التوثيق (${facts.verifiedStatus}).

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
      const entityTypeName = isCompanyJob
        ? "شركات ومؤسسات تجارية معتمدة"
        : normalized.metadata.entityType === "posts"
          ? "منشورات وتدوينات"
          : normalized.metadata.entityType === "comments"
            ? "سلاسل تعليقات وردود تفاعلية"
            : "سجلات مستخرجة";

      methodologyStatement = `### توثيق المنهجية الأكاديمية (Academic Methodology Statement)

1. أصل ومصدر البيانات (Data Provenance & Collection Strategy):
تم استخراج بيانات هذه الدراسة بصورة مؤتمتة ومطابقة للأصول المنهجية عبر منصة Diger للبحث والاستقصاء الميداني، استناداً إلى (${cleanPlatform}).
- موضوع / نطاق البحث: ${cleanTitle}
- نوع الكيانات المستخرجة: ${entityTypeName}
- إجمالي السجلات المستخلصة بعد تدقيق التكرار: ${toArabicDigits(k.totalRecords)} سجل
- السجلات المكررة التي تم استبعادها آلياً: ${toArabicDigits(k.duplicatesRemoved)} سجل

2. النطاق الزمني ومؤشرات التفاعل المرصودة (Temporal Bounds & Engagement Metrics):
تم حصر البيانات للفترة الزمنية (${timeRange})، وتلخص المؤشرات الإجمالية التالية التفاعل العام المرصود:
- إجمالي المشاهدات المسجلة: ${toArabicDigits(k.totalViews)}
- إجمالي الإعجابات والتفاعلات: ${toArabicDigits(k.totalLikes)}
- إجمالي إعادة النشر والمشاركات: ${toArabicDigits(k.totalShares)}
- إجمالي الردود والتعليقات: ${toArabicDigits(k.totalComments)}
- نسبة اكتمال الحقول الخالية من القيم المفقودة: ${toArabicDigits(k.dataCompletenessPct)}%

3. النزاهة المنهجية ومحددات التحليل (Methodological Integrity & Limitations):
- نقل المؤشرات: جرى نقل النصوص والمقاييس الرقمية بدقة دون أي تحوير أو ترجيح إحصائي أو توليد اصطناعي.
- طبيعة العينة: تمثل هذه البيانات عينة رصدية محددة بضوابط ومعايير الاستعلام المعتمدة، ولا تشكل بالضرورة عينة احتمالية عشوائية تمثيلية لكافة مجتمع المنصة.
- أخلاقيات البحث: اقتصر الجمع على المحتوى المنشور علناً في المصادر المتاحة دون الالتفاف على أي قيود خصوصية.`;
    }

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
      { success: false, error: err.message || "حدث خطأ أثناء إعداد توثيق المنهجية." },
      { status: 500 }
    );
  }
}
