import { CUSTOMER_MESSAGE_LIMITS, type CustomerMessage } from "@/lib/customerMessage";

/**
 * CAMPAIGN STORAGE (DT-20261118-06 phase 2B, Tier A; D-0094 point 2): the admin's campaign drafts in `admin_campaigns` (migration 20261119010000_admin_campaigns.sql, admin-only RLS).
 * Server only: the routes call `authenticateAdmin` first and use the service-role client. Nothing here sends an e-mail, reads a customer, or touches money.
 * Until the migration is applied every call answers `not_ready`, and the page says so; nothing else depends on it.
 */
export const CAMPAIGN_TABLE = "admin_campaigns";
export const CAMPAIGN_LIST_CAP = 100;
const COLUMNS = "id,name,subject,badge,heading,body,cta_label,cta_path,audience,status,revision,test_sent_at,test_content_hash,created_at,updated_at";

export interface CampaignRow {
  id: string; name: string; subject: string; badge: string; heading: string; body: string; cta_label: string; cta_path: string;
  audience: "news_opt_in"; status: "draft" | "ready" | "sending" | "sent" | "cancelled"; revision: number; test_sent_at: string | null; test_content_hash: string | null; created_at: string; updated_at: string;
}
export interface CampaignDraft { name: string; subject: string; badge: string; heading: string; body: string; ctaLabel: string; ctaPath: string }

export type StoreError = { ok: false; code: "not_ready" | "not_found" | "stale" | "locked" | "failed"; messageAr: string; status: number };
const ERR: Record<StoreError["code"], { messageAr: string; status: number }> = {
  not_ready: { messageAr: "تخزين الحملات لم يُفعَّل بعد.", status: 503 },
  not_found: { messageAr: "الحملة غير موجودة.", status: 404 },
  stale: { messageAr: "تغيّرت هذه المسودة من شاشة أخرى. أعد فتحها ثم احفظ.", status: 409 },
  locked: { messageAr: "لا تُعدَّل حملة بعد خروجها من المسودة.", status: 409 },
  failed: { messageAr: "تعذّر حفظ الحملة الآن. أعد المحاولة.", status: 500 },
};
const fail = (code: StoreError["code"]): StoreError => ({ ok: false, code, ...ERR[code] });

/** The table is not there yet (the migration is not applied): Postgres 42P01, or the API's «could not find the table» (PGRST205). */
export function isMissingTable(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  return error.code === "42P01" || error.code === "PGRST205" || /does not exist|could not find the table/i.test(String(error.message ?? ""));
}
const errorOf = (error: { code?: string; message?: string } | null | undefined): StoreError => fail(isMissingTable(error) ? "not_ready" : "failed");

const clip = (v: unknown, max: number): string => String(v ?? "").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim().slice(0, max);

/** Reads a draft from the admin's request: every field cut to its limit (a draft may be incomplete; the strict check runs at the test send). The name is required. */
export function parseDraft(body: unknown): { ok: true; draft: CampaignDraft } | { ok: false; errorAr: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const name = clip(b.name, 120);
  if (!name) return { ok: false, errorAr: "اكتب اسمًا للحملة." };
  const L = CUSTOMER_MESSAGE_LIMITS;
  return { ok: true, draft: { name, subject: clip(b.subject, L.subject.max), badge: clip(b.badge, L.badge.max), heading: clip(b.heading, L.heading.max), body: clip(b.body, L.body.max), ctaLabel: clip(b.ctaLabel, L.ctaLabel.max), ctaPath: clip(b.ctaPath, L.ctaPath.max) } };
}

/** The campaign as a message (for the strict check, the preview and the test). */
export function messageOf(row: Pick<CampaignRow, "subject" | "badge" | "heading" | "body" | "cta_label" | "cta_path">): CustomerMessage {
  return { subject: row.subject, heading: row.heading, body: row.body, ...(row.badge ? { badge: row.badge } : {}), ...(row.cta_label || row.cta_path ? { ctaLabel: row.cta_label, ctaPath: row.cta_path } : {}) };
}

const columnsOf = (d: CampaignDraft) => ({ name: d.name, subject: d.subject, badge: d.badge, heading: d.heading, body: d.body, cta_label: d.ctaLabel, cta_path: d.ctaPath });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = { from: (table: string) => any };

export async function listCampaigns(db: Db): Promise<{ ok: true; rows: CampaignRow[] } | StoreError> {
  const res = await db.from(CAMPAIGN_TABLE).select(COLUMNS).order("created_at", { ascending: false }).limit(CAMPAIGN_LIST_CAP);
  if (res.error) return errorOf(res.error);
  return { ok: true, rows: (res.data ?? []) as CampaignRow[] };
}

export async function getCampaign(db: Db, id: string): Promise<{ ok: true; row: CampaignRow } | StoreError> {
  const res = await db.from(CAMPAIGN_TABLE).select(COLUMNS).eq("id", id).maybeSingle();
  if (res.error) return errorOf(res.error);
  return res.data ? { ok: true, row: res.data as CampaignRow } : fail("not_found");
}

export async function createCampaign(db: Db, input: { adminId: string; draft: CampaignDraft }): Promise<{ ok: true; row: CampaignRow } | StoreError> {
  const res = await db.from(CAMPAIGN_TABLE).insert({ ...columnsOf(input.draft), audience: "news_opt_in", status: "draft", revision: 1, created_by: input.adminId, updated_by: input.adminId }).select(COLUMNS).single();
  if (res.error || !res.data) return errorOf(res.error);
  return { ok: true, row: res.data as CampaignRow };
}

/** Saves a draft only when the screen saw the newest revision and the campaign is still a draft; the revision goes up by one. A text change clears the test (it no longer shows this text). */
export async function saveCampaign(db: Db, input: { adminId: string; id: string; revision: number; draft: CampaignDraft }): Promise<{ ok: true; row: CampaignRow } | StoreError> {
  const now = new Date().toISOString();
  const res = await db.from(CAMPAIGN_TABLE)
    .update({ ...columnsOf(input.draft), revision: input.revision + 1, updated_by: input.adminId, updated_at: now, test_sent_at: null, test_content_hash: null })
    .eq("id", input.id).eq("revision", input.revision).eq("status", "draft").select(COLUMNS);
  if (res.error) return errorOf(res.error);
  const row = Array.isArray(res.data) ? (res.data[0] as CampaignRow | undefined) : undefined;
  if (row) return { ok: true, row };
  const now2 = await getCampaign(db, input.id);
  if (!now2.ok) return now2;
  return fail(now2.row.status !== "draft" ? "locked" : "stale");
}

/** Records the test the admin received for this exact text (its hash) and revision. */
export async function markTestSent(db: Db, input: { adminId: string; id: string; revision: number; hash: string }): Promise<{ ok: true } | StoreError> {
  const res = await db.from(CAMPAIGN_TABLE).update({ test_sent_at: new Date().toISOString(), test_content_hash: input.hash, updated_by: input.adminId }).eq("id", input.id).eq("revision", input.revision).select("id");
  if (res.error) return errorOf(res.error);
  return Array.isArray(res.data) && res.data.length > 0 ? { ok: true } : fail("stale");
}
