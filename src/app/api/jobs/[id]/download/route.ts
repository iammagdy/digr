import { NextRequest, NextResponse } from "next/server";
import { createServerSideClient, createAdminClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * Download job results using short-lived signed URLs from the private results bucket.
 * Strictly checks that the caller owns the job (or has role: admin).
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: jobId } = await params;
    if (!jobId) {
      return NextResponse.json({ success: false, error: "معرف الطلب مطلوب" }, { status: 400 });
    }

    // 1. Authenticate caller strictly via Supabase
    const supabase = await createServerSideClient();
    const authHeader = req.headers.get("authorization");
    let user = null;

    if (authHeader?.startsWith("Bearer ")) {
      const token = authHeader.substring(7).trim();
      const { data } = await supabase.auth.getUser(token);
      user = data?.user;
    } else {
      const { data } = await supabase.auth.getUser();
      user = data?.user;
    }

    if (!user) {
      return NextResponse.json({ success: false, error: "غير مصرح. يرجى تسجيل الدخول أولاً." }, { status: 401 });
    }

    const adminClient = createAdminClient();

    // 2. Fetch Job and check ownership
    const { data: job, error: jobErr } = await adminClient
      .from("jobs")
      .select("*")
      .eq("id", jobId)
      .single();

    if (jobErr || !job) {
      return NextResponse.json({ success: false, error: "الطلب غير موجود" }, { status: 404 });
    }

    const isAdmin = user.app_metadata?.role === "admin";
    if (job.user_id !== user.id && !isAdmin) {
      return NextResponse.json({ success: false, error: "غير مصرح لك بتحميل نتائج هذا الطلب." }, { status: 403 });
    }

    // 3. Format and filename selection
    const format = (req.nextUrl.searchParams.get("format") || "csv").toLowerCase();
    const allowedFormats = ["csv", "xlsx", "pdf", "json"];
    if (!allowedFormats.includes(format)) {
      return NextResponse.json({ success: false, error: "صيغة الملف غير مدعومة" }, { status: 400 });
    }

    const downloadFileName = `digr_${job.template_slug || "dataset"}_${jobId.slice(0, 8)}.${format}`;

    // 4. Candidate file paths in results storage bucket
    const candidatePaths = [
      `${job.user_id}/${jobId}/result.${format}`,
      `${user.id}/${jobId}/result.${format}`,
      `${jobId}/result.${format}`,
      `${job.user_id}/${jobId}/data.${format}`,
      `${user.id}/${jobId}/data.${format}`,
      `${user.id}/${jobId}/${format}_${jobId}.${format}`,
      `${jobId}/data.${format}`,
      `${jobId}/${format}_${jobId}.${format}`,
      `${jobId}/data.json`,
      `results/${jobId}/data.json`,
    ];

    let signedUrl: string | null = null;

    // Check existing candidate files
    for (const path of candidatePaths) {
      const { data: signed, error: signErr } = await adminClient.storage
        .from("results")
        .createSignedUrl(path, 300, { download: downloadFileName });

      if (!signErr && signed?.signedUrl) {
        signedUrl = signed.signedUrl;
        break;
      }
    }

    if (!signedUrl) {
      // If result file is not yet generated or found in candidates, check if raw json exists
      const { data: jsonSigned } = await adminClient.storage
        .from("results")
        .createSignedUrl(`${jobId}/data.json`, 300, { download: downloadFileName });

      if (jsonSigned?.signedUrl) {
        signedUrl = jsonSigned.signedUrl;
      }
    }

    if (!signedUrl) {
      return NextResponse.json(
        { success: false, error: "الملف المطلوب غير جاهز للتحميل بعد أو انتهت صلاحيته." },
        { status: 404 }
      );
    }

    // If caller requested direct redirect
    if (req.nextUrl.searchParams.get("redirect") === "true") {
      return NextResponse.redirect(signedUrl, 302);
    }

    return NextResponse.json({
      success: true,
      jobId,
      format,
      downloadFileName,
      signedUrl,
      expiresInSeconds: 300,
    });
  } catch (err: any) {
    console.error("Job download error:", err);
    return NextResponse.json(
      { success: false, error: "حدث خطأ أثناء إنشاء رابط التحميل." },
      { status: 500 }
    );
  }
}
