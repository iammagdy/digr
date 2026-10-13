import { NextRequest, NextResponse } from "next/server";
import { createServerSideClient, createAdminClient } from "@/lib/supabase/server";

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

      const parsedData = JSON.parse(jsonText);

      // Cleaned customer-facing profile (strictly no provider structure or provider internal IDs)
      const cleanProfile = parsedData.profile ? {
        username: parsedData.profile.uniqueId ? `@${parsedData.profile.uniqueId}` : parsedData.profile.username,
        displayName: parsedData.profile.nickname || parsedData.profile.displayName || "",
        bio: parsedData.profile.signature || parsedData.profile.bio || "",
        verified: Boolean(parsedData.profile.verified),
        followers: Number(parsedData.profile.followerCount ?? parsedData.profile.followers ?? 0),
        following: Number(parsedData.profile.followingCount ?? parsedData.profile.following ?? 0),
        likes: Number(parsedData.profile.heartCount ?? parsedData.profile.likes ?? 0),
        videosCount: Number(parsedData.profile.videoCount ?? parsedData.profile.videosCount ?? 0),
        bioLink: parsedData.profile.bioLink || "",
        profileUrl: parsedData.profile.profileUrl || "",
        collectedDate: parsedData.profile.collectedDate || "",
      } : null;

      // Cleaned rows (customer-facing attributes only)
      const cleanRows = Array.isArray(parsedData.rows) ? parsedData.rows.map((r: any, idx: number) => ({
        id: `rec_${idx + 1}`,
        username: r.username,
        displayName: r.displayName,
        bio: r.bio,
        verified: r.verified,
        followers: r.followers,
        following: r.following,
        likes: r.likes,
        videosCount: r.videosCount,
        bioLink: r.bioLink,
        profileUrl: r.profileUrl,
        collectedDate: r.collectedDate,
      })) : [];

      return NextResponse.json({
        success: true,
        jobId,
        status: jobDoc.status,
        templateSlug: jobDoc.template_slug || jobDoc.endpoint_id,
        metadata: {
          platform: "Digr Data Platform",
          title: parsedData.metadata?.title || `بيانات ${jobDoc.template_slug || jobDoc.endpoint_id}`,
          collectedAt: jobDoc.finished_at || jobDoc.created_at,
          rowsCount: jobDoc.delivered_units || cleanRows.length,
          methodology: parsedData.metadata?.methodology || "",
        },
        profile: cleanProfile,
        rows: cleanRows,
        chargedCredits: jobDoc.charged_credits,
        finishedAt: jobDoc.finished_at,
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
      { success: false, error: err.message || "حدث خطأ غير متوقع." },
      { status: 500 }
    );
  }
}
