import { NextRequest, NextResponse } from "next/server";
import { createAdminClient, createServerSideClient } from "@/lib/supabase/server";
import { isSafeRequestId } from "@/lib/requests/facts";
import { isMissingSchema, withTimeout, TIMED_OUT } from "@/lib/server/multiProvider/jobGroupShared";
import { GROUP_PARTS_UNAVAILABLE_AR } from "@/lib/multiProvider/copy";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id: jobId } = await params;
    if (!jobId || jobId.length > 120 || !isSafeRequestId(jobId)) {
      return NextResponse.json({ success: false, error: "معرف الطلب مطلوب" }, { status: 400 });
    }

    const supabase = await createServerSideClient();
    const authHeader = req.headers.get("authorization");
    const { data } = authHeader?.startsWith("Bearer ")
      ? await supabase.auth.getUser(authHeader.substring(7).trim())
      : await supabase.auth.getUser();
    const user = data?.user;
    if (!user) {
      return NextResponse.json({ success: false, error: "غير مصرح. يرجى تسجيل الدخول أولاً." }, { status: 401 });
    }

    const admin = createAdminClient();

    // (1) job_group_parts.select("group_id").eq("job_id", id).maybeSingle()
    const partLookupRes = await withTimeout(
      admin.from("job_group_parts").select("group_id").eq("job_id", jobId).maybeSingle(),
      4000
    );
    if (partLookupRes === TIMED_OUT) {
      return NextResponse.json({ success: false, error: GROUP_PARTS_UNAVAILABLE_AR }, { status: 503 });
    }
    if (partLookupRes.error) {
      if (isMissingSchema(partLookupRes.error)) {
        return NextResponse.json({ success: true, parts: [], total: 0 }, { headers: { "Cache-Control": "no-store" } });
      }
      return NextResponse.json({ success: false, error: GROUP_PARTS_UNAVAILABLE_AR }, { status: 503 });
    }
    const groupId = partLookupRes.data?.group_id;
    if (!groupId) {
      return NextResponse.json({ success: true, parts: [], total: 0 }, { headers: { "Cache-Control": "no-store" } });
    }

    // (2) job_groups.select("user_id, parts_planned").eq("id", groupId).maybeSingle()
    const groupRes = await withTimeout(
      admin.from("job_groups").select("user_id, parts_planned").eq("id", groupId).maybeSingle(),
      4000
    );
    if (groupRes === TIMED_OUT) {
      return NextResponse.json({ success: false, error: GROUP_PARTS_UNAVAILABLE_AR }, { status: 503 });
    }
    if (groupRes.error) {
      if (isMissingSchema(groupRes.error)) {
        return NextResponse.json({ success: true, parts: [], total: 0 }, { headers: { "Cache-Control": "no-store" } });
      }
      return NextResponse.json({ success: false, error: GROUP_PARTS_UNAVAILABLE_AR }, { status: 503 });
    }
    const group = groupRes.data;
    if (!group || group.user_id !== user.id) {
      return NextResponse.json({ success: true, parts: [], total: 0 }, { headers: { "Cache-Control": "no-store" } });
    }

    const partsPlanned = typeof group.parts_planned === "number" ? group.parts_planned : 0;

    // (3) job_group_parts.select("part_index, job_id").eq("group_id", groupId).order("part_index")
    const partsRes = await withTimeout(
      admin.from("job_group_parts").select("part_index, job_id").eq("group_id", groupId).order("part_index"),
      4000
    );
    if (partsRes === TIMED_OUT || partsRes.error) {
      return NextResponse.json({ success: false, error: GROUP_PARTS_UNAVAILABLE_AR }, { status: 503 });
    }
    const partRows = (partsRes.data as Array<{ part_index: number; job_id: string }> | null) ?? [];
    if (partRows.length === 0) {
      return NextResponse.json({ success: true, parts: [], total: partsPlanned }, { headers: { "Cache-Control": "no-store" } });
    }

    const partJobIds = partRows.map((p) => p.job_id);

    // jobs.select("id, status, delivered_units, target_volume_max, charged_credits").eq("user_id", user.id).in("id", partJobIds)
    const jobsRes = await withTimeout(
      admin.from("jobs").select("id, status, delivered_units, target_volume_max, charged_credits").eq("user_id", user.id).in("id", partJobIds),
      4000
    );
    if (jobsRes === TIMED_OUT || jobsRes.error) {
      return NextResponse.json({ success: false, error: GROUP_PARTS_UNAVAILABLE_AR }, { status: 503 });
    }

    const jobRows = (jobsRes.data as Array<{ id: string; status: string; delivered_units: number | null; target_volume_max: number | null; charged_credits: number | null }> | null) ?? [];
    const jobMap = new Map<string, (typeof jobRows)[0]>();
    for (const j of jobRows) {
      jobMap.set(j.id, j);
    }

    // (4) 200 { success: true, total: parts_planned, parts: [{ index, jobId, status, delivered, requested, charged }] } in part order.
    const parts = partRows.map((p) => {
      const job = jobMap.get(p.job_id);
      return {
        index: p.part_index,
        jobId: p.job_id,
        status: job?.status ?? "pending",
        delivered: typeof job?.delivered_units === "number" ? job.delivered_units : null,
        requested: typeof job?.target_volume_max === "number" ? job.target_volume_max : null,
        charged: typeof job?.charged_credits === "number" ? job.charged_credits : null,
      };
    });

    return NextResponse.json(
      {
        success: true,
        total: partsPlanned,
        parts,
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch {
    return NextResponse.json({ success: false, error: GROUP_PARTS_UNAVAILABLE_AR }, { status: 503 });
  }
}
