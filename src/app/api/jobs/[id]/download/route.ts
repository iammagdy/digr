import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { createServerSideClient, createAdminClient } from "@/lib/supabase/server";
import { detectCountryFromText, detectIndustryFromText } from "@/lib/planParameters";
import { generateExcelReport, generateCsvReport, generatePdfReport } from "@/functions/shared/fileGenerators";

export const dynamic = "force-dynamic";

async function linkPdfArtifactVersion(adminClient: any, userId: string, jobId: string, storagePath: string) {
  const table = adminClient.from("artifact_versions");
  const { data: version, error: readError } = await table
    .select("id")
    .eq("job_id", jobId)
    .eq("user_id", userId)
    .eq("version_number", 1)
    .maybeSingle();

  if (readError) throw new Error("PDF_ARTIFACT_VERSION_READ_FAILED");

  if (version?.id) {
    const { error } = await table.update({ file_id_pdf: storagePath }).eq("id", version.id).eq("user_id", userId);
    if (error) throw new Error("PDF_ARTIFACT_VERSION_UPDATE_FAILED");
    return;
  }

  const id = `ver_${createHash("sha256").update(jobId).digest("hex").slice(0, 20)}_1`;
  const { error } = await table.insert({
    id,
    job_id: jobId,
    user_id: userId,
    version_number: 1,
    file_id_xlsx: null,
    file_id_pdf: storagePath,
    file_id_csv: null,
    created_at: new Date().toISOString(),
  });
  if (error) throw new Error("PDF_ARTIFACT_VERSION_INSERT_FAILED");
}

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

    let country = "مصر";
    let industry = "شركات";
    const count = job.delivered_units || job.rows_collected || job.target_volume_max || 1;
    const date = (job.finished_at || job.created_at || new Date().toISOString()).split("T")[0];

    const sourceText = `${job.brief || ""} ${job.search_query || ""} ${job.template_slug || ""}`;
    const detectedC = detectCountryFromText(sourceText);
    if (detectedC?.arabicLabel) {
      country = detectedC.arabicLabel;
    }
    const detectedInd = detectIndustryFromText(sourceText);
    if (detectedInd?.arabicLabel) {
      industry = detectedInd.arabicLabel;
    }

    const isCompanyJob =
      job.platform === "companies" ||
      job.template_slug?.includes("compan") ||
      job.template_slug?.includes("b2b");

    let downloadFileName = isCompanyJob
      ? `${industry} في ${country} - ${count} شركة - ${date}.${format}`
      : `${job.template_slug || "بيانات"} - ${count} سجل - ${date}.${format}`;

    downloadFileName = downloadFileName.replace(/[/\\?%*:|"<>]/g, "-").trim();

    // 4. Candidate file paths in results storage bucket
    const candidatePaths: string[] = [];

    // Query artifact_versions to link directly to stored artifacts
    try {
      const { data: avRows } = await adminClient
        .from("artifact_versions")
        .select("file_id_xlsx, file_id_pdf, file_id_csv")
        .eq("job_id", jobId)
        .order("version_number", { ascending: false })
        .limit(1);

      const latestAv = avRows?.[0];
      if (latestAv) {
        if (format === "pdf" && latestAv.file_id_pdf) candidatePaths.push(latestAv.file_id_pdf);
        if (format === "xlsx" && latestAv.file_id_xlsx) candidatePaths.push(latestAv.file_id_xlsx);
        if (format === "csv" && latestAv.file_id_csv) candidatePaths.push(latestAv.file_id_csv);
      }
    } catch {
      // Non-blocking fallback to candidate paths
    }

    candidatePaths.push(
      `${job.user_id}/${jobId}/result.${format}`,
      `${user.id}/${jobId}/result.${format}`,
      `${jobId}/result.${format}`,
      `${job.user_id}/${jobId}/data.${format}`,
      `${user.id}/${jobId}/data.${format}`,
      `${user.id}/${jobId}/${format}_${jobId}.${format}`,
      `${jobId}/data.${format}`,
      `${jobId}/${format}_${jobId}.${format}`
    );

    if (format === "pdf") {
      candidatePaths.push(
        `${job.user_id}/${jobId}/methodology.pdf`,
        `${user.id}/${jobId}/methodology.pdf`,
        `${jobId}/methodology.pdf`
      );
    }

    let signedUrl: string | null = null;
    let resolvedStoragePath: string | null = null;

    // Check existing candidate files
    for (const path of candidatePaths) {
      const { data: signed, error: signErr } = await adminClient.storage
        .from("results")
        .createSignedUrl(path, 300, { download: downloadFileName });

      if (!signErr && signed?.signedUrl) {
        signedUrl = signed.signedUrl;
        resolvedStoragePath = path;
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
        `partials/${jobId}/data.json`,
        `${jobId}/step_0.json`,
        `json_${jobId}`,
      ];

      for (const bucketName of ["partials", "results"]) {
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
            const { error: uploadError } = await adminClient.storage.from("results").upload(uploadPath, fileBuf, {
              contentType: mimeType,
              upsert: true,
            });
            if (uploadError) throw uploadError;

            // Keep artifact_versions permanently in sync with the generated artifact
            try {
              const fieldToUpdate = format === "pdf" ? "file_id_pdf" : format === "xlsx" ? "file_id_xlsx" : "file_id_csv";
              const { data: existingAv } = await adminClient
                .from("artifact_versions")
                .select("id")
                .eq("job_id", jobId)
                .maybeSingle();

              if (existingAv?.id) {
                await adminClient
                  .from("artifact_versions")
                  .update({ [fieldToUpdate]: uploadPath })
                  .eq("id", existingAv.id);
              } else {
                await adminClient
                  .from("artifact_versions")
                  .insert({
                    id: `ver_${jobId.replace(/^job_quote_/, "").slice(0, 20)}_1`,
                    job_id: jobId,
                    user_id: job.user_id,
                    version_number: 1,
                    [fieldToUpdate]: uploadPath,
                    created_at: new Date().toISOString(),
                  });
              }
            } catch (syncErr) {
              console.warn("Could not sync artifact_versions on demand:", syncErr);
            }

            const { data: newlySigned, error: signError } = await adminClient.storage
              .from("results")
              .createSignedUrl(uploadPath, 300, { download: downloadFileName });

            if (!signError && newlySigned?.signedUrl) {
              signedUrl = newlySigned.signedUrl;
              resolvedStoragePath = uploadPath;
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

    if (format === "pdf" && resolvedStoragePath) {
      await linkPdfArtifactVersion(adminClient, job.user_id, jobId, resolvedStoragePath);
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
