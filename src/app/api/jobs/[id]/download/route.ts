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
      // On-demand generation from data.json if specific format is missing
      let jsonText = "";
      const jsonCandidatePaths = [
        `${job.user_id}/${jobId}/data.json`,
        `${user.id}/${jobId}/data.json`,
        `${jobId}/data.json`,
        `json_${jobId}`,
      ];

      for (const bucketName of ["results", "partials"]) {
        if (jsonText) break;
        const bucket = adminClient.storage?.from?.(bucketName);
        if (!bucket || typeof bucket.download !== "function") continue;
        for (const p of jsonCandidatePaths) {
          const { data: blob, error: dlErr } = await bucket.download(p);
          if (!dlErr && blob) {
            jsonText = await blob.text();
            break;
          }
        }
      }

      if (jsonText) {
        try {
          const parsed = JSON.parse(jsonText);
          const { generateExcelReport, generateCsvReport, generatePdfReport } = await import(
            "@/functions/shared/fileGenerators"
          );

          let fileBuf: Buffer | null = null;
          let mimeType = "application/octet-stream";

          if (format === "xlsx") {
            fileBuf = await generateExcelReport(parsed);
            mimeType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
          } else if (format === "csv") {
            fileBuf = generateCsvReport(parsed);
            mimeType = "text/csv";
          } else if (format === "pdf") {
            fileBuf = await generatePdfReport(parsed);
            mimeType = "application/pdf";
          } else if (format === "json") {
            fileBuf = Buffer.from(JSON.stringify(parsed, null, 2), "utf-8");
            mimeType = "application/json";
          }

          if (fileBuf) {
            const uploadPath = `${job.user_id}/${jobId}/result.${format}`;
            await adminClient.storage.from("results").upload(uploadPath, fileBuf, {
              contentType: mimeType,
              upsert: true,
            });

            const { data: newlySigned } = await adminClient.storage
              .from("results")
              .createSignedUrl(uploadPath, 300, { download: downloadFileName });

            if (newlySigned?.signedUrl) {
              signedUrl = newlySigned.signedUrl;
            }
          }
        } catch (genErr) {
          console.error("On-demand file generation error:", genErr);
        }
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
