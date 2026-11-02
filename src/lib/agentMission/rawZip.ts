import { Zip, ZipDeflate } from "fflate";
import { toArabicDigits } from "../arabicDigits";
import { AGENT_BUCKET } from "./constants";

/**
 * THE RAW PAGES OF CHOSEN MISSIONS, AS ONE ZIP (docs/FOUNDATION-PLAN.md, section 5, PR 1 «Real responses in»). Admin only (the route checks it).
 * Reads, from the private bucket "agent-missions", ONLY the objects `<mission id>/raw/<name>` (the provider's own answers) and `<mission id>/rows/<name>`
 * (what each stage delivered), and nothing else: no result file, no planning or run state, no other folder. Read-only: list and download, never a write.
 * The paths are built from a mission id that matched MISSION_ID, a fixed folder name, and an object name that matched OBJECT_NAME, so no path can leave
 * those two folders. The objects hold commenters' names and texts: their content is never logged; a log line holds the mission id, the object count and
 * the bytes only. The ZIP is for the owner's own device; it is never committed (see .gitignore).
 */

export const RAW_ZIP_MAX_MISSIONS = 40;
/** The bucket's own file limit is 50 MB; the largest raw/ or rows/ object stored is 5,535,284 bytes (storage.objects metadata, 2026-11-02). */
export const RAW_ZIP_MAX_OBJECT_BYTES = 10 * 1024 * 1024;
/** The 28 missions of docs/FOUNDATION-PLAN.md PR 1 hold 509 objects, 19,603,637 bytes (storage.objects metadata, 2026-11-02); above this the admin picks fewer missions. */
export const RAW_ZIP_MAX_TOTAL_BYTES = 60 * 1024 * 1024;
export const RAW_ZIP_MAX_OBJECTS = 4000;
/** Under the route's 60-second limit: a ZIP that runs past it is cut (the stream errors, so a half file is never delivered as complete). */
export const RAW_ZIP_TIME_BUDGET_MS = 50_000;
export const RAW_ZIP_FOLDERS = ["raw", "rows"] as const;

const MISSION_ID = /^msn_[0-9a-f]{20}$/;
/** One object name inside raw/ or rows/: no slash, no backslash, no percent sign, no leading dot, no "..". */
const OBJECT_NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
const OBJECT_PATH = /^(msn_[0-9a-f]{20})\/(raw|rows)\/([^/]+)$/;
const LIST_PAGE = 1000;
const DOWNLOADS_AT_ONCE = 6;
const MB = 1024 * 1024;

export const RAW_ZIP_ERRORS_AR = {
  noIds: "اكتب رقم مهمة واحدة على الأقل.",
  badId: "رقم مهمة غير صحيح. اكتب أرقام المهام كما تظهر في قائمة المهام، مفصولة بفاصلة أو بسطر جديد.",
  tooMany: `الحد الأقصى ${toArabicDigits(RAW_ZIP_MAX_MISSIONS)} مهمة في الملف الواحد.`,
  none: "لا توجد صفحات خام ولا صفوف محفوظة لهذه المهام.",
  unreadable: "تعذّرت قراءة الملفات المحفوظة الآن. أعد المحاولة بعد قليل.",
} as const;
const tooLargeAr = (maxBytes: number): string => `حجم الملفات المحفوظة لهذه المهام أكبر من حد الملف الواحد (${toArabicDigits(Math.floor(maxBytes / MB))} ميجابايت). اختر مهام أقل.`;

export type ParsedIds = { ok: true; ids: string[] } | { ok: false; error: string };

/** The admin's list of mission ids (commas, Arabic commas, spaces or new lines between them). Every token must be a mission id; at most forty; repeats count once. */
export function parseMissionIds(input: unknown): ParsedIds {
  const tokens = String(input ?? "").split(/[\s,،]+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return { ok: false, error: RAW_ZIP_ERRORS_AR.noIds };
  if (tokens.length > RAW_ZIP_MAX_MISSIONS) return { ok: false, error: RAW_ZIP_ERRORS_AR.tooMany };
  if (!tokens.every((t) => MISSION_ID.test(t))) return { ok: false, error: RAW_ZIP_ERRORS_AR.badId };
  return { ok: true, ids: [...new Set(tokens)] };
}

/** True only for `<mission id>/raw/<name>` or `<mission id>/rows/<name>` with a plain object name. */
export function isAllowedObjectPath(path: string): boolean {
  const m = OBJECT_PATH.exec(path);
  return m !== null && OBJECT_NAME.test(m[3]) && !m[3].includes("..");
}

interface ListedObject { name: string; id?: string | null; metadata?: { size?: unknown } | null }
interface BucketApi {
  list: (prefix: string, options?: { limit?: number; offset?: number; sortBy?: { column: string; order: string } }) => Promise<{ data: ListedObject[] | null; error: unknown }>;
  download: (path: string) => Promise<{ data: Blob | null; error: unknown }>;
}
/** The part of the server's Storage client this file uses: list and download, nothing that writes. */
export interface RawZipStorage { from: (bucket: string) => BucketApi }

interface Entry { path: string; listedBytes: number }
export interface RawZipMission { id: string; objects: number; bytes: number }
export type RawZipPrepared =
  | { ok: false; status: 404 | 413 | 500; error: string }
  | { ok: true; stream: ReadableStream<Uint8Array>; missions: RawZipMission[]; objects: number; listedBytes: number };

async function listFolder(bucket: BucketApi, prefix: string): Promise<ListedObject[] | null> {
  const out: ListedObject[] = [];
  for (let offset = 0; ; offset += LIST_PAGE) {
    const { data, error } = await bucket.list(prefix, { limit: LIST_PAGE, offset, sortBy: { column: "name", order: "asc" } });
    if (error || !Array.isArray(data)) return null;
    out.push(...data);
    if (data.length < LIST_PAGE) return out;
    if (out.length > RAW_ZIP_MAX_OBJECTS) return out;
  }
}

/**
 * Lists the raw/ and rows/ objects of every mission (in the order given), refuses BEFORE any download when the listed sizes pass the caps, then returns
 * a stream of one ZIP: the objects as `<id>/raw/<name>` and `<id>/rows/<name>` (bytes unchanged), and manifest.json LAST with names and sizes only.
 * A download that fails, is larger than allowed, or runs past the time budget ERRORS the stream: a ZIP cut short has no central directory and does not open.
 */
export async function prepareRawZip(
  storage: RawZipStorage,
  ids: ReadonlyArray<string>,
  options: { now?: Date; clock?: () => number; budgetMs?: number; maxObjectBytes?: number; maxTotalBytes?: number; log?: (line: string) => void } = {},
): Promise<RawZipPrepared> {
  const maxObject = options.maxObjectBytes ?? RAW_ZIP_MAX_OBJECT_BYTES;
  const maxTotal = options.maxTotalBytes ?? RAW_ZIP_MAX_TOTAL_BYTES;
  const clock = options.clock ?? Date.now;
  const budget = options.budgetMs ?? RAW_ZIP_TIME_BUDGET_MS;
  const log = options.log ?? ((line: string) => console.info(line));
  const at = options.now ?? new Date();
  if (ids.length === 0 || ids.length > RAW_ZIP_MAX_MISSIONS || !ids.every((id) => MISSION_ID.test(id))) return { ok: false, status: 500, error: RAW_ZIP_ERRORS_AR.badId };

  let bucket: BucketApi;
  try { bucket = storage.from(AGENT_BUCKET); } catch { return { ok: false, status: 500, error: RAW_ZIP_ERRORS_AR.unreadable }; }

  const entries: Entry[] = [];
  const missions: RawZipMission[] = [];
  let listedBytes = 0;
  for (const id of ids) {
    const own: Entry[] = [];
    for (const folder of RAW_ZIP_FOLDERS) {
      let listed: ListedObject[] | null;
      try { listed = await listFolder(bucket, `${id}/${folder}`); } catch { listed = null; }
      if (listed === null) return { ok: false, status: 500, error: RAW_ZIP_ERRORS_AR.unreadable };
      const files = listed
        .filter((o) => o && typeof o.name === "string" && o.id !== null && o.id !== undefined)
        .map((o) => ({ path: `${id}/${folder}/${o.name}`, listedBytes: Math.max(0, Number(o.metadata?.size) || 0) }))
        .filter((e) => isAllowedObjectPath(e.path))
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      own.push(...files);
    }
    const bytes = own.reduce((s, e) => s + e.listedBytes, 0);
    if (own.some((e) => e.listedBytes > maxObject)) return { ok: false, status: 413, error: tooLargeAr(maxObject) };
    entries.push(...own);
    listedBytes += bytes;
    missions.push({ id, objects: own.length, bytes });
    log(`raw-zip mission=${id} objects=${own.length} bytes=${bytes}`);
    if (entries.length > RAW_ZIP_MAX_OBJECTS || listedBytes > maxTotal) return { ok: false, status: 413, error: tooLargeAr(maxTotal) };
  }
  if (entries.length === 0) return { ok: false, status: 404, error: RAW_ZIP_ERRORS_AR.none };

  const started = clock();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let failed = false;
      const fail = (reason: string) => { if (!failed) { failed = true; controller.error(new Error(reason)); } };
      try {
        const zip = new Zip((error, chunk, final) => {
          if (failed) return;
          if (error) { fail("raw_zip_failed"); return; }
          controller.enqueue(chunk);
          if (final) controller.close();
        });
        const add = (name: string, bytes: Uint8Array) => {
          const file = new ZipDeflate(name, { level: 6 });
          zip.add(file);
          file.push(bytes, true);
        };
        const written: Array<{ path: string; bytes: number }> = [];
        let total = 0;
        for (let i = 0; i < entries.length; i += DOWNLOADS_AT_ONCE) {
          if (clock() - started > budget) { fail("raw_zip_time_budget"); return; }
          const batch = entries.slice(i, i + DOWNLOADS_AT_ONCE);
          const bodies = await Promise.all(batch.map(async (e) => {
            if (!isAllowedObjectPath(e.path)) return null;
            const { data, error } = await bucket.download(e.path);
            if (error || !data) return null;
            return new Uint8Array(await data.arrayBuffer());
          }));
          for (let j = 0; j < batch.length; j++) {
            const body = bodies[j];
            if (body === null) { fail("raw_zip_unreadable"); return; }
            total += body.byteLength;
            if (body.byteLength > maxObject || total > maxTotal) { fail("raw_zip_too_large"); return; }
            add(batch[j].path, body);
            written.push({ path: batch[j].path, bytes: body.byteLength });
          }
        }
        const perMission = missions.map((m) => {
          const own = written.filter((w) => w.path.startsWith(`${m.id}/`));
          return { id: m.id, objects: own.length, bytes: own.reduce((s, w) => s + w.bytes, 0) };
        });
        const manifest = { generated_at: at.toISOString(), bucket: AGENT_BUCKET, folders: [...RAW_ZIP_FOLDERS], missions: perMission, files: written };
        add("manifest.json", new TextEncoder().encode(JSON.stringify(manifest, null, 2)));
        zip.end();
      } catch {
        fail("raw_zip_failed");
      }
    },
  });
  return { ok: true, stream, missions, objects: entries.length, listedBytes };
}

/** diger-raw-pages-YYYYMMDD-HHMM.zip (UTC). */
export function rawZipFileName(at: Date): string {
  const iso = at.toISOString();
  return `diger-raw-pages-${iso.slice(0, 10).replace(/-/g, "")}-${iso.slice(11, 13)}${iso.slice(14, 16)}.zip`;
}
