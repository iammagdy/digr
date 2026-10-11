import { NextRequest, NextResponse } from "next/server";
import { Account, Client, ID, Permission, Query, Role, Storage, TablesDB } from "node-appwrite";
import { z } from "zod";
import { applyArtifactEdit, ArtifactEditOperationSchema, type ArtifactResultPayload } from "@/functions/shared/artifactEditing";
import { artifactVersionRowId } from "@/functions/shared/artifactVersions";
import { generateCsvReport, generateExcelReport, generatePdfReport } from "@/functions/shared/fileGenerators";

const endpoint = process.env.NEXT_PUBLIC_APPWRITE_ENDPOINT || "https://fra.cloud.appwrite.io/v1";
const projectId = process.env.NEXT_PUBLIC_APPWRITE_PROJECT_ID || "6ac947090008606ef482";
const apiKey = process.env.APPWRITE_API_KEY!;
const serverClient = new Client().setEndpoint(endpoint).setProject(projectId).setKey(apiKey);
const tables = new TablesDB(serverClient);
const storage = new Storage(serverClient);
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
  const authHeader = req.headers.get("authorization");
  const bearerJwt = authHeader?.startsWith("Bearer ") ? authHeader.substring(7).trim() : null;
  const sessionCookie = req.cookies.get(`a_session_${projectId}`)?.value || req.cookies.get(`a_session_${projectId}_legacy`)?.value;
  if (!bearerJwt && !sessionCookie) return { response: NextResponse.json({ success: false, error: "غير مصرح. يرجى تسجيل الدخول أولاً." }, { status: 401 }) };
  const userClient = new Client().setEndpoint(endpoint).setProject(projectId);
  if (bearerJwt) userClient.setJWT(bearerJwt);
  else if (sessionCookie) userClient.setSession(sessionCookie);
  try {
    const account = new Account(userClient);
    const user = await account.get();
    return { userId: user.$id };
  } catch {
    return { response: NextResponse.json({ success: false, error: "انتهت صلاحية الجلسة." }, { status: 401 }) };
  }
}

async function getVersions(jobId: string): Promise<ArtifactVersionRow[]> {
  const result = await tables.listRows({
    databaseId: "digr",
    tableId: "artifact_versions",
    queries: [Query.equal("jobId", jobId), Query.orderAsc("versionNum"), Query.limit(100)],
  });
  return (result.rows as unknown as ArtifactVersionRow[]).sort((a, b) => Number(a.versionNum) - Number(b.versionNum));
}

async function readJsonFile(fileId: string, jobId: string): Promise<ArtifactResultPayload> {
  let buffer: ArrayBuffer;
  try { buffer = await storage.getFileDownload("job_data", fileId); }
  catch { buffer = await storage.getFileDownload("results", fileId); }
  const parsed = JSON.parse(Buffer.from(buffer).toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("RESULT_PAYLOAD_INVALID");
  return parsed as ArtifactResultPayload;
}

async function readOriginal(jobId: string): Promise<ArtifactResultPayload> {
  return readJsonFile(`json_${jobId}`, jobId);
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
    fileIds: { xlsx: row.fileIdXlsx || null, pdf: row.fileIdPdf || null, csv: row.fileIdCsv || null },
  };
}

function filePermission(userId: string) {
  return [Permission.read(Role.user(userId)), Permission.read(Role.label("admin"))];
}

async function createOriginalVersion(job: any, jobId: string, rowCount: number) {
  const rowId = artifactVersionRowId(jobId, 1);
  try {
    await tables.createRow({
      databaseId: "digr",
      tableId: "artifact_versions",
      rowId,
      data: {
        conversationId: job.conversationId || "",
        userId: job.userId,
        jobId,
        versionNum: 1,
        parentVersionId: null,
        operationJson: JSON.stringify({ action: "original", snapshotFileId: `json_${jobId}` }),
        rowCount,
        fileIdXlsx: `xlsx_${jobId}`,
        fileIdPdf: `pdf_${jobId}`,
        fileIdCsv: `csv_${jobId}`,
        isOriginal: true,
        createdAt: new Date().toISOString(),
      },
    });
  } catch {
    try { await tables.getRow({ databaseId: "digr", tableId: "artifact_versions", rowId }); }
    catch { throw new Error("ARTIFACT_VERSION_CREATE_FAILED"); }
  }
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await authenticate(req);
    if ("response" in auth) return auth.response;
    const { id: jobId } = await params;
    const job: any = await tables.getRow({ databaseId: "digr", tableId: "jobs", rowId: jobId });
    if (job.userId !== auth.userId) return NextResponse.json({ success: false, error: "غير مصرح بعرض هذا الطلب." }, { status: 403 });
    try {
      const versions = await getVersions(jobId);
      return NextResponse.json({ success: true, historyAvailable: true, current: versions.length ? versionView(versions[versions.length - 1]) : null, versions: versions.map(versionView) });
    } catch {
      console.warn("[artifact-versions:SCHEMA_UNAVAILABLE]");
      return NextResponse.json({ success: true, historyAvailable: false, current: null, versions: [] });
    }
  } catch {
    return NextResponse.json({ success: false, error: "تعذر تحميل سجل نسخ النتيجة." }, { status: 500 });
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let uploadedFileIds: string[] = [];
  let uploadedSnapshotId: string | null = null;
  try {
    const auth = await authenticate(req);
    if ("response" in auth) return auth.response;
    if (process.env.ARTIFACT_VERSIONS_ENABLED === "false") {
      return NextResponse.json({ success: false, error: "تحرير الإصدارات غير متاح حالياً." }, { status: 503 });
    }
    const { id: jobId } = await params;
    const job: any = await tables.getRow({ databaseId: "digr", tableId: "jobs", rowId: jobId });
    if (job.userId !== auth.userId) return NextResponse.json({ success: false, error: "غير مصرح بتعديل هذا الطلب." }, { status: 403 });
    if (job.status !== "done") return NextResponse.json({ success: false, error: "لا يمكن تعديل النتيجة قبل اكتمال الطلب." }, { status: 409 });

    const parsedBody = requestSchema.safeParse(await req.json());
    if (!parsedBody.success) return NextResponse.json({ success: false, error: "صيغة التعديل غير صالحة." }, { status: 400 });
    let versions: ArtifactVersionRow[];
    try { versions = await getVersions(jobId); }
    catch {
      console.warn("[artifact-versions:SCHEMA_UNAVAILABLE]");
      return NextResponse.json({ success: false, error: "سجل نسخ النتائج غير متاح حالياً." }, { status: 503 });
    }

    let latest = versions[versions.length - 1];
    const expectedVersionId = parsedBody.data.expectedVersionId;
    if (expectedVersionId !== (latest?.$id || null)) {
      return NextResponse.json({ success: false, error: "تغيّرت النسخة الحالية؛ حدّث لوحة النتائج ثم أعد المحاولة." }, { status: 409 });
    }
    if (!latest) {
      await createOriginalVersion(job, jobId, Number(job.rowsCollected) || 0);
      versions = await getVersions(jobId);
      latest = versions[versions.length - 1];
    }
    if (!latest) return NextResponse.json({ success: false, error: "تعذر تهيئة سجل النتيجة." }, { status: 503 });
    if (latest.versionNum >= 30) return NextResponse.json({ success: false, error: "وصلت النتيجة إلى الحد الأقصى وهو 30 نسخة." }, { status: 409 });

    const versionNum = Number(latest.versionNum) + 1;
    const parentVersionId = latest.$id;
    if (parsedBody.data.undoToVersionId) {
      const target = versions.find((version) => version.$id === parsedBody.data.undoToVersionId);
      if (!target) return NextResponse.json({ success: false, error: "النسخة المطلوب الرجوع إليها غير موجودة." }, { status: 404 });
      const targetMeta = JSON.parse(target.operationJson || "{}");
      const undoRowId = artifactVersionRowId(jobId, versionNum);
      const undoFileIds = { xlsx: target.fileIdXlsx || `xlsx_${jobId}`, pdf: target.fileIdPdf || `pdf_${jobId}`, csv: target.fileIdCsv || `csv_${jobId}` };
      await tables.createRow({
        databaseId: "digr", tableId: "artifact_versions", rowId: undoRowId,
        data: {
          conversationId: job.conversationId || "", userId: auth.userId, jobId, versionNum,
          parentVersionId, operationJson: JSON.stringify({ action: "undo", undoToVersionId: target.$id, snapshotFileId: targetMeta.snapshotFileId || `json_${jobId}` }),
          rowCount: Number(target.rowCount) || 0, fileIdXlsx: undoFileIds.xlsx, fileIdPdf: undoFileIds.pdf, fileIdCsv: undoFileIds.csv,
          isOriginal: false, createdAt: new Date().toISOString(),
        },
      });
      return NextResponse.json({ success: true, version: { id: undoRowId, versionNum, parentVersionId, rowCount: Number(target.rowCount) || 0, isOriginal: false, createdAt: new Date().toISOString(), fileIds: undoFileIds }, undoneToVersionId: target.$id });
    }

    const operation = parsedBody.data.operation!;
    let currentPayload: ArtifactResultPayload;
    try {
      const latestMeta = JSON.parse(latest.operationJson || "{}");
      currentPayload = latestMeta.snapshotFileId ? await readJsonFile(latestMeta.snapshotFileId, jobId) : await readOriginal(jobId);
    } catch {
      return NextResponse.json({ success: false, error: "بيانات النتيجة الأصلية غير متاحة للتحرير." }, { status: 409 });
    }
    let edited = applyArtifactEdit(normalizeForEditing(currentPayload), operation);
    edited.metadata = {
      ...(edited.metadata || {}),
      resultEdited: true,
      artifactVersion: versionNum,
      updatedAt: new Date().toISOString(),
    };

    const isFormatChange = operation.action === "convert_formats";
    const formats = isFormatChange ? operation.formats : ["xlsx", "pdf", "csv"];
    const fileIds = {
      xlsx: latest.fileIdXlsx || `xlsx_${jobId}`,
      pdf: latest.fileIdPdf || `pdf_${jobId}`,
      csv: latest.fileIdCsv || `csv_${jobId}`,
    };
    const permissions = filePermission(auth.userId);
    const generated: Array<{ ext: "xlsx" | "pdf" | "csv"; buffer: Buffer; name: string; type: string }> = [];
    if (formats.includes("xlsx")) generated.push({ ext: "xlsx", buffer: await generateExcelReport(edited), name: `digr_${job.templateSlug}_${jobId}_v${versionNum}.xlsx`, type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    if (formats.includes("pdf")) generated.push({ ext: "pdf", buffer: await generatePdfReport(edited), name: `digr_${job.templateSlug}_${jobId}_v${versionNum}.pdf`, type: "application/pdf" });
    if (formats.includes("csv")) generated.push({ ext: "csv", buffer: generateCsvReport(edited), name: `digr_${job.templateSlug}_${jobId}_v${versionNum}.csv`, type: "text/csv; charset=utf-8" });

    for (const output of generated) {
      const fileId = ID.unique();
      await storage.createFile("results", fileId, new File([new Uint8Array(output.buffer)], output.name, { type: output.type }), permissions);
      uploadedFileIds.push(fileId);
      fileIds[output.ext] = fileId;
    }

    const snapshotId = `snapshot_${ID.unique()}`;
    const snapshotBuffer = Buffer.from(JSON.stringify(edited));
    if (snapshotBuffer.byteLength > 25 * 1024 * 1024) throw new Error("ARTIFACT_SNAPSHOT_TOO_LARGE");
    await storage.createFile("job_data", snapshotId, new File([snapshotBuffer], `snapshot_${jobId}_v${versionNum}.json`, { type: "application/json" }), []);
    uploadedSnapshotId = snapshotId;

    const rowId = artifactVersionRowId(jobId, versionNum);
    const createdAt = new Date().toISOString();
    await tables.createRow({
      databaseId: "digr", tableId: "artifact_versions", rowId,
      data: {
        conversationId: job.conversationId || "", userId: auth.userId, jobId, versionNum,
        parentVersionId,
        operationJson: JSON.stringify({ action: operation.action, operation, snapshotFileId: snapshotId }),
        rowCount: Array.isArray(edited.rows) ? edited.rows.length : 0,
        fileIdXlsx: fileIds.xlsx, fileIdPdf: fileIds.pdf, fileIdCsv: fileIds.csv,
        isOriginal: false, createdAt,
      },
    });
    return NextResponse.json({ success: true, version: { id: rowId, versionNum, parentVersionId, rowCount: Array.isArray(edited.rows) ? edited.rows.length : 0, isOriginal: false, createdAt, fileIds } });
  } catch (error: any) {
    for (const fileId of uploadedFileIds) { try { await storage.deleteFile("results", fileId); } catch {} }
    if (uploadedSnapshotId) { try { await storage.deleteFile("job_data", uploadedSnapshotId); } catch {} }
    if (error?.message === "ARTIFACT_SNAPSHOT_TOO_LARGE") {
      return NextResponse.json({ success: false, error: "حجم النسخة يتجاوز الحد الآمن للتحرير." }, { status: 413 });
    }
    console.warn("[artifact-versions:EDIT_FAILED]");
    return NextResponse.json({ success: false, error: "تعذر إنشاء نسخة من التعديل." }, { status: 503 });
  }
}
