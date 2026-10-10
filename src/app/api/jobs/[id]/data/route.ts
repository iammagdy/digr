import { NextRequest, NextResponse } from "next/server";
import { Client as ServerClient, TablesDB, Storage, Client as UserClient, Account, Query } from "node-appwrite";
import { buildFallbackReview, buildNormalizedRequestSpec, computeRunFacts, parseNormalizedRequestSpec, parseResultReview } from "@/functions/shared/resultReview";

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

    let goodwillRefund: { points: number; reasonAr: string } | null = null;
    try {
      const refundRow: any = await tables.getRow({ databaseId: "digr", tableId: "credit_ledger", rowId: `gwl_${jobId}` });
      if (refundRow.userId === verifiedUserId && refundRow.jobId === jobId && refundRow.type === "adjust" && Number(refundRow.delta) > 0) {
        const note = typeof refundRow.note === "string" ? refundRow.note : "";
        goodwillRefund = {
          points: Math.floor(Number(refundRow.delta)),
          reasonAr: note.replace(/^رد حسن نية:\s*/, "").slice(0, 480) || "مؤشر نتيجة جوهري",
        };
      }
    } catch { /* no goodwill adjustment is a normal state */ }

    // 3. Read JSON result from server-only job_data bucket (with fallback to results for old jobs)
    try {
      let latestArtifactVersion: any = null;
      try {
        const versions = await tables.listRows({ databaseId: "digr", tableId: "artifact_versions", queries: [Query.equal("jobId", jobId), Query.orderAsc("versionNum"), Query.limit(100)] });
        latestArtifactVersion = (versions.rows as any[]).sort((a, b) => Number(a.versionNum) - Number(b.versionNum));
      } catch {
        console.warn("[artifact-versions:SCHEMA_UNAVAILABLE]");
      }
      const versionRows = Array.isArray(latestArtifactVersion) ? latestArtifactVersion : [];
      latestArtifactVersion = versionRows.length ? versionRows[versionRows.length - 1] : null;
      let snapshotId: string | null = null;
      try { snapshotId = JSON.parse(latestArtifactVersion?.operationJson || "{}").snapshotFileId || null; } catch {}
      let jsonBuf: ArrayBuffer;
      try {
        jsonBuf = snapshotId
          ? await storage.getFileDownload("job_data", snapshotId)
          : await storage.getFileDownload("job_data", `json_${jobId}`);
      } catch {
        try { jsonBuf = await storage.getFileDownload("job_data", `json_${jobId}`); }
        catch { jsonBuf = await storage.getFileDownload("results", `json_${jobId}`); }
      }

      const jsonText = Buffer.from(jsonBuf).toString("utf-8");
      const parsedData = JSON.parse(jsonText);
      const rawRows = Array.isArray(parsedData.rows) ? parsedData.rows : (parsedData.profile ? [parsedData.profile] : []);
      const parsedSpec = parseNormalizedRequestSpec(parsedData.requestSpec);
      const params = (() => {
        try { return typeof jobDoc.params === "string" ? JSON.parse(jobDoc.params) : (jobDoc.params || {}); }
        catch { return {}; }
      })();
      const requestSpec = parsedSpec || buildNormalizedRequestSpec({
        items: [{ capabilitySlug: jobDoc.templateSlug || "unknown", params, targetVolumeMin: 1, targetVolumeMax: Math.max(1, Number(jobDoc.rowsCollected) || 1) }],
        outputFormats: ["xlsx", "pdf", "csv"],
      });
      const runFacts = computeRunFacts(requestSpec, rawRows);
      const review = parsedData.metadata?.resultEdited
        ? buildFallbackReview(runFacts, requestSpec)
        : parseResultReview(parsedData.review) || buildFallbackReview(runFacts, requestSpec);

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
      const cleanRows = Array.isArray(parsedData.rows) ? parsedData.rows.map((r: any, idx: number) => {
        if (parsedData.metadata?.resultEdited && r && typeof r === "object" && !Array.isArray(r)) {
          const safeEntries = Object.entries(r).filter(([key, value]) => {
            const safeKey = key.length <= 80 && /^[\p{L}\p{N}_. -]+$/u.test(key) && !["__proto__", "constructor", "prototype"].includes(key);
            const safeName = !/(provider|token|secret|endpoint|api[_-]?key|raw[_-]?response|internal)/i.test(key);
            const safeValue = value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)) || (typeof value === "string" && value.length <= 2000);
            return safeKey && safeName && safeValue;
          });
          return { ...Object.fromEntries(safeEntries), id: `rec_${idx + 1}` };
        }
        return {
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
        };
      }) : [];

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
        goodwillRefund,
        review,
        artifactVersion: latestArtifactVersion ? {
          id: latestArtifactVersion.$id,
          versionNum: Number(latestArtifactVersion.versionNum),
          rowCount: Number(latestArtifactVersion.rowCount) || cleanRows.length,
        } : null,
        fileIds: latestArtifactVersion ? {
          xlsx: latestArtifactVersion.fileIdXlsx || `xlsx_${jobId}`,
          pdf: latestArtifactVersion.fileIdPdf || `pdf_${jobId}`,
          csv: latestArtifactVersion.fileIdCsv || `csv_${jobId}`,
        } : { xlsx: `xlsx_${jobId}`, pdf: `pdf_${jobId}`, csv: `csv_${jobId}` },
        runFacts: {
          requested: runFacts.requested,
          delivered: runFacts.delivered,
          severity: runFacts.severity,
          findings: runFacts.findings,
          rowsPerSource: runFacts.rowsPerSource,
          rowsPerWindow: runFacts.rowsPerWindow,
          dayByDayCoverage: runFacts.dayByDayCoverage,
          duplicateCount: runFacts.duplicateCount,
          replyShare: runFacts.replyShare,
          conversationsWithMultipleItems: runFacts.conversationsWithMultipleItems,
          languageShares: runFacts.languageShares,
          emptyWindows: runFacts.emptyWindows,
          failedWindows: runFacts.failedWindows,
        },
      });
    } catch {
      // If JSON file doesn't exist yet (e.g. still running, failed, or older job)
      const registeredRows = Math.max(0, Number(jobDoc.rowsCollected) || 0);
      const unavailableReview = parseResultReview({
        comparisonAr: `تم تسجيل ${registeredRows.toLocaleString("ar-EG")} سجل، لكن تفاصيل النتيجة غير متاحة الآن؛ لذلك لا أقدر أقارنها بمحتوى طلبك.`,
        suggestions: [],
      });
      return NextResponse.json({
        success: true,
        jobId,
        status: jobDoc.status,
        templateSlug: jobDoc.templateSlug,
        errorAr: jobDoc.errorAr || null,
        profile: null,
        rows: [],
        review: unavailableReview,
        goodwillRefund,
        runFacts: { severity: "warning", delivered: registeredRows, requested: null, findings: [] },
        dataAvailable: false,
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
