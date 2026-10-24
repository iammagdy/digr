import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { authenticateUser } from "@/lib/server/userAuth";
import { normalizeDataset } from "@/lib/server/normalizationPipeline";
import { inferSocialRowKind } from "@/lib/server/socialRows";
import { buildLivePreviewSample, PREVIEW_MAX_ROWS } from "@/lib/liveJobView";
import { isFacebookKeywordService } from "@/lib/facebookKeywordService";

export const dynamic = "force-dynamic";

/** How many of the newest saved pages are read: the preview needs a handful of rows, not the whole run. */
const PAGES_READ = 2;

/**
 * A live preview of a RUNNING request: a few of the rows already accepted, in the columns the customer reads. Read only: it reads the
 * pages the worker has already saved, writes nothing and touches no money. The rows go through the same cleaning as the finished
 * result. Rows still under review or not matching are never shown. With no accepted row yet (or a finished request, whose rows come from
 * the results route) it answers `sample: null` and the screen shows the counts only.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: jobId } = await params;
    if (!jobId) return NextResponse.json({ success: false, error: "معرف الطلب مطلوب" }, { status: 400 });

    const auth = await authenticateUser(req);
    if (!auth.ok) return auth.response;

    const admin = createAdminClient();
    const { data: job } = await admin
      .from("jobs")
      // Only columns the jobs table has (id, user, status, step, endpoint, delivered units). A column it does not have made the whole query fail, so the
      // job read as «not found» and the panel never received a row.
      .select("id, user_id, status, step, endpoint_id, delivered_units")
      .eq("id", jobId)
      .maybeSingle();
    if (!job) return NextResponse.json({ success: false, error: "الطلب غير موجود." }, { status: 404 });
    if (job.user_id !== auth.user.id && auth.user.appRole !== "admin") {
      return NextResponse.json({ success: false, error: "غير مصرح بعرض هذا الطلب." }, { status: 403 });
    }

    const live = job.status === "queued" || job.status === "running";
    const lastDone = Math.floor(Number(job.step) || 0) - 1;
    if (!live || lastDone < 0) {
      return NextResponse.json({ success: true, status: job.status, delivered: Number(job.delivered_units) || 0, sample: null });
    }

    const bucket = admin.storage?.from?.("partials");
    const rows: Array<Record<string, any>> = [];
    if (bucket && typeof bucket.download === "function") {
      for (let step = lastDone; step >= Math.max(0, lastDone - (PAGES_READ - 1)) && rows.length < PREVIEW_MAX_ROWS; step--) {
        try {
          const { data: blob, error } = await bucket.download(`${jobId}/step_${step}.json`);
          if (error || !blob) continue;
          const parsed = JSON.parse(typeof blob.text === "function" ? await blob.text() : String(blob));
          if (Array.isArray(parsed?.rows)) rows.unshift(...parsed.rows.slice(-(PREVIEW_MAX_ROWS - rows.length)));
        } catch {
          // a page that cannot be read only means fewer rows in the preview
        }
      }
    }
    if (!rows.length) return NextResponse.json({ success: true, status: job.status, delivered: Number(job.delivered_units) || 0, sample: null });

    const normalized = normalizeDataset(
      { rows, metadata: { template: job.endpoint_id } },
      {
        title: "معاينة",
        jobId,
        socialKind: inferSocialRowKind(job.endpoint_id, undefined, undefined, undefined),
      },
    );
    const isCompanyDataset = normalized.metadata.entityType === "companies" || normalized.metadata.entityType === "people";
    const sample = buildLivePreviewSample(normalized.rows, normalized.columns, isCompanyDataset, isFacebookKeywordService(job.endpoint_id));
    return NextResponse.json({ success: true, status: job.status, delivered: Number(job.delivered_units) || 0, sample });
  } catch (err: any) {
    console.warn("[jobs:preview_failed]", String(err?.message || "").slice(0, 120));
    return NextResponse.json({ success: true, sample: null });
  }
}
