import ExcelJS from "exceljs";
import { formatAr } from "../../arabicDigits";
import { FALLBACK_BASE } from "../../downloadName";
import { safeSheetName } from "../../modelPlanner/missionWorkbook";
import { AGENT_BUCKET, MISSION_TABLE } from "../constants";
import { missionDownloadName } from "../fileNames";
import { digestOf, versionPathOf, type FileVersion, type VersionReason } from "./versions";

/**
 * MONEY PR 7b, PHASE 2B-2 TASK 1 (docs/MONEY-PR-7A.md section 14): THE EXCEL FILE OF ONE PUBLISHED VERSION. Read-only, server only: the mission is the customer's own, the version is the create-only object `versions/vNNNN.json` of its folder
 * (a pending add-on version lives under `addons/` and is never read here), the object is checked to be exactly the version it claims to be (this mission, this number, its own digest), and the workbook is built from its cells.
 * Nothing is written, nothing is signed, nothing is priced.
 */
const REASONS: ReadonlyArray<VersionReason> = ["delivery", "edit", "review_fix"];
const MAX_COLUMNS = 16_384;
const MAX_ROWS = 1_048_575;
const NAVY = "FF1B365D";
const WHITE = "FFFFFFFF";
const ZEBRA = "FFF8FAFC";
const BORDER = { top: { style: "thin" as const, color: { argb: "FFD0D7DE" } }, left: { style: "thin" as const, color: { argb: "FFD0D7DE" } }, bottom: { style: "thin" as const, color: { argb: "FFD0D7DE" } }, right: { style: "thin" as const, color: { argb: "FFD0D7DE" } } };

/** A version number a customer may ask for: a positive whole number of at most four digits, no sign, no space, no leading zero, ASCII digits only. Anything else is not a version number. */
export function parseVersionNumber(raw: string | null | undefined): number | null {
  return typeof raw === "string" && /^[1-9][0-9]{0,3}$/.test(raw) ? Number(raw) : null;
}

const isText = (v: unknown): v is string => typeof v === "string";

/** The stored object as a FileVersion, or null when it is not exactly version `n` of mission `missionId` (shape, mission, number, parent, reason, every row as wide as its headers, and the digest of its own sheets). */
export function storedVersionOf(parsed: any, missionId: string, n: number): FileVersion | null {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  if (parsed.v !== 1 || parsed.missionId !== missionId || parsed.version !== n) return null;
  if (!(parsed.parent === null || (Number.isInteger(parsed.parent) && parsed.parent >= 1 && parsed.parent < n))) return null;
  if (!REASONS.includes(parsed.reason) || !isText(parsed.createdAt) || parsed.createdAt === "" || !isText(parsed.digest) || !/^[0-9a-f]{64}$/.test(parsed.digest)) return null;
  if (!Array.isArray(parsed.sheets) || parsed.sheets.length < 1) return null;
  for (const s of parsed.sheets) {
    if (!s || !isText(s.nameAr) || s.nameAr === "" || !Array.isArray(s.headers) || s.headers.length < 1 || s.headers.length > MAX_COLUMNS || !s.headers.every(isText)) return null;
    if (!Array.isArray(s.rows) || s.rows.length > MAX_ROWS) return null;
    for (const r of s.rows) if (!r || !isText(r.id) || r.id === "" || !(r.parentId === null || isText(r.parentId)) || !Array.isArray(r.cells) || r.cells.length !== s.headers.length || !r.cells.every(isText)) return null;
  }
  return digestOf(parsed.sheets) === parsed.digest ? (parsed as FileVersion) : null;
}

/** The workbook of a version: one sheet per stored sheet (the same Arabic name, headers and rows, every cell the stored text, never evaluated), the look of the delivered file's sheets. */
export async function generateVersionWorkbook(version: FileVersion): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Diger";
  const used = new Set<string>();
  version.sheets.forEach((s, i) => {
    const ws = wb.addWorksheet(safeSheetName(s.nameAr, used, `ورقة ${formatAr(i + 1)}`), { views: [{ state: "frozen", ySplit: 1, rightToLeft: true }] });
    ws.columns = s.headers.map((h, j) => ({ width: j === 0 ? 16 : /نص|تعليق|وصف|عنوان/.test(h) ? 48 : 24 }));
    const head = ws.addRow(s.headers);
    head.eachCell((cell) => { cell.font = { name: "Calibri", size: 10, bold: true, color: { argb: WHITE } }; cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: NAVY } }; cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true }; });
    head.height = 30;
    s.rows.forEach((r, k) => {
      const row = ws.addRow([...r.cells]);
      row.alignment = { vertical: "middle", wrapText: true };
      row.eachCell({ includeEmpty: true }, (cell) => { cell.border = BORDER; cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: k % 2 ? ZEBRA : WHITE } }; });
    });
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: s.rows.length + 1, column: s.headers.length } };
  });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** «<the mission's file name> - النسخة ٢.xlsx»: the name the customer already knows, and which version it is. */
export function versionDownloadName(mission: { files?: unknown; plan?: unknown; request_text?: unknown; delivered_units?: unknown; updated_at?: unknown }, version: number): string {
  const whole = missionDownloadName({ files: mission.files, kind: "xlsx", plan: mission.plan as any, requestText: typeof mission.request_text === "string" ? mission.request_text : null, deliveredUnits: Number(mission.delivered_units) || 0, date: mission.updated_at as any });
  const stem = whole.replace(/\.xlsx$/i, "");
  return `${stem === "result" || stem === "" ? FALLBACK_BASE : stem} - النسخة ${formatAr(version)}.xlsx`;
}

export type VersionFileResult =
  | { ok: true; bytes: Buffer; name: string }
  | { ok: false; status: 404 | 500 | 503; error: "not_found" | "damaged" | "unavailable" };
type Failure = { ok: false; status: 404 | 500 | 503; error: "not_found" | "damaged" | "unavailable" };
const no = (status: 404 | 500 | 503, error: "not_found" | "damaged" | "unavailable"): Failure => ({ ok: false, status, error });

/** A published version of the customer's own mission, checked, with the mission row and the highest published number. */
export type PublishedVersionResult = { ok: true; version: FileVersion; mission: Record<string, unknown>; latest: number } | Failure;

const PUBLISHED_NAME = /^v(\d{4,})\.json$/;

/**
 * Version `version` of the customer's own mission, read from the published create-only object `versions/vNNNN.json` and checked to be exactly that version of that mission (docs/MONEY-PR-7A.md section 14.2). Shared by the download and the review preview.
 * 404 «not_found»: the mission is not theirs or does not exist (the same answer), or no such version is published (a pending add-on version is not one).
 * 503 «unavailable»: the storage or the database could not answer (never taken for «missing»).
 * 500 «damaged»: the published object is not a well-formed version of this mission (never served, never priced).
 */
export async function readPublishedVersion(client: any, input: { missionId: string; userId: string; version: number }): Promise<PublishedVersionResult> {
  try {
    const { data: mission, error: missionError } = await client.from(MISSION_TABLE).select("id,user_id,files,plan,request_text,delivered_units,updated_at").eq("id", input.missionId).maybeSingle();
    if (missionError) return no(503, "unavailable");
    if (!mission || mission.user_id !== input.userId) return no(404, "not_found");
    const bucket = client.storage.from(AGENT_BUCKET);
    const path = versionPathOf(input.version);
    const { data: listed, error: listError } = await bucket.list(`${input.missionId}/versions`, { limit: 1000, sortBy: { column: "name", order: "asc" } });
    if (listError) return no(503, "unavailable");
    const entries = ((listed ?? []) as Array<{ name: string; id?: string | null }>).filter((o) => Boolean(o.id));
    if (!entries.some((o) => `versions/${o.name}` === path)) return no(404, "not_found");
    const latest = Math.max(input.version, ...entries.map((o) => Number(PUBLISHED_NAME.exec(o.name)?.[1] ?? 0)));
    const { data: blob, error: readError } = await bucket.download(`${input.missionId}/${path}`);
    if (readError || !blob) return no(503, "unavailable");
    let text: string;
    try { text = await blob.text(); } catch { return no(503, "unavailable"); }
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { return no(500, "damaged"); }
    const version = storedVersionOf(parsed, input.missionId, input.version);
    if (!version) return no(500, "damaged");
    return { ok: true, version, mission, latest };
  } catch {
    return no(503, "unavailable");
  }
}

/** The Excel file of version `version` of the customer's own mission (the failures are those of `readPublishedVersion`; a workbook that cannot be built is 500 «damaged»). */
export async function readVersionFile(client: any, input: { missionId: string; userId: string; version: number }): Promise<VersionFileResult> {
  const r = await readPublishedVersion(client, input);
  if (!r.ok) return r;
  try {
    return { ok: true, bytes: await generateVersionWorkbook(r.version), name: versionDownloadName(r.mission, input.version) };
  } catch {
    return no(500, "damaged");
  }
}
