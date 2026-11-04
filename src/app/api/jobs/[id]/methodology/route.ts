import { NextRequest, NextResponse } from "next/server";
import { createServerSideClient, createAdminClient } from "@/lib/supabase/server";
import { generateMethodologyText, generatePdfReport } from "@/functions/shared/fileGenerators";
import { isMethodologyPurchased } from "@/lib/server/methodologyPurchase";
import { buildFacebookReportPdfFrom, facebookReportOf } from "@/functions/shared/facebookReportFiles";
import { AGENT_BUCKET } from "@/lib/agentMission/constants";
import { methodologyMissionOfJob, type MethodologyMission } from "@/lib/agentMission/methodology/missions";
import { readWorkbookMethodology } from "@/lib/agentMission/methodology/readWorkbook";
import { buildMethodologyDocument, METHODOLOGY_DOC_TITLE_AR } from "@/lib/agentMission/methodology/document";
import { renderMethodologyPdf } from "@/lib/agentMission/methodology/pdf";
import { fileResponseFromUrl } from "@/lib/server/fileResponse";

export const dynamic = "force-dynamic";

/** The methodology's price in points (round 21: ٥٠; it was ١٠). The screens show it from `METHODOLOGY_POINTS` (src/lib/methodologyOffer.ts), a test pins the two equal, and a request that names another price is refused (see `expectedPoints`). */
const METHODOLOGY_DEFAULT_POINTS = 50;

const PRICE_CHANGED_AR = "تغيّر سعر المنهجية. حدّث الصفحة ثم أعد المحاولة؛ لم يتم خصم أي نقاط.";

/** The name the customer saves the methodology under: a mission's is «منهجية جمع البيانات - <what was collected>.pdf»; an older job keeps its own. */
function methodologyDownloadName(jobId: string, mission: MethodologyMission | null): string {
  return mission ? `${METHODOLOGY_DOC_TITLE_AR} - ${mission.titleAr}.pdf` : `منهجية البحث - ${jobId.slice(0, 8)}.pdf`;
}

/**
 * THE METHODOLOGY OF A MISSION (round 21): written from the Excel file the customer received (its «المنهجية» section and its sheets), by code. A failed read of the file, a file with no such section or a failed render says why, and the caller charges nothing then.
 */
async function missionMethodologyPdf(admin: any, mission: MethodologyMission): Promise<{ ok: true; pdf: Buffer; statement: string } | { ok: false; status: number; error: string }> {
  try {
    const { data: blob, error } = await admin.storage.from(AGENT_BUCKET).download(`${mission.missionId}/${mission.xlsx.path}`);
    if (error || !blob) return { ok: false, status: 409, error: "تعذر العثور على ملف النتائج؛ لم يتم خصم أي نقاط." };
    const bytes = Buffer.from(typeof blob.arrayBuffer === "function" ? await blob.arrayBuffer() : blob);
    const methodology = await readWorkbookMethodology(bytes);
    if (!methodology) return { ok: false, status: 409, error: "ملف هذا الطلب لا يحمل قسم المنهجية المسجّل؛ لم يتم خصم أي نقاط." };
    const doc = buildMethodologyDocument({ methodology, subtitleAr: mission.titleAr });
    const pdf = await renderMethodologyPdf(doc);
    const citation = methodology.items.find((i) => i.label === "صيغة الاستشهاد المقترحة")?.values[0];
    return { ok: true, pdf, statement: citation ?? `${METHODOLOGY_DOC_TITLE_AR}: ${mission.titleAr}` };
  } catch {
    return { ok: false, status: 503, error: "تعذر تجهيز ملف المنهجية؛ لم يتم خصم أي نقاط." };
  }
}

/**
 * Whether the signed-in owner already bought the methodology file for this job, read from the ledger row `chg_meth_<jobId>` (read-only).
 * With `?file=1` it SERVES the bought file itself (round 20's rule: the site writes the download name in its own header, never the storage service's percent-encoded one): nothing is charged here, and a job that was not bought is refused.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: jobId } = await params;
    if (!jobId) return NextResponse.json({ success: false, error: "معرف الطلب مطلوب" }, { status: 400 });
    const supabase = await createServerSideClient();
    const authHeader = req.headers.get("authorization");
    const { data } = authHeader?.startsWith("Bearer ")
      ? await supabase.auth.getUser(authHeader.substring(7).trim())
      : await supabase.auth.getUser();
    const user = data?.user;
    if (!user) return NextResponse.json({ success: false, error: "غير مصرح. يرجى تسجيل الدخول أولاً." }, { status: 401 });
    const adminClient = createAdminClient();
    const { data: jobDoc } = await adminClient.from("jobs").select("id,user_id").eq("id", jobId).maybeSingle();
    if (!jobDoc) return NextResponse.json({ success: false, error: "الطلب غير موجود." }, { status: 404 });
    if (jobDoc.user_id !== user.id) return NextResponse.json({ success: false, error: "غير مصرح بالوصول لهذا الطلب." }, { status: 403 });
    const purchased = await isMethodologyPurchased(adminClient, { userId: user.id, jobId });
    if (req.nextUrl?.searchParams?.get("file") !== "1") return NextResponse.json({ success: true, purchased });
    if (!purchased) return NextResponse.json({ success: false, error: "لم تشترِ منهجية هذا الطلب بعد." }, { status: 402 });
    const bucket = adminClient.storage.from("results");
    const { data: signed, error: signError } = await bucket.createSignedUrl(`${user.id}/${jobId}/methodology-addon.pdf`, 120);
    if (signError || !signed?.signedUrl) return NextResponse.json({ success: false, error: "تعذر تجهيز رابط تحميل المنهجية." }, { status: 503 });
    const mission = await methodologyMissionOfJob(adminClient, { jobId, userId: user.id });
    return await fileResponseFromUrl(signed.signedUrl, methodologyDownloadName(jobId, mission));
  } catch {
    return NextResponse.json({ success: false, error: "تعذر التحقق من حالة المنهجية حالياً." }, { status: 500 });
  }
}

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
    // ROUND 21: THE CHARGE IS NEVER ABOVE WHAT THE CUSTOMER SAW. The page names the price it showed; a page that shows another one (an old tab that still says ١٠) is refused here, before anything is read or charged.
    if (Number(confirmation?.expectedPoints) !== METHODOLOGY_DEFAULT_POINTS) {
      return NextResponse.json({ success: false, priceChanged: true, required: METHODOLOGY_DEFAULT_POINTS, error: PRICE_CHANGED_AR }, { status: 409 });
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

    // 3. A delivered COMPILED MISSION writes its methodology from the file it delivered (round 21); every other job keeps the saved-data path below, unchanged.
    const mission = await methodologyMissionOfJob(adminClient, { jobId, userId: jobDoc.user_id });

    // Read the completed dataset and render the add-on before charging. A
    // failed read or generation therefore never changes the customer's balance.
    let rawParsed: any = null;
    let methodologyStatement = "";
    let methodologyPdf: Buffer;
    const methodologyPath = `${verifiedUserId}/${jobId}/methodology-addon.pdf`;
    const methodologyBucket = adminClient.storage.from("results");

    if (mission) {
      const built = await missionMethodologyPdf(adminClient, mission);
      if (!built.ok) return NextResponse.json({ success: false, error: built.error }, { status: built.status });
      methodologyPdf = built.pdf;
      methodologyStatement = built.statement;
    } else {
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
      methodologyStatement = generateMethodologyText(reportPayload);

      if (!rawParsed || !Array.isArray(rawParsed.rows) || rawParsed.rows.length === 0) {
        return NextResponse.json({ success: false, error: "تعذر العثور على بيانات الطلب المكتملة؛ لم يتم خصم أي نقاط." }, { status: 409 });
      }

      try {
        // The Facebook topic report has its own methodology and analysis file (the same file its job delivers); every other job keeps the generic one.
        methodologyPdf = facebookReportOf(reportPayload)
          ? await buildFacebookReportPdfFrom(reportPayload)
          : await generatePdfReport({
              ...reportPayload,
              metadata: { ...(reportPayload.metadata || {}), methodology: methodologyStatement },
            });
      } catch {
        return NextResponse.json({ success: false, error: "تعذر تجهيز ملف المنهجية؛ لم يتم خصم أي نقاط." }, { status: 503 });
      }
    }

    const { error: saveError } = await methodologyBucket.upload(
      methodologyPath,
      methodologyPdf,
      { contentType: "application/pdf", upsert: true },
    );
    if (saveError) {
      return NextResponse.json({ success: false, error: "تعذر تجهيز ملف المنهجية؛ لم يتم خصم أي نقاط." }, { status: 503 });
    }
    const downloadName = methodologyDownloadName(jobId, mission);
    const { data: methodologySigned, error: signError } = await methodologyBucket.createSignedUrl(methodologyPath, 60 * 60 * 24 * 90, {
      download: downloadName,
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
      downloadName,
    });
  } catch (err: any) {
    console.error("Error in /api/jobs/[id]/methodology:", err);
    return NextResponse.json(
      { success: false, error: "تعذر إعداد التوثيق المنهجي حالياً. يرجى المحاولة لاحقاً." },
      { status: 500 }
    );
  }
}
