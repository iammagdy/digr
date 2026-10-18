import { NextRequest, NextResponse } from "next/server";
import { createServerSideClient, createAdminClient } from "@/lib/supabase/server";
import { normalizeDataset } from "@/lib/server/normalizationPipeline";
import { inferSocialRowKind } from "@/lib/server/socialRows";
import { producedFormats } from "@/lib/producedFormats";

export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: jobId } = await params;
    if (!jobId) {
      return NextResponse.json({ success: false, error: "معرف الطلب مطلوب" }, { status: 400 });
    }

    // 1. Authenticate caller strictly via Supabase JWT or session cookie
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

    // 2. Fetch Job Document
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
      return NextResponse.json({ success: false, error: "غير مصرح بعرض هذا الطلب." }, { status: 403 });
    }

    // 3. Read JSON result from private storage bucket (results or partials)
    try {
      let jsonText = "";
      const candidatePaths = [
        `${jobDoc.user_id}/${jobId}/data.json`,
        `${verifiedUserId}/${jobId}/data.json`,
        `${jobId}/data.json`,
        `json_${jobId}`,
      ];

      for (const bucketName of ["results", "partials"]) {
        if (jsonText) break;
        const bucket = adminClient.storage?.from?.(bucketName);
        if (!bucket || typeof bucket.download !== "function") continue;
        for (const path of candidatePaths) {
          const { data: blob, error: dlErr } = await bucket.download(path);
          if (!dlErr && blob) {
            jsonText = await blob.text();
            break;
          }
        }
      }

      if (!jsonText) {
        throw new Error("Result file not found");
      }

      // Formats that exist for this job; a format outside the approved plan is generated only on request.
      let fileIds: { xlsx: string | null; pdf: string | null; csv: string | null } | null = null;
      try {
        const { data: versionRows } = await adminClient
          .from("artifact_versions")
          .select("file_id_xlsx, file_id_pdf, file_id_csv")
          .eq("job_id", jobId)
          .eq("user_id", jobDoc.user_id)
          .order("version_number", { ascending: false })
          .limit(1);
        const latest = versionRows?.[0];
        if (latest) {
          fileIds = {
            xlsx: latest.file_id_xlsx || null,
            pdf: latest.file_id_pdf || null,
            csv: latest.file_id_csv || null,
          };
        }
      } catch {
        // Without the artifact record the page falls back to the default format only.
      }

      const parsedData = JSON.parse(jsonText);
      parsedData.metadata = parsedData.metadata && typeof parsedData.metadata === "object" ? parsedData.metadata : {};
      parsedData.metadata.template ||= jobDoc.template_slug || jobDoc.endpoint_id;
      const normalized = normalizeDataset(parsedData, {
        platform: jobDoc.platform || undefined,
        title: parsedData.metadata?.title || `بيانات ${jobDoc.template_slug || jobDoc.endpoint_id}`,
        jobId,
        socialKind: inferSocialRowKind(jobDoc.endpoint_id, jobDoc.template_slug, jobDoc.capability_slug, jobDoc.platform),
      });

      return NextResponse.json({
        success: true,
        jobId,
        status: jobDoc.status,
        templateSlug: jobDoc.template_slug || jobDoc.endpoint_id,
        metadata: {
          platform: normalized.metadata.platform,
          title: normalized.metadata.title,
          collectedAt: jobDoc.finished_at || jobDoc.created_at || normalized.metadata.collectedAt,
          rowsCount: jobDoc.delivered_units || normalized.rows.length,
          methodology: normalized.metadata.methodology,
          entityType: normalized.metadata.entityType,
        },
        profile: {
          ...(normalized.profile || {}),
          sourcePlatform: normalized.metadata.platform,
          collectedDate: jobDoc.finished_at || jobDoc.created_at || normalized.metadata.collectedAt,
          methodology: normalized.metadata.methodology,
        },
        rows: normalized.rows,
        columns: normalized.columns,
        codebook: normalized.codebook,
        kpis: normalized.kpis,
        chargedCredits: jobDoc.charged_credits,
        finishedAt: jobDoc.finished_at,
        fileIds,
        producedFormats: producedFormats(fileIds),
      });
    } catch {
      // If JSON file doesn't exist yet (e.g. still running, failed, or older job)
      return NextResponse.json({
        success: true,
        jobId,
        status: jobDoc.status,
        templateSlug: jobDoc.template_slug || jobDoc.endpoint_id,
        errorAr: jobDoc.error_message || null,
        profile: null,
        rows: [],
      });
    }
  } catch (err: any) {
    console.error(`Error in /api/jobs/[id]/data:`, err);
    return NextResponse.json(
      { success: false, error: "تعذر تحميل بيانات الطلب حالياً. يرجى المحاولة لاحقاً." },
      { status: 500 }
    );
  }
}
