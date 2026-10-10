import { NextRequest, NextResponse } from "next/server";
import { Client as ServerClient, TablesDB, Storage, Client as UserClient, Account } from "node-appwrite";

const endpoint = process.env.NEXT_PUBLIC_APPWRITE_ENDPOINT || "https://cloud.appwrite.io/v1";
const projectId = process.env.NEXT_PUBLIC_APPWRITE_PROJECT_ID || "6ac947090008606ef482";
const apiKey = process.env.APPWRITE_API_KEY!;

const serverClient = new ServerClient()
  .setEndpoint(endpoint)
  .setProject(projectId)
  .setKey(apiKey);

const tables = new TablesDB(serverClient);
const storage = new Storage(serverClient);

export async function GET(
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

    // 2. Fetch Job Document
    const jobDoc: any = await tables.getRow({
      databaseId: "digr",
      tableId: "jobs",
      rowId: jobId,
    });

    if (jobDoc.userId !== verifiedUserId) {
      return NextResponse.json({ success: false, error: "غير مصرح بعرض هذا الطلب." }, { status: 403 });
    }

    // 3. Read JSON result from server-only job_data bucket (with fallback to results for old jobs)
    try {
      let jsonBuf: ArrayBuffer;
      try {
        jsonBuf = await storage.getFileDownload("job_data", `json_${jobId}`);
      } catch {
        jsonBuf = await storage.getFileDownload("results", `json_${jobId}`);
      }

      const jsonText = Buffer.from(jsonBuf).toString("utf-8");
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
        templateSlug: jobDoc.templateSlug,
        metadata: {
          platform: "Digr Data Platform",
          title: parsedData.metadata?.title || `بيانات ${jobDoc.templateSlug}`,
          collectedAt: jobDoc.finishedAt || jobDoc.createdAt,
          rowsCount: jobDoc.rowsCollected || cleanRows.length,
          methodology: parsedData.metadata?.methodology || "",
        },
        profile: cleanProfile,
        rows: cleanRows,
        chargedCredits: jobDoc.chargedCredits,
        finishedAt: jobDoc.finishedAt,
      });
    } catch {
      // If JSON file doesn't exist yet (e.g. still running, failed, or older job)
      return NextResponse.json({
        success: true,
        jobId,
        status: jobDoc.status,
        templateSlug: jobDoc.templateSlug,
        errorAr: jobDoc.errorAr || null,
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
