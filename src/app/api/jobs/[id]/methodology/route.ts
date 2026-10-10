import { NextRequest, NextResponse } from "next/server";
import { Client as ServerClient, TablesDB, Storage, Client as UserClient, Account } from "node-appwrite";
import { reserveCredits, completeJobWithRelFirst, getBalance } from "../../../../../functions/shared/ledger";

const endpoint = process.env.NEXT_PUBLIC_APPWRITE_ENDPOINT || "https://cloud.appwrite.io/v1";
const projectId = process.env.NEXT_PUBLIC_APPWRITE_PROJECT_ID || "6ac947090008606ef482";
const apiKey = process.env.APPWRITE_API_KEY!;

const serverClient = new ServerClient()
  .setEndpoint(endpoint)
  .setProject(projectId)
  .setKey(apiKey);

const tables = new TablesDB(serverClient);
const storage = new Storage(serverClient);

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

    // 1. Authenticate caller strictly via JWT or session cookie
    const authHeader = req.headers.get("authorization");
    const bearerJwt = authHeader?.startsWith("Bearer ") ? authHeader.substring(7).trim() : null;
    const sessionCookie =
      req.cookies.get(`a_session_${projectId}`)?.value ||
      req.cookies.get(`a_session_${projectId}_legacy`)?.value;

    if (!bearerJwt && !sessionCookie) {
      return NextResponse.json({ success: false, error: "غير مصرح. يرجى تسجيل الدخول أولاً." }, { status: 401 });
    }

    const userClient = new UserClient().setEndpoint(endpoint).setProject(projectId);
    if (bearerJwt) userClient.setJWT(bearerJwt);
    else if (sessionCookie) userClient.setSession(sessionCookie);

    let verifiedUserId: string;
    try {
      const userAccount = new Account(userClient);
      const userDoc = await userAccount.get();
      verifiedUserId = userDoc.$id;
    } catch {
      return NextResponse.json({ success: false, error: "انتهت صلاحية الجلسة." }, { status: 401 });
    }

    // 2. Fetch Job Document & verify ownership
    const jobDoc: any = await tables.getRow({
      databaseId: "digr",
      tableId: "jobs",
      rowId: jobId,
    });

    if (jobDoc.userId !== verifiedUserId) {
      return NextResponse.json({ success: false, error: "غير مصرح بالوصول لهذا الطلب." }, { status: 403 });
    }

    // 3. Verify points balance before charging
    const currentBalance = await getBalance(tables, verifiedUserId);
    if (currentBalance < METHODOLOGY_DEFAULT_POINTS) {
      return NextResponse.json(
        {
          success: false,
          error: `الرصيد غير كافٍ. يلزم ${METHODOLOGY_DEFAULT_POINTS} نقاط لصياغة المنهجية الأكاديمية (رصيدك الحالي: ${currentBalance} نقطة).`,
        },
        { status: 400 }
      );
    }

    // 4. Ledger Flow: Reserve then Charge deterministic points
    const methJobKey = `meth_${jobId}`;
    try {
      await reserveCredits(tables, verifiedUserId, methJobKey, METHODOLOGY_DEFAULT_POINTS, "حجز نقاط صياغة المنهجية");
      await completeJobWithRelFirst(tables, verifiedUserId, methJobKey, METHODOLOGY_DEFAULT_POINTS, METHODOLOGY_DEFAULT_POINTS, "خصم تكلفة صياغة المنهجية");
    } catch (ledgerErr: any) {
      return NextResponse.json(
        { success: false, error: "تعذر حجز وتسوية نقاط المنهجية: " + ledgerErr.message },
        { status: 400 }
      );
    }

    // 5. Read real run facts from server-only storage
    let profileData: any = null;
    let rowsCount = jobDoc.rowsCollected || 1;
    try {
      let jsonBuf: ArrayBuffer;
      try {
        jsonBuf = await storage.getFileDownload("job_data", `json_${jobId}`);
      } catch {
        jsonBuf = await storage.getFileDownload("results", `json_${jobId}`);
      }
      const jsonText = Buffer.from(jsonBuf).toString("utf-8");
      const parsed = JSON.parse(jsonText);
      profileData = parsed.profile || null;
      if (Array.isArray(parsed.rows) && parsed.rows.length > 0) {
        rowsCount = parsed.rows.length;
      }
    } catch {
      // Fallback to job document params if file read fails
    }

    const facts = {
      platform: "TikTok",
      account: profileData?.uniqueId ? `@${profileData.uniqueId}` : profileData?.username || `@${jobDoc.templateSlug || "account"}`,
      displayName: profileData?.nickname || profileData?.displayName || "",
      verifiedStatus: profileData?.verified ? "موثق رسمياً" : "غير موثق",
      followers: Number(profileData?.followerCount ?? profileData?.followers ?? 0),
      likes: Number(profileData?.heartCount ?? profileData?.likes ?? 0),
      videosCount: Number(profileData?.videoCount ?? profileData?.videosCount ?? 0),
      date: (jobDoc.finishedAt || jobDoc.createdAt || new Date().toISOString()).split("T")[0],
      recordsCount: rowsCount,
    };

    // 6. Strict Academic Methodology text: derived ONLY from run facts, zero outside numbers
    const methodologyStatement = `### توثيق المنهجية الأكاديمية (Academic Methodology Statement)

1. مصدر البيانات وأصلها (Data Provenance):
تم جمع بيانات هذه الدراسة بصورة آلية ومباشرة عبر منصة Digr من المصدر العلني المتاح على منصة ${facts.platform} للحساب (${facts.account})${facts.displayName ? ` - [${facts.displayName}]` : ""}، وحالة التوثيق (${facts.verifiedStatus}).

2. النطاق الزمني والتغطية (Temporal Bounds & Coverage):
أُجريت عملية الاستخراج بتاريخ ${facts.date}. وتمثل المؤشرات الرقمية لقطة مقطعية (Cross-sectional Snapshot) لحظية دقيقة للحساب في تاريخ الجمع:
- إجمالي عدد المتابعين: ${facts.followers}
- إجمالي عدد الإعجابات: ${facts.likes}
- إجمالي عدد المقاطع المنشورة: ${facts.videosCount}
- إجمالي السجلات المستخرجة: ${facts.recordsCount} سجل

3. النزاهة المنهجية ومحددات التحليل (Integrity & Methodological Constraints):
- سلامة المؤشرات: نُقلت الأرقام كما هي معلنة دون أي معالجة أو تقريب أو ترجيح إحصائي اصطناعي.
- حدود العينة: هذه البيانات مستخلصة لحساب فردي محدد وتصلح لأغراض دراسة الحالة (Case Study) والتحليل المقارن، ولا تمثل عينة احتمالية عشوائية لعموم مستخدمي المنصة.`;

    const remainingBalance = await getBalance(tables, verifiedUserId);

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
