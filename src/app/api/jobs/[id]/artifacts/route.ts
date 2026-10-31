import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createServerSideClient, createAdminClient } from "@/lib/supabase/server";
import { applyArtifactEdit, ArtifactEditOperationSchema, type ArtifactResultPayload } from "@/functions/shared/artifactEditing";
import { artifactVersionRowId } from "@/functions/shared/artifactVersions";
import { producedFormats, resultsReleasable } from "@/lib/producedFormats";
import { generateCsvReport, generateExcelReport, generatePdfReport } from "@/functions/shared/fileGenerators";
import { buildFacebookReportExcelFrom, buildFacebookReportPdfFrom, facebookReportOf } from "@/functions/shared/facebookReportFiles";
import { customerFileIds } from "@/lib/customerFiles";

export const dynamic = "force-dynamic";

const requestSchema = z.object({
  expectedVersionId: z.string().max(36).nullable(),
  undoToVersionId: z.string().max(36).optional(),
  operation: ArtifactEditOperationSchema.optional(),
}).strict().refine((value) => Boolean(value.undoToVersionId) !== Boolean(value.operation));

type ArtifactVersionRow = {
  $id: string;
  userId: string;
  jobId: string;
  versionNum: number;
  parentVersionId?: string | null;
  operationJson: string;
  rowCount: number;
  fileIdXlsx?: string | null;
  fileIdPdf?: string | null;
  fileIdCsv?: string | null;
  isOriginal: boolean;
  createdAt: string;
};

async function authenticate(req: NextRequest): Promise<{ userId: string } | { response: NextResponse }> {
  try {
    const supabase = await createServerSideClient();
    const authHeader = req.headers.get("authorization");
    let user = null;

    if (authHeader?.startsWith("Bearer ")) {
      const { data } = await supabase.auth.getUser(authHeader.substring(7).trim());
      user = data?.user;
    } else {
      const { data } = await supabase.auth.getUser();
      user = data?.user;
    }

    if (!user) {
      return { response: NextResponse.json({ success: false, error: "غير مصرح. يرجى تسجيل الدخول أولاً." }, { status: 401 }) };
    }
    return { userId: user.id };
  } catch {
    return { response: NextResponse.json({ success: false, error: "انتهت صلاحية الجلسة." }, { status: 401 }) };
  }
}

async function getVersions(jobId: string, adminClient: any): Promise<ArtifactVersionRow[]> {
  const { data, error } = await adminClient
    .from("artifact_versions")
    .select("*")
    .eq("job_id", jobId)
    .order("version_number", { ascending: true });

  if (error) throw error;
  return (data || []).map((r: any) => ({
    $id: r.id,
    userId: r.user_id,
    jobId: r.job_id,
    versionNum: Number(r.version_number),
    parentVersionId: null,
    operationJson: "{}",
    rowCount: 0,
    fileIdXlsx: r.file_id_xlsx || null,
    fileIdPdf: r.file_id_pdf || null,
    fileIdCsv: r.file_id_csv || null,
    isOriginal: Number(r.version_number) === 1,
    createdAt: r.created_at,
  }));
}

async function readJsonFile(fileId: string, jobId: string, adminClient: any, userId?: string): Promise<ArtifactResultPayload> {
  const candidatePaths = [
    fileId,
    `${jobId}/data.json`,
    `results/${jobId}/data.json`,
    `partials/${jobId}/data.json`,
  ];
  if (userId) {
    candidatePaths.unshift(`${userId}/${jobId}/data.json`);
  }

  const buckets = ["results", "partials"];
  for (const bucket of buckets) {
    for (const path of candidatePaths) {
      if (!path) continue;
      try {
        const { data: blob, error } = await adminClient.storage
          .from(bucket)
          .download(path);

        if (!error && blob) {
          const text = typeof blob.text === "function" ? await blob.text() : String(blob);
          const parsed = JSON.parse(text);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            return parsed as ArtifactResultPayload;
          }
        }
      } catch {
        // try next path/bucket
      }
    }
  }

  throw new Error("RESULT_PAYLOAD_INVALID");
}

function normalizeForEditing(payload: ArtifactResultPayload): ArtifactResultPayload {
  if (Array.isArray(payload.rows)) return { ...payload, rows: payload.rows };
  if (!payload.profile || typeof payload.profile !== "object") return { ...payload, rows: [] };
  const profile = payload.profile as Record<string, any>;
  const row = {
    id: profile.id || profile.uid || "",
    username: profile.username || (profile.uniqueId ? `@${profile.uniqueId}` : ""),
    displayName: profile.displayName || profile.nickname || "",
    bio: profile.bio || profile.signature || "",
    verified: Boolean(profile.verified),
    followers: Number(profile.followers ?? profile.followerCount ?? 0),
    following: Number(profile.following ?? profile.followingCount ?? 0),
    likes: Number(profile.likes ?? profile.heartCount ?? 0),
    videosCount: Number(profile.videosCount ?? profile.videoCount ?? 0),
    bioLink: profile.bioLink || "",
    profileUrl: profile.profileUrl || "",
    collectedDate: profile.collectedDate || "",
  };
  return { ...payload, profile: null, rows: [row] };
}

function versionView(row: ArtifactVersionRow) {
  return {
    id: row.$id,
    versionNum: Number(row.versionNum),
    parentVersionId: row.parentVersionId || null,
    rowCount: Number(row.rowCount) || 0,
    isOriginal: Boolean(row.isOriginal),
    createdAt: row.createdAt,
    // a customer is never told of a CSV: its id is not given, and a request that has only a CSV says its Excel is ready
    fileIds: customerFileIds({ xlsx: row.fileIdXlsx, pdf: row.fileIdPdf, csv: row.fileIdCsv }),
  };
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await authenticate(req);
    if ("response" in auth) return auth.response;
    const { id: jobId } = await params;
    const adminClient = createAdminClient();

    const { data: job, error: jobErr } = await adminClient
      .from("jobs")
      .select("*")
      .eq("id", jobId)
      .single();

    if (jobErr || !job) {
      return NextResponse.json({ success: false, error: "الطلب غير موجود." }, { status: 404 });
    }

    if (job.user_id !== auth.userId) {
      return NextResponse.json({ success: false, error: "غير مصرح بعرض هذا الطلب." }, { status: 403 });
    }

    // A request that did not settle and charge lists no result versions (their files were saved before settlement).
    if (!resultsReleasable(job)) {
      return NextResponse.json({ success: true, historyAvailable: true, current: null, versions: [] });
    }

    try {
      const versions = await getVersions(jobId, adminClient);
      return NextResponse.json({
        success: true,
        historyAvailable: true,
        current: versions.length ? versionView(versions[versions.length - 1]) : null,
        versions: versions.map(versionView),
      });
    } catch {
      console.warn("[artifact-versions:SCHEMA_UNAVAILABLE]");
      return NextResponse.json({ success: true, historyAvailable: false, current: null, versions: [] });
    }
  } catch {
    return NextResponse.json({ success: false, error: "تعذر تحميل سجل نسخ النتيجة." }, { status: 500 });
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await authenticate(req);
    if ("response" in auth) return auth.response;

    const { id: jobId } = await params;
    const adminClient = createAdminClient();

    const { data: job, error: jobErr } = await adminClient
      .from("jobs")
      .select("*")
      .eq("id", jobId)
      .single();

    if (jobErr || !job) {
      return NextResponse.json({ success: false, error: "الطلب غير موجود." }, { status: 404 });
    }

    if (job.user_id !== auth.userId) {
      return NextResponse.json({ success: false, error: "غير مصرح بتعديل هذا الطلب." }, { status: 403 });
    }

    if (job.status !== "completed" && job.status !== "done") {
      return NextResponse.json({ success: false, error: "لا يمكن تعديل النتيجة قبل اكتمال الطلب." }, { status: 409 });
    }

    const parsedBody = requestSchema.safeParse(await req.json());
    if (!parsedBody.success) {
      return NextResponse.json({ success: false, error: "صيغة التعديل غير صالحة." }, { status: 400 });
    }

    let versions: ArtifactVersionRow[];
    try {
      versions = await getVersions(jobId, adminClient);
    } catch {
      return NextResponse.json({ success: false, error: "سجل نسخ النتائج غير متاح حالياً." }, { status: 503 });
    }

    let latest = versions[versions.length - 1];
    const expectedVersionId = parsedBody.data.expectedVersionId;
    if (expectedVersionId !== (latest?.$id || null)) {
      return NextResponse.json({ success: false, error: "تغيّرت النسخة الحالية؛ حدّث لوحة النتائج ثم أعد المحاولة." }, { status: 409 });
    }

    const versionNum = latest ? Number(latest.versionNum) + 1 : 1;
    const rowId = artifactVersionRowId(jobId, versionNum);
    const operation = parsedBody.data.operation;

    // Financial Guard: Modifications require verified financial approval (10 points initial pricing).
    // Invariant: No free services. Modifications without authorized ledger charge are blocked.
    const revChgId = `chg_rev_${jobId}_v${versionNum}`;
    const { data: existingRevCharge } = await adminClient
      .from("credit_ledger")
      .select("id")
      .eq("id", revChgId)
      .maybeSingle();

    if (!existingRevCharge) {
      return NextResponse.json(
        {
          success: false,
          blocked: true,
          error: "هذا التعديل غير متاح الآن. أما تغيير شكل الملف فمجاني: شيت لكل عمود، أو ترتيب، أو تصفية، أو اختيار الأعمدة من المحادثة.",
          reason: "revision_charging_pending_owner_approval",
        },
        { status: 409 }
      );
    }

    let currentPayload: ArtifactResultPayload;
    try {
      currentPayload = await readJsonFile(`${jobId}/data.json`, jobId, adminClient, job.user_id);
    } catch {
      return NextResponse.json({ success: false, error: "بيانات النتيجة الأصلية غير متاحة للتحرير." }, { status: 409 });
    }

    let edited = operation ? applyArtifactEdit(normalizeForEditing(currentPayload), operation) : currentPayload;
    edited.metadata = {
      ...(edited.metadata || {}),
      resultEdited: true,
      artifactVersion: versionNum,
      updatedAt: new Date().toISOString(),
    };

    const isFormatChange = operation?.action === "convert_formats";
    // A plain edit regenerates the formats this job already has, not all three.
    const formats: string[] = isFormatChange && operation
      ? operation.formats
      : producedFormats(latest ? { xlsx: latest.fileIdXlsx, pdf: latest.fileIdPdf, csv: latest.fileIdCsv } : null);

    // Only a format generated for this version is recorded; the others stay empty and are made on request.
    const fileIds: Record<string, string | null> = {
      xlsx: formats.includes("xlsx") ? `${jobId}/v${versionNum}.xlsx` : null,
      pdf: formats.includes("pdf") ? `${jobId}/v${versionNum}.pdf` : null,
      csv: formats.includes("csv") ? `${jobId}/v${versionNum}.csv` : null,
    };

    if (formats.includes("xlsx")) {
      const buf = facebookReportOf(edited) ? await buildFacebookReportExcelFrom(edited) : await generateExcelReport(edited);
      await adminClient.storage.from("results").upload(fileIds.xlsx as string, buf, { upsert: true, contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    }
    if (formats.includes("pdf")) {
      const buf = facebookReportOf(edited) ? await buildFacebookReportPdfFrom(edited) : await generatePdfReport(edited);
      await adminClient.storage.from("results").upload(fileIds.pdf as string, buf, { upsert: true, contentType: "application/pdf" });
    }
    if (formats.includes("csv")) {
      const buf = Buffer.from(generateCsvReport(edited));
      await adminClient.storage.from("results").upload(fileIds.csv as string, buf, { upsert: true, contentType: "text/csv; charset=utf-8" });
    }

    const nowIso = new Date().toISOString();
    await adminClient.from("artifact_versions").insert({
      id: rowId,
      job_id: jobId,
      user_id: auth.userId,
      version_number: versionNum,
      file_id_xlsx: fileIds.xlsx,
      file_id_pdf: fileIds.pdf,
      file_id_csv: fileIds.csv,
      created_at: nowIso,
    });

    return NextResponse.json({
      success: true,
      version: {
        id: rowId,
        versionNum,
        parentVersionId: latest?.$id || null,
        rowCount: Array.isArray(edited.rows) ? edited.rows.length : 0,
        isOriginal: false,
        createdAt: nowIso,
        fileIds: customerFileIds(fileIds),
      },
    });
  } catch (error: any) {
    console.error("Artifact edit error:", error);
    return NextResponse.json({ success: false, error: "تعذر إنشاء نسخة من التعديل." }, { status: 503 });
  }
}
