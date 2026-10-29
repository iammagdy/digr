import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { createServerSideClient, createAdminClient } from "@/lib/supabase/server";
import { detectCountryFromText, detectIndustryFromText } from "@/lib/planParameters";
import {
  generateExcelReport, generateCsvReport, generatePdfReport,
  generateShapedExcelReport, shapedPayload, FileShapeError,
} from "@/functions/shared/fileGenerators";
import { decodeFileSpec, validateFileSpec, type FileSpec } from "@/lib/fileSpec";
import { normalizeDataset } from "@/lib/server/normalizationPipeline";
import { deliveredNothing, NO_RELEASABLE_RESULT_AR, resultsReleasable } from "@/lib/producedFormats";
import { linkArtifactVersion } from "@/functions/shared/artifactVersionLinking";
import { customerFacingConversationTitle } from "@/lib/customerFacingConversationTitle";
import { missionDownloadName } from "@/lib/agentMission/fileNames";
import { inferSocialRowKind } from "@/lib/server/socialRows";
import { buildFacebookReportExcelFrom, buildFacebookReportPdfFrom, facebookReportOf } from "@/functions/shared/facebookReportFiles";

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

    // A failed request that delivered no record has no file: say so plainly, before anything is read, created or priced.
    if (deliveredNothing({ status: job.status, delivered: job.delivered_units })) {
      return NextResponse.json(
        { success: false, error: "لا يوجد ملف لتحميله لأن هذا الطلب لم يُسلّم أي سجل، ولم يُخصم منك أي رصيد." },
        { status: 409 }
      );
    }

    // A request that did not settle and charge has no result to release, whatever was saved before settlement (a failed request that delivered nothing is answered above): checked before anything is read, created or priced.
    if (!resultsReleasable(job)) {
      return NextResponse.json({ success: false, error: NO_RELEASABLE_RESULT_AR }, { status: 409 });
    }

    // File formats can be generated later from the saved dataset, even when
    // the customer did not choose them before the search.
    let quoteSummary: string | null = null;
    let originalRequestText = "";
    try {
      const { data: quoteRows } = await adminClient
        .from("plans_quotes")
        .select("id, summary_ar")
        .eq("user_id", job.user_id)
        .eq("status", "accepted");
      const quote = (quoteRows || []).find((row: any) => {
        const quoteId = String(row?.id || "");
        return quoteId && (`job_quote_${createHash("md5").update(quoteId).digest("hex")}` === jobId || quoteId === jobId);
      });
      if (quote && typeof quote.summary_ar === "string") quoteSummary = quote.summary_ar;
      if (quote?.id) {
        const { data: quoteMessages } = await adminClient
          .from("messages")
          .select("conversation_id")
          .eq("user_id", job.user_id)
          .eq("quote->>quoteId", quote.id)
          .not("quote", "is", null)
          .limit(1);
        const conversationId = quoteMessages?.[0]?.conversation_id;
        if (conversationId) {
        const { data: messages } = await adminClient
          .from("messages")
          .select("content_ar, role, created_at")
          .eq("user_id", job.user_id)
          .eq("conversation_id", conversationId)
          .eq("role", "user")
          .order("created_at", { ascending: true });
        const originalMessage = (messages || []).find((message: any) =>
          typeof message.content_ar === "string" &&
          customerFacingConversationTitle(message.content_ar) !== "محادثة جديدة"
        );
        originalRequestText = typeof originalMessage?.content_ar === "string" ? originalMessage.content_ar : "";
        }
      }
    } catch {
      // Existing artifact links remain available when quote history is unavailable.
    }

    // 3. Format and filename selection
    const format = (req.nextUrl.searchParams.get("format") || "csv").toLowerCase();
    const allowedFormats = ["csv", "xlsx", "pdf", "json"];
    if (!allowedFormats.includes(format)) {
      return NextResponse.json({ success: false, error: "صيغة الملف غير مدعومة" }, { status: 400 });
    }

    let country = "الدولة غير محددة";
    let industry = "النشاط غير محدد";
    const isUsefulIndustryLabel = (label?: string) => Boolean(
      label && label !== country && label !== "قواعد بيانات الشركات" && !/يلزم تحديد النشاط|النشاط غير محدد|دليل|المصادر|مصادر متاحة|أعادت|التي|results?|dataset|icypeas|endpoint|provider|search/i.test(label)
    );
    const count = job.delivered_units || job.rows_collected || job.target_volume_max || 1;
    const date = (job.finished_at || job.created_at || new Date().toISOString()).split("T")[0];

    const paramsText = typeof job.params === "string" ? job.params : JSON.stringify(job.params || {});
    const sourceText = `${originalRequestText} ${job.brief || ""} ${job.search_query || ""} ${paramsText}`;
    const detectedC = detectCountryFromText(sourceText);
    if (detectedC?.arabicLabel) {
      country = detectedC.arabicLabel;
    }
    const detectedInd = detectIndustryFromText(sourceText);
    if (isUsefulIndustryLabel(detectedInd?.arabicLabel)) {
      industry = detectedInd.arabicLabel;
    }

    let isCompanyJob = /company|compan|companies|\bB2B\b|شركة|شركات|مقاولات|مؤسسات/i.test(
      [originalRequestText, job.platform, job.endpoint_id, job.capability_slug, job.template_slug, job.title, job.brief, job.search_query, paramsText, quoteSummary]
        .filter(Boolean).join(" ")
    );

    const titleSource = String(originalRequestText || job.title || job.brief || job.search_query || quoteSummary || "نتائج البحث").trim();
    let downloadFileName = isCompanyJob
      ? `${industry} في ${country} - ${count} شركة - ${date}.${format}`
      : `${titleSource.slice(0, 64)} - ${count} سجل - ${date}.${format}`;

    downloadFileName = downloadFileName.replace(/[/\\?%*:|"<>]/g, "-").trim();

    // 4. Candidate file paths in results storage bucket
    const candidatePaths: string[] = [];

    // Query artifact_versions to link directly to stored artifacts
    try {
      const { data: avRows } = await adminClient
        .from("artifact_versions")
        .select("file_id_xlsx, file_id_pdf, file_id_csv")
        .eq("job_id", jobId)
        .eq("user_id", job.user_id)
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

    // Prefer regenerating deliverable formats from the saved dataset. Existing
    // artifacts can predate quality/layout fixes, and format downloads must
    // never re-run the provider or return stale report layouts.
    let jsonText = "";
    const jsonCandidatePaths = [
      `${job.user_id}/${jobId}/data.json`,
      `${user.id}/${jobId}/data.json`,
      `${jobId}/data.json`,
      `partials/${jobId}/data.json`,
      `${jobId}/step_0.json`,
      `json_${jobId}`,
    ];
    for (const bucketName of ["results", "partials"]) {
      if (jsonText) break;
      const bucket = adminClient.storage?.from?.(bucketName);
      if (!bucket || typeof bucket.download !== "function") continue;
      for (const path of jsonCandidatePaths) {
        const { data: blob, error: downloadError } = await bucket.download(path);
        if (!downloadError && blob) {
          jsonText = await blob.text();
          break;
        }
      }
    }

    // Older job rows do not always carry a company platform slug. The stored
    // result metadata is the most reliable source when building a task name.
    if (jsonText) {
      try {
        const savedPayload = JSON.parse(jsonText);
        const metadata = savedPayload?.metadata || {};
        const firstRow = Array.isArray(savedPayload?.rows) ? savedPayload.rows[0] : null;
        const metadataText = [
          originalRequestText,
          metadata.scope?.country,
          metadata.scope?.industry,
          metadata.country,
          metadata.industry,
        ].filter(Boolean).join(" ");
        isCompanyJob = isCompanyJob || metadata.entityType === "companies" || Boolean(
          firstRow && (firstRow.company_name || firstRow.company_website || firstRow.cr_number)
        );
        if (isCompanyJob) {
          const savedCountry = detectCountryFromText(metadataText);
          const savedIndustry = detectIndustryFromText(originalRequestText || metadataText);
          if (savedCountry?.arabicLabel) country = savedCountry.arabicLabel;
          if (isUsefulIndustryLabel(savedIndustry?.arabicLabel)) {
            industry = savedIndustry.arabicLabel;
          }
          const taskIndustry = isUsefulIndustryLabel(industry) ? industry : "الشركات";
          const taskCountry = country === "الدولة غير محددة" ? "النطاق المطلوب" : country;
          downloadFileName = `${taskIndustry} في ${taskCountry} - ${count} شركة - ${date}.${format}`
            .replace(/[/\\?%*:|"<>]/g, "-").trim();
        }
      } catch {
        // Keep the best task name derived from the approved request metadata.
      }
    }

    // An AGENT mission names its files from the mission itself: what + count + date in Arabic («تغريدات عن محمد صلاح - ٣٠٠ - ٢٨ أكتوبر ٢٠٢٦»), never the generic task title. The name was stored with the files when it
    // was delivered; a mission delivered before that is named the same way from its plan. Nothing here fails the download.
    try {
      const { data: agentMission } = await adminClient.from("missions").select("files, plan, request_text, delivered_units, updated_at").eq("job_id", jobId).maybeSingle();
      if (agentMission && (format === "xlsx" || format === "csv")) {
        // the same function every other download path uses (the completion panel, the admin's link): the stored name, else the name built from the mission
        const named = missionDownloadName({ files: agentMission.files, kind: format, plan: agentMission.plan, requestText: agentMission.request_text, deliveredUnits: Number(agentMission.delivered_units) || count, date: new Date(agentMission.updated_at || job.finished_at || job.created_at || Date.now()) });
        if (!/^result\.(xlsx|csv)$/i.test(named)) downloadFileName = named;
      }
    } catch {
      // the generic name stays
    }

    let signedUrl: string | null = null;
    let resolvedStoragePath: string | null = null;

    // A customer-shaped file («شيت لكل محافظة»): the spec comes from a link, so it is decoded and validated here
    // against the real columns of this job's saved data before anything is built. It never touches the provider.
    let shapedSpec: FileSpec | null = null;
    const specParam = req.nextUrl.searchParams.get("spec");
    if (specParam) {
      if (!jsonText || format === "json") {
        return NextResponse.json({ success: false, error: "بيانات هذا الطلب غير متاحة لتنسيق مخصص بعد." }, { status: 404 });
      }
      let normalized;
      try {
        normalized = normalizeDataset(JSON.parse(jsonText));
      } catch {
        return NextResponse.json({ success: false, error: "تعذر قراءة بيانات هذا الطلب." }, { status: 500 });
      }
      const columns = normalized.columns.map((key) => ({ key, titleAr: normalized.codebook.find((entry) => entry.field === key)?.titleAr || key }));
      const check = validateFileSpec(decodeFileSpec(specParam), columns);
      if (!check.ok) return NextResponse.json({ success: false, error: check.errorAr }, { status: 400 });
      shapedSpec = check.spec;
      downloadFileName = downloadFileName.replace(/(\.[a-z]+)$/i, " - مخصص$1");
    }

    if (jsonText && format !== "json") {
      try {
        const parsed = JSON.parse(jsonText);
        parsed.metadata = parsed.metadata && typeof parsed.metadata === "object" ? parsed.metadata : {};
        parsed.metadata.template ||= job.template_slug || job.endpoint_id;
        parsed.metadata.socialKind ||= inferSocialRowKind(job.endpoint_id, job.template_slug, job.capability_slug, job.platform);
        let fileBuf: Buffer | null = null;
        let mimeType = "application/octet-stream";
        if (format === "xlsx") {
          fileBuf = shapedSpec ? await generateShapedExcelReport(parsed, shapedSpec) : facebookReportOf(parsed) ? await buildFacebookReportExcelFrom(parsed) : await generateExcelReport(parsed);
          mimeType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
        } else if (format === "csv") {
          fileBuf = generateCsvReport(shapedSpec ? shapedPayload(parsed, shapedSpec) : parsed);
          mimeType = "text/csv";
        } else if (format === "pdf") {
          fileBuf = facebookReportOf(parsed) && !shapedSpec ? await buildFacebookReportPdfFrom(parsed) : await generatePdfReport(shapedSpec ? shapedPayload(parsed, shapedSpec) : parsed);
          mimeType = "application/pdf";
        }
        if (fileBuf) {
          // A shaped file lives beside the standard result and never replaces it or becomes the job's linked artifact.
          const shapedKey = shapedSpec ? createHash("sha1").update(JSON.stringify(shapedSpec)).digest("hex").slice(0, 10) : "";
          const uploadPath = shapedSpec ? `${job.user_id}/${jobId}/shaped_${shapedKey}.${format}` : `${job.user_id}/${jobId}/result.${format}`;
          const { error: uploadError } = await adminClient.storage.from("results").upload(uploadPath, fileBuf, {
            contentType: mimeType,
            upsert: true,
          });
          if (uploadError) throw uploadError;
          const { data: newlySigned, error: signError } = await adminClient.storage
            .from("results")
            .createSignedUrl(uploadPath, 300, { download: downloadFileName });
          if (!signError && newlySigned?.signedUrl) {
            signedUrl = newlySigned.signedUrl;
            resolvedStoragePath = uploadPath;
          }
        }
      } catch (genErr) {
        if (genErr instanceof FileShapeError) {
          return NextResponse.json({ success: false, error: genErr.messageAr }, { status: 422 });
        }
        console.error("Saved-data file regeneration error:", genErr);
      }
    }

    if (shapedSpec && !signedUrl) {
      // Never fall back to the standard file when a custom shape was asked for.
      return NextResponse.json({ success: false, error: "تعذر تجهيز الملف بالتنسيق المطلوب الآن. حاول مرة أخرى." }, { status: 500 });
    }

    if (!signedUrl) {
      // Fall back to an existing artifact when the raw saved dataset is not
      // available, or generate JSON from the saved payload on first request.
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

      if (!signedUrl && jsonText) {
        try {
          const parsed = JSON.parse(jsonText);
          const fileBuf = Buffer.from(JSON.stringify(parsed, null, 2), "utf-8");
          const mimeType = "application/json";

          if (fileBuf) {
            const uploadPath = `${job.user_id}/${jobId}/result.${format}`;
            const { error: uploadError } = await adminClient.storage.from("results").upload(uploadPath, fileBuf, {
              contentType: mimeType,
              upsert: true,
            });
            if (uploadError) throw uploadError;

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

    if (!shapedSpec && (format === "pdf" || format === "xlsx" || format === "csv") && resolvedStoragePath) {
      await linkArtifactVersion(adminClient, job.user_id, jobId, format, resolvedStoragePath);
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
