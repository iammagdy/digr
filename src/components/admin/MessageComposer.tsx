"use client";

import { useEffect, useId, useReducer, useRef, useState, type ReactNode, type RefObject } from "react";
import { adminFetch } from "@/lib/adminApi";
import { formatAr } from "@/lib/arabicDigits";
import { CUSTOMER_MESSAGE_CTA_PAGES, CUSTOMER_MESSAGE_LIMITS, CUSTOMER_MESSAGE_PRESETS, renderCustomerMessageHtml, validateCustomerMessage, type CustomerMessage } from "@/lib/customerMessage";
import { CUSTOMER_TEXT_REFUSED_AR, NAME_FIELD, customerTextIssues, messageContentHash, withCustomerName, type MessageField } from "@/lib/campaignText";
import { DRAFT_ERRORS_AR, DRAFT_MAX_NOTE_CHARS, DRAFT_TONES, type DraftAudience, type DraftTone, type MessageDraft } from "@/lib/messageDraft";
import { ConfirmDialog } from "./ConfirmDialog";
import { CAMPAIGNS_NOT_READY_AR, isCampaignsNotReady, type CampaignLite } from "./CampaignList";
import { AIcon } from "./icons";
import { dateTimeAr } from "./format";

/**
 * THE MESSAGE COMPOSER (DT-20261118-06 phase 2A): one composer, two modes.
 * - «عميل واحد»: one e-mail to one customer through the EXISTING /api/admin/users/[id]/email route (preview, test to the admin, real send). The real send stays the admin's
 *   own click, now through ConfirmDialog. Attachments (a file from the computer, a mission's result file) work as before.
 * - «حملة»: a draft saved through /api/admin/campaigns and tested through /api/admin/campaigns/[id]/test (to the admin only). No customer send in this PR.
 * «اكتب بالذكاء الاصطناعي» posts ONLY the note, the tone and the audience to /api/admin/messages/draft and fills the fields; the admin reads and edits; nothing is sent by it.
 * A test counts only for the exact text it was sent with (`messageContentHash`): any edit clears it. The preview is the exact HTML the server sends.
 * The behaviour lives in `composerReducer` and `createComposerController` (testable without a browser); `ComposerView` draws a state.
 */
export const COMPOSER_AR = {
  aiButton: "اكتب بالذكاء الاصطناعي",
  aiNote: "هذه مسودة من الذكاء الاصطناعي. اقرأها وعدّلها قبل الإرسال؛ لن تُرسَل من نفسها.",
  noteLabel: "ماذا تريد أن تقول؟",
  notePrivacy: "لا تكتب بيانات عميل هنا (اسم أو بريد أو رقم).",
  notePlaceholder: "مثال: أخبر العملاء أن ملفات إكسل أصبحت تُسلَّم أسرع، وادعُهم لتجربة طلب جديد",
  toneLabel: "نبرة الرسالة",
  write: "اكتب المسودة",
  rewrite: "أعد الكتابة",
  writing: "جارٍ كتابة المسودة…",
  close: "إغلاق",
  insertName: "إدراج الاسم",
  testButton: "أرسل نسخة تجريبية لي",
  notTested: "لم تُرسَل نسخة تجريبية بهذا النص بعد.",
  tested: (at: string) => `وصلتك نسخة تجريبية في ${dateTimeAr(at)}.`,
  phone: "عرض الجوال",
  desktop: "عرض الحاسوب",
  previewTitle: "معاينة الرسالة",
  previewError: "تعذّر عرض المعاينة؛ راجع الحقول بالأحمر.",
  fieldRefused: "هذا الحقل يحتوي على ما لا يصلح للعميل.",
  reviewSend: "راجع ثم أرسل",
  campaignLater: "إرسال الحملات للعملاء يأتي في التحديث القادم.",
  saveDraft: "احفظ كمسودة",
  saved: "حُفظت المسودة.",
  nameRequired: "اكتب اسمًا للحملة.",
  send: "إرسال الرسالة",
  confirmTitle: "تأكيد إرسال الرسالة",
  confirmLabel: "أرسل الآن",
  remaining: (n: number) => `المتبقي لك هذه الساعة: ${formatAr(n)} مسودة.`,
  audience: "المستلمون: كل من وافق على استقبال أخبار ديجر.",
} as const;

export type ComposerMode = "single" | "campaign";
export type TextKey = "subject" | "badge" | "heading" | "body" | "ctaLabel" | "ctaPath";
export interface ComposerFields { subject: string; badge: string; heading: string; body: string; ctaLabel: string; ctaPath: string; withButton: boolean }
export interface ComposerState {
  fields: ComposerFields;
  /** the fields came from the AI helper: the pinned note shows */
  aiDrafted: boolean;
  sheetOpen: boolean;
  note: string;
  tone: DraftTone;
  drafting: boolean;
  draftError: string;
  remaining: number | null;
  /** fields the guard refused (AI draft or a test attempt): marked red until edited */
  flagged: MessageField[];
  /** the test the admin received, for the text with this hash */
  tested: { hash: string; at: string } | null;
  busy: "" | "test" | "send" | "save" | "check";
  status: { ok: boolean; text: string } | null;
  confirmOpen: boolean;
  confirmError: string | null;
  width: "phone" | "desktop";
  notReady: boolean;
  campaign: { id: string | null; revision: number | null; name: string };
}
export type ComposerAction =
  | { type: "field"; key: TextKey; value: string }
  | { type: "insertName"; key: TextKey; at: number }
  | { type: "button"; on: boolean }
  | { type: "load"; fields: ComposerFields }
  | { type: "name"; value: string }
  | { type: "sheet"; open: boolean }
  | { type: "note"; value: string }
  | { type: "tone"; value: DraftTone }
  | { type: "draftStart" }
  | { type: "draftDone"; draft: MessageDraft; refused: string | null; fields: MessageField[]; remaining: number | null }
  | { type: "draftFail"; message: string }
  | { type: "busy"; busy: ComposerState["busy"] }
  | { type: "done"; ok: boolean; text: string }
  | { type: "flag"; fields: MessageField[]; text: string }
  | { type: "tested"; hash: string; at: string; text: string }
  | { type: "saved"; id: string; revision: number }
  | { type: "notReady" }
  | { type: "confirm"; open: boolean }
  | { type: "confirmError"; text: string }
  | { type: "sent"; text: string }
  | { type: "width"; value: "phone" | "desktop" };

const DEFAULT_CTA_PATH = "/dashboard/chat";
const EMPTY: ComposerFields = { subject: "", badge: "", heading: "", body: "", ctaLabel: "", ctaPath: "", withButton: false };

export function fieldsOf(m: CustomerMessage): ComposerFields {
  return { subject: m.subject, badge: m.badge ?? "", heading: m.heading, body: m.body, ctaLabel: m.ctaLabel ?? "", ctaPath: m.ctaPath ?? "", withButton: Boolean(m.ctaLabel || m.ctaPath) };
}
/** The message as the admin wrote it (the merge field still in place). */
export function messageOfFields(f: ComposerFields): CustomerMessage {
  return { subject: f.subject, heading: f.heading, body: f.body, ...(f.badge ? { badge: f.badge } : {}), ...(f.withButton ? { ctaLabel: f.ctaLabel, ctaPath: f.ctaPath } : {}) };
}
/** The fingerprint the server records for a test: of the validated text when it is valid. */
export function contentHashOf(f: ComposerFields): string {
  const check = validateCustomerMessage(messageOfFields(f));
  return messageContentHash(check.ok ? check.value : messageOfFields(f));
}
/** True only when a test was received for exactly the text on screen now. */
export const testMatches = (s: ComposerState): boolean => s.tested !== null && s.tested.hash === contentHashOf(s.fields);
export const insertAt = (text: string, at: number, piece: string): string => {
  const i = Math.max(0, Math.min(text.length, Number.isFinite(at) ? at : text.length));
  return text.slice(0, i) + piece + text.slice(i);
};

export function initialComposerState(mode: ComposerMode, init: { fields?: ComposerFields; campaign?: CampaignLite | null } = {}): ComposerState {
  const c = mode === "campaign" ? init.campaign ?? null : null;
  const fields = c ? fieldsOf({ subject: c.subject, badge: c.badge || undefined, heading: c.heading, body: c.body, ...(c.cta_label || c.cta_path ? { ctaLabel: c.cta_label, ctaPath: c.cta_path } : {}) }) : init.fields ?? EMPTY;
  const tested = c && c.test_sent_at && c.test_content_hash && c.test_content_hash === contentHashOf(fields) ? { hash: c.test_content_hash, at: c.test_sent_at } : null;
  return {
    fields, aiDrafted: false, sheetOpen: false, note: "", tone: DRAFT_TONES[0], drafting: false, draftError: "", remaining: null, flagged: [], tested,
    busy: "", status: null, confirmOpen: false, confirmError: null, width: "desktop", notReady: false,
    campaign: { id: c?.id ?? null, revision: c?.revision ?? null, name: c?.name ?? "" },
  };
}

const edited = (s: ComposerState, fields: ComposerFields, key?: TextKey): ComposerState =>
  ({ ...s, fields, tested: null, status: null, flagged: key ? s.flagged.filter((f) => f !== key) : s.flagged });

export function composerReducer(s: ComposerState, a: ComposerAction): ComposerState {
  switch (a.type) {
    case "field": return edited(s, { ...s.fields, [a.key]: a.value }, a.key);
    case "insertName": return edited(s, { ...s.fields, [a.key]: insertAt(s.fields[a.key], a.at, NAME_FIELD) }, a.key);
    case "button": return edited(s, { ...s.fields, withButton: a.on, ...(a.on && !s.fields.ctaPath ? { ctaLabel: s.fields.ctaLabel || "فتح ديجر", ctaPath: DEFAULT_CTA_PATH } : {}) });
    case "load": return { ...edited(s, a.fields), flagged: [], aiDrafted: false, draftError: "" };
    case "name": return { ...s, campaign: { ...s.campaign, name: a.value }, status: null };
    case "sheet": return { ...s, sheetOpen: a.open };
    case "note": return { ...s, note: a.value };
    case "tone": return { ...s, tone: a.value };
    case "draftStart": return { ...s, drafting: true, draftError: "" };
    case "draftDone": {
      const d = a.draft;
      const fields: ComposerFields = { ...s.fields, subject: d.subject, badge: d.badge, heading: d.heading, body: d.body, ctaLabel: d.ctaLabel, withButton: Boolean(d.ctaLabel), ctaPath: d.ctaLabel ? s.fields.ctaPath || DEFAULT_CTA_PATH : s.fields.ctaPath };
      return { ...edited(s, fields), aiDrafted: true, sheetOpen: false, drafting: false, draftError: a.refused ?? "", flagged: a.fields, remaining: a.remaining ?? s.remaining };
    }
    case "draftFail": return { ...s, drafting: false, draftError: a.message };
    case "busy": return { ...s, busy: a.busy, status: null };
    case "done": return { ...s, busy: "", status: { ok: a.ok, text: a.text } };
    case "flag": return { ...s, busy: "", flagged: a.fields, status: { ok: false, text: a.text } };
    case "tested": return { ...s, busy: "", tested: { hash: a.hash, at: a.at }, status: { ok: true, text: a.text } };
    case "saved": return { ...s, notReady: false, campaign: { ...s.campaign, id: a.id, revision: a.revision } };
    case "notReady": return { ...s, busy: "", notReady: true, status: { ok: false, text: CAMPAIGNS_NOT_READY_AR } };
    case "confirm": return { ...s, confirmOpen: a.open, confirmError: null };
    case "confirmError": return { ...s, busy: "", confirmError: a.text };
    case "sent": return { ...s, busy: "", confirmOpen: false, confirmError: null, status: { ok: true, text: a.text } };
    case "width": return { ...s, width: a.value };
    default: return s;
  }
}

export interface DraftReply { draft: MessageDraft; refused?: boolean; fields?: MessageField[]; error?: string; remaining?: number }
export interface CampaignSaveBody { id?: string; revision?: number; name: string; subject: string; badge: string; heading: string; body: string; ctaLabel: string; ctaPath: string }
/** The composer's calls to the server (the real ones in `MessageComposer`, fakes in tests). */
export interface ComposerApi {
  draft: (body: { note: string; tone: DraftTone; audience: DraftAudience }) => Promise<DraftReply>;
  singleTest?: (m: CustomerMessage) => Promise<{ messageAr: string }>;
  singleSend?: (m: CustomerMessage) => Promise<{ messageAr: string }>;
  saveCampaign?: (body: CampaignSaveBody) => Promise<{ campaign: { id: string; revision: number } }>;
  campaignTest?: (id: string) => Promise<{ messageAr: string }>;
}

const errText = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

/** The composer's actions (kept apart from the screen so they can be tested without a browser). `get` returns the current state. */
export function createComposerController(mode: ComposerMode, api: ComposerApi, get: () => ComposerState, dispatch: (a: ComposerAction) => void, now: () => Date = () => new Date()) {
  const checked = () => validateCustomerMessage(messageOfFields(get().fields));

  async function persist(s: ComposerState): Promise<{ id: string; revision: number }> {
    if (!api.saveCampaign) throw new Error(CAMPAIGNS_NOT_READY_AR);
    const f = s.fields;
    const r = await api.saveCampaign({
      ...(s.campaign.id && s.campaign.revision ? { id: s.campaign.id, revision: s.campaign.revision } : {}),
      name: s.campaign.name.trim(), subject: f.subject, badge: f.badge, heading: f.heading, body: f.body,
      ctaLabel: f.withButton ? f.ctaLabel : "", ctaPath: f.withButton ? f.ctaPath : "",
    });
    dispatch({ type: "saved", id: r.campaign.id, revision: r.campaign.revision });
    return r.campaign;
  }
  const campaignFailure = (e: unknown, fallback: string) => {
    if (isCampaignsNotReady(e)) dispatch({ type: "notReady" });
    else dispatch({ type: "done", ok: false, text: errText(e, fallback) });
  };

  return {
    async writeDraft(): Promise<void> {
      const s = get();
      if (s.drafting) return;
      const note = s.note.trim();
      if (!note) { dispatch({ type: "draftFail", message: DRAFT_ERRORS_AR.empty }); return; }
      if (note.length > DRAFT_MAX_NOTE_CHARS) { dispatch({ type: "draftFail", message: DRAFT_ERRORS_AR.tooLong }); return; }
      dispatch({ type: "draftStart" });
      try {
        const r = await api.draft({ note, tone: s.tone, audience: mode === "single" ? "single" : "news_opt_in" });
        dispatch({ type: "draftDone", draft: r.draft, refused: r.refused ? r.error || DRAFT_ERRORS_AR.refused : null, fields: r.refused ? r.fields ?? [] : [], remaining: typeof r.remaining === "number" ? r.remaining : null });
      } catch (e) {
        dispatch({ type: "draftFail", message: errText(e, DRAFT_ERRORS_AR.failed) });
      }
    },

    /** «أرسل نسخة تجريبية لي». In single mode `greetName` replaces the merge field, as the customer will read it. */
    async test(greetName?: string | null): Promise<void> {
      const s = get();
      if (s.busy) return;
      const check = checked();
      if (!check.ok) { dispatch({ type: "done", ok: false, text: check.errorAr }); return; }
      const hash = messageContentHash(check.value);
      if (mode === "single") {
        if (!api.singleTest) return;
        dispatch({ type: "busy", busy: "test" });
        try {
          const r = await api.singleTest(withCustomerName(check.value, greetName ?? null));
          dispatch({ type: "tested", hash, at: now().toISOString(), text: r.messageAr });
        } catch (e) { dispatch({ type: "done", ok: false, text: errText(e, "تعذّر الإرسال") }); }
        return;
      }
      const issues = customerTextIssues(check.value);
      if (issues.length > 0) { dispatch({ type: "flag", fields: issues.map((i) => i.field), text: CUSTOMER_TEXT_REFUSED_AR }); return; }
      if (!s.campaign.name.trim()) { dispatch({ type: "done", ok: false, text: COMPOSER_AR.nameRequired }); return; }
      if (!api.campaignTest) return;
      dispatch({ type: "busy", busy: "test" });
      try {
        const saved = await persist(s);
        const r = await api.campaignTest(saved.id);
        dispatch({ type: "tested", hash, at: now().toISOString(), text: r.messageAr });
      } catch (e) { campaignFailure(e, "تعذّر الإرسال"); }
    },

    /** «احفظ كمسودة» (campaign mode). */
    async save(): Promise<void> {
      const s = get();
      if (s.busy || mode !== "campaign") return;
      if (!s.campaign.name.trim()) { dispatch({ type: "done", ok: false, text: COMPOSER_AR.nameRequired }); return; }
      dispatch({ type: "busy", busy: "save" });
      try { await persist(s); dispatch({ type: "done", ok: true, text: COMPOSER_AR.saved }); } catch (e) { campaignFailure(e, "تعذّر الحفظ"); }
    },

    /** The real send (single mode) never fires from one tap: it opens the confirm dialog. */
    requestSend(): void {
      const s = get();
      if (mode !== "single" || s.busy) return;
      const check = checked();
      if (!check.ok) { dispatch({ type: "done", ok: false, text: check.errorAr }); return; }
      dispatch({ type: "confirm", open: true });
    },
    cancelSend(): void {
      if (get().busy === "send") return;
      dispatch({ type: "confirm", open: false });
    },
    async confirmSend(greetName?: string | null): Promise<void> {
      const s = get();
      if (mode !== "single" || !s.confirmOpen || s.busy || !api.singleSend) return;
      const check = checked();
      if (!check.ok) { dispatch({ type: "confirmError", text: check.errorAr }); return; }
      dispatch({ type: "busy", busy: "send" });
      try {
        const r = await api.singleSend(withCustomerName(check.value, greetName ?? null));
        dispatch({ type: "sent", text: r.messageAr });
      } catch (e) { dispatch({ type: "confirmError", text: errText(e, "تعذّر الإرسال") }); }
    },
  };
}
export type ComposerController = ReturnType<typeof createComposerController>;

// ---------- the screen ----------

const IC_SPARKLE = "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z";
export const IC_PAPERCLIP = "M21.4 11.1l-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5";
const INPUT = "min-h-11 rounded-xl border bg-bg px-3 text-base text-ink outline-none";
const BTN = "min-h-11 cursor-pointer rounded-full border border-ln2 bg-transparent px-5 text-[13px] font-semibold text-ink disabled:cursor-not-allowed disabled:opacity-50";
const BTN_PRIMARY = "min-h-11 cursor-pointer rounded-full border-0 bg-ac px-5 text-[13px] font-semibold text-onac disabled:cursor-not-allowed disabled:opacity-50";

/** Which field the limits check's first complaint is about (its sentence then sits under that field). */
function fieldOfError(errorAr: string): TextKey | null {
  if (/موضوع/.test(errorAr)) return "subject";
  if (/الشارة/.test(errorAr)) return "badge";
  if (/عنوان/.test(errorAr)) return "heading";
  if (/نص الرسالة/.test(errorAr)) return "body";
  if (/رابط الزر/.test(errorAr)) return "ctaPath";
  if (/الزر|نص الزر/.test(errorAr)) return "ctaLabel";
  return null;
}

function Field(props: { id: string; label: string; value: string; max: number; onChange: (v: string) => void; error?: string; multiline?: boolean; placeholder?: string; inputRef?: RefObject<HTMLTextAreaElement | null>; aside?: ReactNode; counter?: boolean }) {
  const { id, label, value, max, onChange, error, multiline, placeholder, inputRef, aside, counter } = props;
  const errId = `${id}-err`;
  const countId = `${id}-count`;
  const describedBy = [error ? errId : "", counter ? countId : ""].filter(Boolean).join(" ") || undefined;
  const cls = `${INPUT} ${error ? "border-bad" : "border-ln"}`;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label htmlFor={id} className="text-xs text-mut">{label}</label>
        {aside}
      </div>
      {multiline
        ? <textarea id={id} ref={inputRef} aria-invalid={error ? true : undefined} aria-describedby={describedBy} value={value} maxLength={max} rows={9} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} className={`${cls} py-2 leading-[1.8]`} />
        : <input id={id} aria-invalid={error ? true : undefined} aria-describedby={describedBy} value={value} maxLength={max} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} className={cls} />}
      {counter && <span id={countId} className="text-[11px]" style={{ color: value.length >= max ? "var(--bad)" : "var(--fnt)" }}>{formatAr(value.length)} / {formatAr(max)} حرفًا</span>}
      {error && <p id={errId} role="alert" className="m-0 text-xs text-bad">{error}</p>}
    </div>
  );
}

export interface ComposerViewProps {
  mode: ComposerMode;
  state: ComposerState;
  dispatch: (a: ComposerAction) => void;
  ctl: ComposerController;
  /** single mode: who gets it, and the admin's own address for the test */
  recipient?: { email: string; adminEmail: string | null; greetingName: string };
  /** single mode: the attachments box */
  attachments?: ReactNode;
  /** single mode: the attachments' names for the confirm dialog */
  attachmentNames?: string;
}

export function ComposerView({ mode, state, dispatch, ctl, recipient, attachments, attachmentNames }: ComposerViewProps) {
  const uid = useId();
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);
  const f = state.fields;
  const L = CUSTOMER_MESSAGE_LIMITS;
  const greet = mode === "single" ? recipient?.greetingName ?? null : null;
  const check = validateCustomerMessage(messageOfFields(f));
  const previewHtml = check.ok ? renderCustomerMessageHtml(withCustomerName(check.value, greet)) : "";
  const guard = mode === "campaign" && check.ok ? customerTextIssues(check.value).map((i) => i.field) : [];
  const limitField = check.ok ? null : fieldOfError(check.errorAr);
  const errorOf = (k: TextKey): string | undefined => {
    if (limitField === k && !check.ok) return check.errorAr;
    if ((state.flagged as string[]).includes(k) || (guard as string[]).includes(k)) return COMPOSER_AR.fieldRefused;
    return undefined;
  };
  const set = (key: TextKey) => (value: string) => dispatch({ type: "field", key, value });
  const id = (k: string) => `${uid}-${k}`;
  const busy = state.busy !== "";
  const tested = testMatches(state);
  const testBlocked = !check.ok || busy || (mode === "single" && !recipient?.adminEmail);
  const presetName = mode === "single" ? greet ?? "" : NAME_FIELD;

  return (
    <div className="flex flex-col gap-3">
      {mode === "single" && recipient && (
        <p className="m-0 text-xs text-mut">إلى: <span dir="ltr" className="font-semibold text-ink">{recipient.email}</span> · من: <span dir="ltr">noreply@diger.tech</span> · الردود إلى <span dir="ltr">support@diger.tech</span></p>
      )}
      {mode === "campaign" && (
        <>
          <p className="m-0 text-xs text-mut">{COMPOSER_AR.audience}</p>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={id("name")} className="text-xs text-mut">اسم الحملة (لا يراه العملاء)</label>
            <input id={id("name")} value={state.campaign.name} maxLength={120} onChange={(e) => dispatch({ type: "name", value: e.target.value })} className={`${INPUT} border-ln`} />
          </div>
        </>
      )}
      {state.notReady && <p role="status" className="m-0 rounded-xl bg-sf2 p-2.5 text-[13px] text-ink">{CAMPAIGNS_NOT_READY_AR}</p>}

      <button type="button" onClick={() => dispatch({ type: "sheet", open: true })} className="flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-xl border border-ln2 bg-sf2 px-4 text-[14px] font-semibold text-ink">
        <AIcon d={IC_SPARKLE} />{COMPOSER_AR.aiButton}
      </button>
      {(state.aiDrafted || state.draftError) && !state.sheetOpen && (
        <div role="note" className="flex flex-col gap-2 rounded-xl border p-3" style={{ borderColor: "var(--gold)", background: "var(--sf2)" }}>
          {state.aiDrafted && <p className="m-0 flex items-start gap-2 text-[13px] leading-[1.8] text-ink"><AIcon d={IC_SPARKLE} size={16} />{COMPOSER_AR.aiNote}</p>}
          {state.draftError && <p role="alert" className="m-0 text-xs text-bad">{state.draftError}</p>}
          {state.remaining !== null && <p className="m-0 text-[11px] text-fnt">{COMPOSER_AR.remaining(state.remaining)}</p>}
          {state.aiDrafted && <button type="button" onClick={() => void ctl.writeDraft()} disabled={state.drafting || !state.note.trim()} className={`${BTN} self-start`}>{state.drafting ? COMPOSER_AR.writing : COMPOSER_AR.rewrite}</button>}
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        <label htmlFor={id("preset")} className="text-xs text-mut">ابدأ من نص جاهز</label>
        <select id={id("preset")} value="" onChange={(e) => { const p = CUSTOMER_MESSAGE_PRESETS.find((x) => x.id === e.target.value); if (p) dispatch({ type: "load", fields: fieldsOf(p.build({ name: presetName })) }); }} className={`${INPUT} border-ln`}>
          <option value="">اختر نصًا جاهزًا</option>
          {CUSTOMER_MESSAGE_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.labelAr}</option>)}
        </select>
      </div>
      <Field id={id("subject")} label="موضوع الرسالة" value={f.subject} max={L.subject.max} onChange={set("subject")} error={errorOf("subject")} />
      <Field id={id("badge")} label="الشارة (اختياري)" value={f.badge} max={L.badge.max} onChange={set("badge")} error={errorOf("badge")} placeholder="مثال: تحديث بخصوص طلبك" />
      <Field id={id("heading")} label="العنوان داخل الرسالة" value={f.heading} max={L.heading.max} onChange={set("heading")} error={errorOf("heading")} />
      <Field id={id("body")} label="نص الرسالة (سطر فارغ = فقرة جديدة)" value={f.body} max={L.body.max} onChange={set("body")} error={errorOf("body")} multiline counter inputRef={bodyRef}
        aside={<button type="button" onClick={() => dispatch({ type: "insertName", key: "body", at: bodyRef.current?.selectionStart ?? f.body.length })} className="min-h-11 cursor-pointer rounded-full border border-ln2 bg-sf px-4 text-xs font-semibold text-ink">{COMPOSER_AR.insertName}</button>} />

      <label className="flex min-h-11 items-center gap-2 text-xs text-ink"><input type="checkbox" checked={f.withButton} onChange={(e) => dispatch({ type: "button", on: e.target.checked })} className="h-5 w-5" /> زر داخل الرسالة</label>
      {f.withButton && (
        <div className="grid grid-cols-2 gap-2">
          <Field id={id("ctaLabel")} label="نص الزر" value={f.ctaLabel} max={L.ctaLabel.max} onChange={set("ctaLabel")} error={errorOf("ctaLabel")} />
          <div className="flex flex-col gap-1.5">
            <label htmlFor={id("ctaPath")} className="text-xs text-mut">يفتح</label>
            <select id={id("ctaPath")} value={f.ctaPath} aria-invalid={errorOf("ctaPath") ? true : undefined} onChange={(e) => set("ctaPath")(e.target.value)} className={`${INPUT} border-ln`}>
              {CUSTOMER_MESSAGE_CTA_PAGES.map((p) => <option key={p.path} value={p.path}>{p.labelAr}</option>)}
            </select>
          </div>
        </div>
      )}

      {attachments}

      <section aria-label="المعاينة" className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs font-semibold text-ink">المعاينة: هكذا تصل الرسالة</span>
          <div className="flex gap-1.5">
            {(["phone", "desktop"] as const).map((w) => (
              <button key={w} type="button" aria-pressed={state.width === w} onClick={() => dispatch({ type: "width", value: w })} className="min-h-11 cursor-pointer rounded-full border px-4 text-xs font-semibold"
                style={{ background: state.width === w ? "var(--ac)" : "transparent", color: state.width === w ? "var(--onac)" : "var(--ink)", borderColor: state.width === w ? "var(--ac)" : "var(--ln2)" }}>{w === "phone" ? COMPOSER_AR.phone : COMPOSER_AR.desktop}</button>
            ))}
          </div>
        </div>
        {check.ok
          ? <div className="mx-auto w-full overflow-hidden rounded-xl border border-ln" style={{ maxWidth: state.width === "phone" ? 390 : "100%" }}><iframe title={COMPOSER_AR.previewTitle} sandbox="" srcDoc={previewHtml} className="block h-[520px] w-full border-0 bg-white" /></div>
          : <p role="alert" className="m-0 text-xs text-bad">{COMPOSER_AR.previewError}</p>}
      </section>

      <div className="flex flex-col gap-1.5">
        <button type="button" onClick={() => void ctl.test(greet)} disabled={testBlocked} className={`${BTN} self-start`}>{state.busy === "test" ? "جارٍ الإرسال…" : COMPOSER_AR.testButton}</button>
        <p role="status" aria-live="polite" className="m-0 text-xs" style={{ color: tested ? "var(--ok)" : "var(--mut)" }}>{tested && state.tested ? COMPOSER_AR.tested(state.tested.at) : COMPOSER_AR.notTested}</p>
      </div>

      {mode === "single" ? (
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => ctl.requestSend()} disabled={!check.ok || busy} className={BTN_PRIMARY}>{state.busy === "send" ? "جارٍ الإرسال…" : COMPOSER_AR.send}</button>
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => void ctl.save()} disabled={busy} className={BTN}>{state.busy === "save" ? "جارٍ الحفظ…" : COMPOSER_AR.saveDraft}</button>
            <button type="button" disabled aria-describedby={id("later")} className={BTN_PRIMARY}>{COMPOSER_AR.reviewSend}</button>
          </div>
          <p id={id("later")} className="m-0 text-xs text-mut">{COMPOSER_AR.campaignLater}</p>
        </div>
      )}
      <p role="status" aria-live="polite" className="m-0 min-h-[1.1rem] text-xs leading-[1.8]" style={{ color: state.status ? (state.status.ok ? "var(--ok)" : "var(--bad)") : "var(--fnt)" }}>
        {state.status?.text || (mode === "single" ? "تُسجَّل كل رسالة للعميل في سجل الإدارة باسمك." : "")}
      </p>

      {state.sheetOpen && <DraftSheet state={state} dispatch={dispatch} ctl={ctl} idOf={id} />}
      {mode === "single" && (
        <ConfirmDialog open={state.confirmOpen} title={COMPOSER_AR.confirmTitle} confirmLabel={COMPOSER_AR.confirmLabel} working={state.busy === "send"} error={state.confirmError}
          onCancel={() => ctl.cancelSend()} onConfirm={() => void ctl.confirmSend(greet)}
          body={<>ستُرسَل «{check.ok ? check.value.subject : f.subject}» إلى <span dir="ltr">{recipient?.email ?? ""}</span>. لا يمكن سحب الرسالة بعد إرسالها.{attachmentNames ? <><br />المرفقات: {attachmentNames}</> : null}</>} />
      )}
    </div>
  );
}

/** The «اكتب بالذكاء الاصطناعي» bottom sheet: the note (2000 max), the tone, write / rewrite. */
function DraftSheet({ state, dispatch, ctl, idOf }: { state: ComposerState; dispatch: (a: ComposerAction) => void; ctl: ComposerController; idOf: (k: string) => string }) {
  const close = () => { if (!state.drafting) dispatch({ type: "sheet", open: false }); };
  return (
    <div className="fixed inset-0 z-[300] flex items-end justify-center min-[900px]:items-center" onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } }}>
      <div aria-hidden="true" onClick={close} className="absolute inset-0" style={{ background: "rgba(8,10,10,.5)" }} />
      <div role="dialog" aria-modal="true" aria-labelledby={idOf("ai-title")}
        className="relative flex max-h-[90dvh] w-full max-w-[520px] flex-col gap-3 overflow-y-auto rounded-t-[20px] border border-ln bg-sf p-[18px] min-[900px]:rounded-[20px] motion-safe:animate-[sheetUp_.3s_both]"
        style={{ boxShadow: "var(--admin-shadow)", paddingBlockEnd: "calc(18px + env(safe-area-inset-bottom))" }}>
        <h2 id={idOf("ai-title")} className="m-0 flex items-center gap-2 text-[17px] font-semibold text-ink"><AIcon d={IC_SPARKLE} />{COMPOSER_AR.aiButton}</h2>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={idOf("note")} className="text-xs text-mut">{COMPOSER_AR.noteLabel}</label>
          <textarea id={idOf("note")} autoFocus aria-describedby={`${idOf("privacy")} ${idOf("note-count")}`} value={state.note} maxLength={DRAFT_MAX_NOTE_CHARS} rows={6} placeholder={COMPOSER_AR.notePlaceholder}
            onChange={(e) => dispatch({ type: "note", value: e.target.value })} className={`${INPUT} border-ln py-2 leading-[1.8]`} />
          <p id={idOf("privacy")} className="m-0 text-xs text-ink2">{COMPOSER_AR.notePrivacy}</p>
          <span id={idOf("note-count")} className="text-[11px]" style={{ color: state.note.length >= DRAFT_MAX_NOTE_CHARS ? "var(--bad)" : "var(--fnt)" }}>{formatAr(state.note.length)} / {formatAr(DRAFT_MAX_NOTE_CHARS)} حرفًا</span>
        </div>
        <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0">
          <legend className="mb-1.5 p-0 text-xs text-mut">{COMPOSER_AR.toneLabel}</legend>
          <div className="flex flex-wrap gap-2">
            {DRAFT_TONES.map((t) => (
              <label key={t} className="flex min-h-11 cursor-pointer items-center gap-2 rounded-full border border-ln2 px-4 text-[13px] text-ink">
                <input type="radio" name={idOf("tone")} value={t} checked={state.tone === t} onChange={() => dispatch({ type: "tone", value: t })} />{t}
              </label>
            ))}
          </div>
        </fieldset>
        {state.draftError && <p role="alert" className="m-0 text-xs text-bad">{state.draftError}</p>}
        {state.remaining !== null && <p className="m-0 text-[11px] text-fnt">{COMPOSER_AR.remaining(state.remaining)}</p>}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" onClick={close} disabled={state.drafting} className={BTN}>{COMPOSER_AR.close}</button>
          <button type="button" onClick={() => void ctl.writeDraft()} disabled={state.drafting} className={BTN_PRIMARY}>{state.drafting ? COMPOSER_AR.writing : state.aiDrafted ? COMPOSER_AR.rewrite : COMPOSER_AR.write}</button>
        </div>
      </div>
    </div>
  );
}

// ---------- the live composer ----------

interface MissionOption { id: string; status: string; createdAt: string | null; requestAr: string; files: string[] }
interface Info { email: string; name: string; greetingName: string; adminEmail: string | null; uploadMaxBytes: number; missions: MissionOption[] }
interface AttachmentInfo { filename: string; bytes: number; source: string }

const newKey = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `k${Date.now()}${Math.floor(Math.random() * 1e9)}`).replace(/[^A-Za-z0-9_-]/g, "");
const kb = (n: number) => `${formatAr(Math.max(1, Math.round(n / 1024)))} ك.ب`;
const ACCEPT = ".xlsx,.csv,.pdf,.docx";
const draftCall = (body: { note: string; tone: DraftTone; audience: DraftAudience }) => adminFetch<DraftReply>("/api/admin/messages/draft", { method: "POST", body: JSON.stringify(body) });

export type MessageComposerProps = { mode: "single"; userId: string } | { mode: "campaign"; campaign?: CampaignLite | null; onSaved?: () => void };

export function MessageComposer(props: MessageComposerProps) {
  return props.mode === "single" ? <SingleComposer userId={props.userId} /> : <CampaignComposer campaign={props.campaign ?? null} onSaved={props.onSaved} />;
}

function useComposer(mode: ComposerMode, init: Parameters<typeof initialComposerState>[1]) {
  const [state, dispatch] = useReducer(composerReducer, undefined, () => initialComposerState(mode, init));
  const ref = useRef(state);
  ref.current = state;
  return { state, dispatch, get: () => ref.current };
}

function CampaignComposer({ campaign, onSaved }: { campaign: CampaignLite | null; onSaved?: () => void }) {
  const { state, dispatch, get } = useComposer("campaign", { campaign });
  const ctl = createComposerController("campaign", {
    draft: draftCall,
    saveCampaign: (body) => adminFetch<{ campaign: { id: string; revision: number } }>("/api/admin/campaigns", { method: "POST", body: JSON.stringify(body) }),
    campaignTest: (id) => adminFetch<{ messageAr: string }>(`/api/admin/campaigns/${id}/test`, { method: "POST", body: "{}" }),
  }, get, dispatch);
  const revision = state.campaign.revision;
  const savedRef = useRef(revision);
  useEffect(() => { if (revision !== savedRef.current) { savedRef.current = revision; onSaved?.(); } }, [revision, onSaved]);
  return <ComposerView mode="campaign" state={state} dispatch={dispatch} ctl={ctl} />;
}

function SingleComposer({ userId }: { userId: string }) {
  const { state, dispatch, get } = useComposer("single", {});
  const [info, setInfo] = useState<Info | null>(null);
  const [loadError, setLoadError] = useState("");
  const [missionId, setMissionId] = useState("");
  const [fileName, setFileName] = useState("result.xlsx");
  const [upload, setUpload] = useState<File | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const [checkedFiles, setCheckedFiles] = useState<AttachmentInfo[] | null>(null);
  const [key, setKey] = useState(newKey);

  useEffect(() => {
    let alive = true;
    adminFetch<Info>(`/api/admin/users/${userId}/email`).then((i) => {
      if (!alive) return;
      setInfo(i);
      dispatch({ type: "load", fields: fieldsOf(CUSTOMER_MESSAGE_PRESETS[0].build({ name: i.greetingName })) });
    }).catch((e) => { if (alive) setLoadError(e instanceof Error ? e.message : "تعذّر التحميل"); });
    return () => { alive = false; };
  }, [userId, dispatch]);

  /** JSON, or multipart when a file from the computer is attached (the payload is the same JSON). */
  const call = <T,>(action: "preview" | "send" | "test", m: CustomerMessage) => {
    const payload = { ...m, action, ...(missionId.trim() ? { missionId: missionId.trim(), fileName } : {}), idempotencyKey: key };
    if (!upload) return adminFetch<T>(`/api/admin/users/${userId}/email`, { method: "POST", body: JSON.stringify(payload) });
    const form = new FormData();
    form.append("payload", JSON.stringify(payload));
    form.append("file", upload, upload.name);
    return adminFetch<T>(`/api/admin/users/${userId}/email`, { method: "POST", body: form });
  };
  const deliver = async (action: "send" | "test", m: CustomerMessage) => {
    const r = await call<{ messageAr: string; attachments: AttachmentInfo[] }>(action, m);
    setCheckedFiles(r.attachments);
    setKey(newKey());
    return r;
  };
  const ctl = createComposerController("single", { draft: draftCall, singleTest: (m) => deliver("test", m), singleSend: (m) => deliver("send", m) }, get, dispatch);

  const maxUpload = info?.uploadMaxBytes ?? 4 * 1024 * 1024;
  const pickFile = (file: File | null) => {
    setCheckedFiles(null);
    if (!file) { setUpload(null); return; }
    const ext = file.name.toLowerCase().split(".").pop() ?? "";
    if (!["xlsx", "csv", "pdf", "docx"].includes(ext)) { setUpload(null); dispatch({ type: "done", ok: false, text: "نوع الملف غير مسموح؛ المسموح: Excel أو CSV أو PDF أو Word." }); return; }
    if (file.size > maxUpload) { setUpload(null); dispatch({ type: "done", ok: false, text: "الملف أكبر من ٤ ميجابايت." }); return; }
    setUpload(file);
  };
  const clearFile = () => { setUpload(null); setCheckedFiles(null); if (fileInput.current) fileInput.current.value = ""; };
  const checkAttachments = async () => {
    const check = validateCustomerMessage(messageOfFields(state.fields));
    if (!check.ok || !info) return;
    dispatch({ type: "busy", busy: "check" });
    try {
      const r = await call<{ attachments: AttachmentInfo[] }>("preview", withCustomerName(check.value, info.greetingName));
      setCheckedFiles(r.attachments);
      dispatch({ type: "done", ok: true, text: r.attachments.length ? "المرفقات جاهزة." : "لا مرفقات." });
    } catch (e) { setCheckedFiles(null); dispatch({ type: "done", ok: false, text: e instanceof Error ? e.message : "تعذّر فحص المرفقات" }); }
  };

  if (loadError) return <p role="alert" className="m-0 text-xs text-bad">{loadError}</p>;
  if (!info) return <p role="status" className="m-0 text-xs text-fnt">جارٍ التحميل…</p>;

  const field = "min-h-11 rounded-xl border border-ln bg-bg px-3 text-base text-ink outline-none";
  const attachments = (
    <div className="flex flex-col gap-2 rounded-xl bg-sf2 p-2.5">
      <span className="text-xs font-semibold text-ink">المرفقات (اختياري)</span>
      <label className="flex flex-col gap-1.5">
        <span className="text-[11px] text-fnt">ملف من جهازك: Excel أو CSV أو PDF أو Word، حتى ٤ ميجابايت.</span>
        <input ref={fileInput} type="file" accept={ACCEPT} onChange={(e) => pickFile(e.target.files?.[0] ?? null)} aria-label="ملف مرفق من جهازك" className="text-xs text-ink file:me-2 file:ms-0 file:min-h-11 file:cursor-pointer file:rounded-full file:border file:border-ln2 file:bg-sf file:px-4 file:text-xs file:font-semibold file:text-ink" />
      </label>
      {upload && (
        <span className="flex items-center gap-2 text-[11px] text-ink"><AIcon d={IC_PAPERCLIP} size={14} /><span dir="ltr">{upload.name}</span> ({kb(upload.size)})
          <button type="button" onClick={clearFile} className="min-h-11 cursor-pointer rounded-full border border-ln2 bg-transparent px-4 text-[11px] text-ink">إزالة</button>
        </span>
      )}
      <label className="mt-1 flex flex-col gap-1.5">
        <span className="text-[11px] text-fnt">أو ملف نتائج مهمة: من مهام هذا العميل، أو رقم مهمة شغّلتها له من «الوكيل» أو «إعادة تشغيل مجانية».</span>
        <select value={info.missions.some((x) => x.id === missionId) ? missionId : ""} onChange={(e) => { setMissionId(e.target.value); setCheckedFiles(null); }} className={field}>
          <option value="">بدون ملف مهمة / رقم آخر</option>
          {info.missions.filter((x) => x.files.length > 0).map((x) => <option key={x.id} value={x.id}>{(x.createdAt ? dateTimeAr(x.createdAt).split("،")[0] + " · " : "") + x.requestAr.slice(0, 60)}</option>)}
        </select>
      </label>
      <div className="grid grid-cols-[1fr_auto] gap-2">
        <input dir="ltr" value={missionId} onChange={(e) => { setMissionId(e.target.value.trim()); setCheckedFiles(null); }} placeholder="msn_…" aria-label="رقم المهمة" className={`${field} text-start font-mono text-sm`} />
        <select value={fileName} onChange={(e) => { setFileName(e.target.value); setCheckedFiles(null); }} aria-label="نوع ملف المهمة" className={field}><option value="result.xlsx">Excel</option><option value="result.csv">CSV</option></select>
      </div>
      {(upload || missionId) && <button type="button" onClick={() => void checkAttachments()} disabled={state.busy !== ""} className="min-h-11 cursor-pointer self-start rounded-full border border-ln2 bg-transparent px-4 text-xs font-semibold text-ink disabled:opacity-50">{state.busy === "check" ? "جارٍ الفحص…" : "فحص المرفقات"}</button>}
      {checkedFiles && checkedFiles.length > 0 && checkedFiles.map((a) => <span key={a.filename + a.source} className="flex items-center gap-1.5 text-[11px] text-ok"><AIcon d={IC_PAPERCLIP} size={14} />{a.filename} ({kb(a.bytes)})</span>)}
    </div>
  );
  const names = [upload?.name, missionId.trim() ? `ملف المهمة ${missionId.trim()}` : ""].filter(Boolean).join("، ");
  return <ComposerView mode="single" state={state} dispatch={dispatch} ctl={ctl} recipient={{ email: info.email, adminEmail: info.adminEmail, greetingName: info.greetingName }} attachments={attachments} attachmentNames={names} />;
}
