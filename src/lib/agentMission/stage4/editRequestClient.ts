import { EDIT_ERRORS_AR, EDIT_REFUSALS_AR, type EditChangeView, type EditQuoteView, type EditRequestView, type EditSchemaView } from "./editRequestLabels";
import type { EditInput } from "./editRequestForm";

/**
 * STAGE B: THE BROWSER'S SIDE OF THE EDIT REQUEST (client-safe: no server module). It sends the VERSION and the EDIT the customer typed (or the REQUEST ID to cancel) and nothing else, and hands back what the server answered ONLY if it is well-formed: a price is
 * never computed, sent, added or changed here. `fetch` and the bearer header are injected, so every path is tested without a browser. A failure is a controlled Arabic sentence.
 */
export const editRequestUrl = (missionId: string, query?: string): string => `/api/missions/${encodeURIComponent(missionId)}/edit-request${query ? `?${query}` : ""}`;

type Headers = () => Promise<Record<string, string>>;
const isVersionNumber = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 9999;
const isCount = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;
const isPositive = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 1;
const isText = (v: unknown): v is string => typeof v === "string" && v !== "";
const isRequestId = (v: unknown): v is string => typeof v === "string" && /^msn_[a-z0-9]{8,40}$/.test(v);
/** A sentence the server wrote for a refusal: Arabic letters and punctuation only, never a Latin word. */
const isArabicSentence = (v: unknown): v is string => typeof v === "string" && v.length >= 3 && v.length <= 240 && /[؀-ۿ]/.test(v) && !/[A-Za-z]/.test(v);

function changeOf(raw: any): EditChangeView | null {
  if (!raw || typeof raw !== "object") return null;
  if (raw.kind === "rename_column" && isText(raw.sheet) && isText(raw.from) && isText(raw.to)) return { kind: "rename_column", sheet: raw.sheet, from: raw.from, to: raw.to };
  if (raw.kind === "set_cells" && isText(raw.sheet) && isPositive(raw.cells) && Array.isArray(raw.columns) && raw.columns.length >= 1 && raw.columns.every(isText)) return { kind: "set_cells", sheet: raw.sheet, cells: raw.cells, columns: [...raw.columns] };
  if (raw.kind === "add_rows" && isText(raw.sheet) && isPositive(raw.rows)) return { kind: "add_rows", sheet: raw.sheet, rows: raw.rows };
  return null;
}
function priced(raw: any): { version: number; newVersion: number; change: EditChangeView; units: number; estimatePoints: number; holdPoints: number } | null {
  const change = changeOf(raw?.change);
  if (!raw || !change || !isVersionNumber(raw.version) || raw.newVersion !== raw.version + 1 || !isPositive(raw.units) || !isCount(raw.estimatePoints) || !isCount(raw.holdPoints) || raw.holdPoints < raw.estimatePoints) return null;
  return { version: raw.version, newVersion: raw.newVersion, change, units: raw.units, estimatePoints: raw.estimatePoints, holdPoints: raw.holdPoints };
}
function requestOf(raw: any): EditRequestView | null {
  const p = priced(raw);
  return p && isRequestId(raw.id) && raw.status === "plan_ready" ? { id: raw.id, ...p, status: "plan_ready" } : null;
}
function quoteOf(raw: any): EditQuoteView | null {
  if (!raw || typeof raw !== "object" || !isVersionNumber(raw.version)) return null;
  switch (raw.state) {
    case "offer": { const p = priced(raw); return p ? { state: "offer", ...p } : null; }
    case "unsupported": return (raw.why === "lookup_needed" || raw.why === "duplicates") && (raw.cells === undefined || isPositive(raw.cells)) ? { state: "unsupported", version: raw.version, why: raw.why, ...(raw.cells !== undefined ? { cells: raw.cells } : {}) } : null;
    case "rejected": return isArabicSentence(raw.messageAr) ? { state: "rejected", version: raw.version, messageAr: raw.messageAr } : null;
    case "blocked": case "not_latest": case "already_edited": case "too_large": return { state: raw.state, version: raw.version };
    default: return null;
  }
}
function schemaOf(raw: any): EditSchemaView | null {
  if (!raw || !isVersionNumber(raw.version) || !Array.isArray(raw.sheets)) return null;
  const sheets: EditSchemaView["sheets"] = [];
  for (const s of raw.sheets) {
    if (!s || !isText(s.name) || !Array.isArray(s.columns) || !s.columns.every(isText) || !isCount(s.items)) return null;
    sheets.push({ name: s.name, columns: [...s.columns], items: s.items });
  }
  return { version: raw.version, sheets };
}

const failure = (status: number): string => (status === 404 ? EDIT_ERRORS_AR.not_found : status === 401 ? EDIT_ERRORS_AR.unauthorized : status === 500 ? EDIT_ERRORS_AR.damaged : EDIT_ERRORS_AR.unavailable);
const post = async (input: { missionId: string; fetchFn: typeof fetch; headers: Headers; body: unknown }): Promise<Response> =>
  input.fetchFn(editRequestUrl(input.missionId), { method: "POST", cache: "no-store", headers: { "Content-Type": "application/json", ...(await input.headers()) }, body: JSON.stringify(input.body) });

export type EditSchemaResult = { state: "ok"; schema: EditSchemaView } | { state: "off" } | { state: "error"; message: string };

/** The latest version's sheets and columns. 404 and 401 mean the feature is off or nothing is theirs: the page draws nothing. */
export async function fetchEditSchema(input: { missionId: string; fetchFn: typeof fetch; headers: Headers }): Promise<EditSchemaResult> {
  try {
    const res = await input.fetchFn(editRequestUrl(input.missionId, "schema=1"), { cache: "no-store", headers: await input.headers() });
    if (res.status === 404 || res.status === 401) return { state: "off" };
    if (!res.ok) return { state: "error", message: EDIT_ERRORS_AR.unavailable };
    const body = await res.json().catch(() => null);
    const schema = body && body.success === true ? schemaOf(body.schema) : null;
    return schema ? { state: "ok", schema } : { state: "error", message: EDIT_ERRORS_AR.unavailable };
  } catch {
    return { state: "error", message: EDIT_ERRORS_AR.network };
  }
}

/** The waiting request of this file, or null (none, the feature off, signed out, an outage, a malformed answer). */
export async function fetchEditRequest(input: { missionId: string; fetchFn: typeof fetch; headers: Headers }): Promise<EditRequestView | null> {
  try {
    const res = await input.fetchFn(editRequestUrl(input.missionId), { cache: "no-store", headers: await input.headers() });
    if (!res.ok) return null;
    const body = await res.json();
    return body && body.success === true ? requestOf(body.request) : null;
  } catch {
    return null;
  }
}

export type QuoteResult = { ok: true; quote: EditQuoteView } | { ok: false; message: string };

export async function quoteEdit(input: { missionId: string; version: number; edit: EditInput; fetchFn: typeof fetch; headers: Headers }): Promise<QuoteResult> {
  if (!isVersionNumber(input.version)) return { ok: false, message: EDIT_ERRORS_AR.not_found };
  try {
    const res = await post({ ...input, body: { action: "quote", version: input.version, edit: input.edit } });
    if (!res.ok) return { ok: false, message: failure(res.status) };
    const body = await res.json().catch(() => null);
    const quote = body && body.success === true ? quoteOf(body.quote) : null;
    return quote ? { ok: true, quote } : { ok: false, message: EDIT_ERRORS_AR.unavailable };
  } catch {
    return { ok: false, message: EDIT_ERRORS_AR.network };
  }
}

export type PrepareResult = { ok: true; created: boolean; request: EditRequestView } | { ok: false; message: string };
const REFUSALS = ["open_addon", "not_latest_version", "already_edited", "too_large", "unsupported"] as const;

export async function prepareEditRequest(input: { missionId: string; version: number; edit: EditInput; fetchFn: typeof fetch; headers: Headers }): Promise<PrepareResult> {
  if (!isVersionNumber(input.version)) return { ok: false, message: EDIT_ERRORS_AR.not_found };
  try {
    const res = await post({ ...input, body: { action: "create", version: input.version, edit: input.edit } });
    const body = await res.json().catch(() => null);
    if (res.ok) {
      const request = body && body.success === true ? requestOf(body.request) : null;
      return request ? { ok: true, created: body.created === true, request } : { ok: false, message: EDIT_ERRORS_AR.unavailable };
    }
    if (res.status === 409) {
      if (body?.error === "rejected") return { ok: false, message: isArabicSentence(body.messageAr) ? body.messageAr : EDIT_ERRORS_AR.unavailable };
      const code = REFUSALS.find((c) => c === body?.error);
      return { ok: false, message: code ? EDIT_REFUSALS_AR[code] : EDIT_ERRORS_AR.unavailable };
    }
    return { ok: false, message: failure(res.status) };
  } catch {
    return { ok: false, message: EDIT_ERRORS_AR.network };
  }
}

export type CancelResult = { ok: true } | { ok: false; message: string };

export async function cancelEditRequest(input: { missionId: string; requestId: string; fetchFn: typeof fetch; headers: Headers }): Promise<CancelResult> {
  if (!isRequestId(input.requestId)) return { ok: false, message: EDIT_ERRORS_AR.not_found };
  try {
    const res = await post({ ...input, body: { action: "cancel", requestId: input.requestId } });
    if (res.ok) return { ok: true };
    return { ok: false, message: res.status === 409 ? EDIT_ERRORS_AR.changed : failure(res.status) };
  } catch {
    return { ok: false, message: EDIT_ERRORS_AR.network };
  }
}
