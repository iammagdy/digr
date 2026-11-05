"use client";

import { browserFetch } from "@/lib/agentMission/stage4/browserFetch";
import { useCallback, useEffect, useState } from "react";
import { formatAr } from "@/lib/arabicDigits";
import { createClient } from "@/lib/supabase/client";
import ApproveAddon from "./ApproveAddon";
import type { ApproveResult } from "@/lib/agentMission/stage4/addonApprovalClient";
import { cancelEditRequest, fetchEditRequest, fetchEditSchema, prepareEditRequest, quoteEdit } from "@/lib/agentMission/stage4/editRequestClient";
import { emptyForm, editInputOf, type EditForm } from "@/lib/agentMission/stage4/editRequestForm";
import {
  EDIT_ASKING_AR, EDIT_ASK_BUTTON_AR, EDIT_CANCELLED_AR, EDIT_CANCELLING_AR, EDIT_CANCEL_BUTTON_AR, EDIT_HEADING_AR, EDIT_INTRO_AR, EDIT_KINDS_AR, EDIT_LOADING_AR, EDIT_PREPARE_BUTTON_AR, EDIT_PREPARING_AR, EDIT_RETRY_AR,
  editQuoteLinesAr, editRequestLinesAr, editVersionAr, type EditKind, type EditQuoteView, type EditRequestView, type EditSchemaView,
} from "@/lib/agentMission/stage4/editRequestLabels";

/**
 * STAGE B: «تعديل الملف» on the request's own page. The customer picks a kind of change on the LATEST version, fills a small form, asks for the price and sees which version they edit, what will change, what the request covers, the estimated charge, the most that may be held and that NOTHING has
 * moved before approval. «تجهيز طلب التعديل» makes a request that WAITS; the page finds it again after a refresh and offers «إلغاء الطلب» while it is unpaid. There is NO approval button and NO price field: the browser sends what the customer typed and formats what the server answered.
 * What needs a new lookup says plainly that it is not available yet, with no price. While the feature is off (the routes answer 404) or the file has no published version, it draws NOTHING, so the page is what it was.
 */
const BTN = "min-h-11 w-full cursor-pointer rounded-full border border-ln2 bg-transparent px-5 text-[13px] text-ink focus-visible:outline-2 disabled:cursor-wait disabled:opacity-60 sm:w-auto";
const FIELD = "min-h-11 w-full rounded-[12px] border border-ln2 bg-transparent px-3 text-[13px] text-ink focus-visible:outline-2 disabled:opacity-60";
const LABEL = "flex flex-col gap-1 text-[13px] text-ink";
/** What one form may grow to on the page (the server accepts more; a phone form this long is not usable). */
const UI_MAX = { cells: 20, rows: 10 } as const;
const KINDS = Object.keys(EDIT_KINDS_AR) as EditKind[];

export interface EditRequestBodyProps {
  schema: EditSchemaView | null;
  status: "idle" | "loading" | "ready" | "error";
  form: EditForm | null;
  onForm: (form: EditForm | null) => void;
  onAsk: () => void;
  busy?: boolean;
  quote?: EditQuoteView | null;
  error?: string | null;
  waiting?: EditRequestView | null;
  onPrepare?: () => void;
  preparing?: boolean;
  onCancel?: () => void;
  cancelling?: boolean;
  notice?: string | null;
  /** The approval button (launch round): drawn under the waiting request only when the container passes it (it draws nothing while the approval is off). */
  approval?: React.ReactNode;
  onRetry?: () => void;
}

function Fields({ schema, form, onForm, disabled }: { schema: EditSchemaView; form: EditForm; onForm: (f: EditForm | null) => void; disabled: boolean }) {
  const sheet = schema.sheets.find((s) => s.name === form.sheet) ?? schema.sheets[0];
  const columns = sheet?.columns ?? [];
  const sheetPicker = schema.sheets.length > 1 ? (
    <label className={LABEL}><span>الورقة</span>
      <select className={FIELD} value={form.sheet} disabled={disabled} onChange={(e) => onForm(emptyForm(form.kind, schema, e.target.value))}>
        {schema.sheets.map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}
      </select>
    </label>
  ) : null;
  switch (form.kind) {
    case "rename_column":
      return (
        <div className="flex flex-col gap-3">
          {sheetPicker}
          <label className={LABEL}><span>العمود الذي تريد تغيير اسمه</span>
            <select className={FIELD} value={form.from} disabled={disabled} onChange={(e) => onForm({ ...form, from: e.target.value })}>
              <option value="">اختر العمود</option>
              {columns.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
          <label className={LABEL}><span>الاسم الجديد</span>
            <input type="text" className={FIELD} value={form.to} disabled={disabled} maxLength={120} onChange={(e) => onForm({ ...form, to: e.target.value })} />
          </label>
        </div>
      );
    case "set_cells":
      return (
        <div className="flex flex-col gap-3">
          {sheetPicker}
          {form.cells.map((c, i) => (
            <fieldset key={i} className="m-0 flex flex-col gap-2 rounded-[12px] border border-ln p-3">
              <legend className="px-1 text-[12px] text-mut">{`الخانة رقم ${formatAr(i + 1)}`}</legend>
              <label className={LABEL}><span>رقم العنصر في الورقة</span>
                <input type="text" inputMode="numeric" className={FIELD} value={c.row} disabled={disabled} maxLength={7} onChange={(e) => onForm({ ...form, cells: form.cells.map((x, j) => (j === i ? { ...x, row: e.target.value } : x)) })} />
              </label>
              <label className={LABEL}><span>العمود</span>
                <select className={FIELD} value={c.column} disabled={disabled} onChange={(e) => onForm({ ...form, cells: form.cells.map((x, j) => (j === i ? { ...x, column: e.target.value } : x)) })}>
                  <option value="">اختر العمود</option>
                  {columns.map((col) => <option key={col} value={col}>{col}</option>)}
                </select>
              </label>
              <label className={LABEL}><span>القيمة الجديدة</span>
                <input type="text" className={FIELD} value={c.value} disabled={disabled} maxLength={500} onChange={(e) => onForm({ ...form, cells: form.cells.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) })} />
              </label>
            </fieldset>
          ))}
          {form.cells.length < UI_MAX.cells ? <button type="button" className={BTN} disabled={disabled} onClick={() => onForm({ ...form, cells: [...form.cells, { row: "", column: "", value: "" }] })}>إضافة خانة أخرى</button> : null}
        </div>
      );
    case "add_rows":
      return (
        <div className="flex flex-col gap-3">
          {sheetPicker}
          {form.rows.map((r, i) => (
            <fieldset key={i} className="m-0 flex flex-col gap-2 rounded-[12px] border border-ln p-3">
              <legend className="px-1 text-[12px] text-mut">{`عنصر جديد رقم ${formatAr(i + 1)}`}</legend>
              {columns.map((col) => (
                <label key={col} className={LABEL}><span>{col}</span>
                  <input type="text" className={FIELD} value={r[col] ?? ""} disabled={disabled} maxLength={500} onChange={(e) => onForm({ ...form, rows: form.rows.map((x, j) => (j === i ? { ...x, [col]: e.target.value } : x)) })} />
                </label>
              ))}
            </fieldset>
          ))}
          {form.rows.length < UI_MAX.rows ? <button type="button" className={BTN} disabled={disabled} onClick={() => onForm({ ...form, rows: [...form.rows, {}] })}>إضافة عنصر آخر</button> : null}
        </div>
      );
    case "add_column":
      return (
        <div className="flex flex-col gap-3">
          {sheetPicker}
          <label className={LABEL}><span>اسم العمود الجديد</span>
            <input type="text" className={FIELD} value={form.titleAr} disabled={disabled} maxLength={120} onChange={(e) => onForm({ ...form, titleAr: e.target.value })} />
          </label>
        </div>
      );
  }
}

export function EditRequestBody({ schema, status, form, onForm, onAsk, busy = false, quote = null, error = null, waiting = null, onPrepare, preparing = false, onCancel, cancelling = false, notice = null, onRetry, approval = null }: EditRequestBodyProps) {
  if (status === "idle" || (status === "ready" && !schema && !waiting)) return null;
  const head = <h2 id="edit-request-heading" className="m-0 text-[15px] font-medium text-ink">{EDIT_HEADING_AR}</h2>;
  const shell = (children: React.ReactNode) => <section data-testid="edit-request" aria-labelledby="edit-request-heading" dir="rtl" className="flex flex-col gap-3 break-words rounded-[18px] border border-ln bg-sf p-4">{head}{children}</section>;
  const alert = error ? <p role="alert" data-testid="edit-error" className="m-0 text-[13px] leading-[1.9] text-ink2">{error}</p> : null;
  const noticeEl = notice ? <p data-testid="edit-notice" className="m-0 text-[13px] leading-[1.9] text-ink2">{notice}</p> : null;
  if (status === "loading") return shell(<p role="status" aria-busy="true" data-testid="edit-loading" className="m-0 text-[13px] leading-[1.9] text-ink2">{EDIT_LOADING_AR}</p>);
  if (status === "error") {
    return shell(
      <div className="flex flex-col gap-2">
        <p role="alert" data-testid="edit-error" className="m-0 text-[13px] leading-[1.9] text-ink2">{error}</p>
        {onRetry ? <button type="button" data-testid="edit-retry" className={BTN} onClick={onRetry}>{EDIT_RETRY_AR}</button> : null}
      </div>,
    );
  }
  if (waiting) {
    return shell(
      <>
        <div data-testid="edit-waiting" aria-live="polite" className="flex flex-col gap-1 text-[13px] leading-[1.9] text-ink">
          {editRequestLinesAr(waiting).map((line, i) => <p key={i} className={i === 0 ? "m-0 font-medium" : "m-0 text-ink2"}>{line}</p>)}
        </div>
        {approval}
        {onCancel ? <button type="button" data-testid="edit-cancel" className={BTN} disabled={cancelling} aria-busy={cancelling ? true : undefined} onClick={onCancel}>{cancelling ? EDIT_CANCELLING_AR : EDIT_CANCEL_BUTTON_AR}</button> : null}
        {alert}
      </>,
    );
  }
  const locked = busy || preparing;
  const lines = quote ? editQuoteLinesAr(quote) : [];
  return shell(
    <>
      <p className="m-0 text-[13px] leading-[1.9] text-ink2">{EDIT_INTRO_AR}</p>
      {schema ? <p data-testid="edit-version" className="m-0 text-[13px] leading-[1.9] text-ink">{editVersionAr(schema.version)}</p> : null}
      <label className={LABEL}><span>نوع التعديل</span>
        <select data-testid="edit-kind" className={FIELD} value={form?.kind ?? ""} disabled={locked} onChange={(e) => onForm(e.target.value === "" || !schema ? null : emptyForm(e.target.value as EditKind, schema))}>
          <option value="">اختر نوع التعديل</option>
          {KINDS.map((k) => <option key={k} value={k}>{EDIT_KINDS_AR[k]}</option>)}
        </select>
      </label>
      {form && schema ? <Fields schema={schema} form={form} onForm={onForm} disabled={locked} /> : null}
      {form ? <button type="button" data-testid="edit-ask" className={BTN} disabled={locked} aria-busy={busy ? true : undefined} onClick={onAsk}>{busy ? EDIT_ASKING_AR : EDIT_ASK_BUTTON_AR}</button> : null}
      {alert}
      {noticeEl}
      <div data-testid="edit-result" aria-live="polite" className="flex flex-col gap-1 text-[13px] leading-[1.9] text-ink">
        {lines.map((line, i) => <p key={i} className={i === 0 ? "m-0 font-medium" : "m-0 text-ink2"}>{line}</p>)}
      </div>
      {onPrepare && quote?.state === "offer" ? <button type="button" data-testid="edit-prepare" className={BTN} disabled={preparing} aria-busy={preparing ? true : undefined} onClick={onPrepare}>{preparing ? EDIT_PREPARING_AR : EDIT_PREPARE_BUTTON_AR}</button> : null}
    </>,
  );
}

async function authHeaders(): Promise<Record<string, string>> {
  try {
    const { data } = await createClient().auth.getSession();
    const token = data?.session?.access_token;
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch { return {}; }
}

export default function EditRequestCard({ missionId }: { missionId: string }) {
  const [schema, setSchema] = useState<EditSchemaView | null>(null);
  const [status, setStatus] = useState<EditRequestBodyProps["status"]>("idle");
  const [form, setForm] = useState<EditForm | null>(null);
  const [quote, setQuote] = useState<EditQuoteView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [waiting, setWaiting] = useState<EditRequestView | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const start = useCallback(async (alive: () => boolean) => {
    setStatus("loading");
    const [s, request] = await Promise.all([fetchEditSchema({ missionId, fetchFn: browserFetch, headers: authHeaders }), fetchEditRequest({ missionId, fetchFn: browserFetch, headers: authHeaders })]);
    if (!alive()) return;
    setWaiting(request);
    if (s.state === "ok") { setSchema(s.schema); setStatus("ready"); }
    else if (s.state === "error") { setError(s.message); setStatus("error"); }
    else setStatus(request ? "ready" : "idle");
  }, [missionId]);
  useEffect(() => {
    let alive = true;
    void start(() => alive);
    return () => { alive = false; };
  }, [start]);

  const onForm = useCallback((f: EditForm | null) => { setForm(f); setQuote(null); setError(null); setNotice(null); }, []);
  const onAsk = useCallback(async () => {
    if (!form || !schema) return;
    const input = editInputOf(form, schema);
    setNotice(null);
    if (!input.ok) { setQuote(null); setError(input.messageAr); return; }
    setBusy(true); setQuote(null); setError(null);
    const r = await quoteEdit({ missionId, version: schema.version, edit: input.input, fetchFn: browserFetch, headers: authHeaders });
    if (r.ok) setQuote(r.quote); else setError(r.message);
    setBusy(false);
  }, [form, schema, missionId]);
  const onPrepare = useCallback(async () => {
    if (!form || !schema) return;
    const input = editInputOf(form, schema);
    if (!input.ok) { setError(input.messageAr); return; }
    setPreparing(true); setError(null); setNotice(null);
    const r = await prepareEditRequest({ missionId, version: schema.version, edit: input.input, fetchFn: browserFetch, headers: authHeaders });
    if (r.ok) { setWaiting(r.request); setQuote(null); }
    else {
      setError(r.message);
      // another tab may have made a request in the meantime: whatever waits is shown
      const found = await fetchEditRequest({ missionId, fetchFn: browserFetch, headers: authHeaders });
      if (found) { setWaiting(found); setQuote(null); setError(null); }
    }
    setPreparing(false);
  }, [form, schema, missionId]);
  const onCancel = useCallback(async () => {
    if (!waiting) return;
    setCancelling(true); setError(null);
    const r = await cancelEditRequest({ missionId, requestId: waiting.id, fetchFn: browserFetch, headers: authHeaders });
    if (r.ok) { setWaiting(null); setQuote(null); setForm(null); setNotice(EDIT_CANCELLED_AR); void start(() => true); }
    else { setError(r.message); setWaiting(await fetchEditRequest({ missionId, fetchFn: browserFetch, headers: authHeaders })); }
    setCancelling(false);
  }, [missionId, waiting, start]);
  const onRetry = useCallback(() => { setError(null); void start(() => true); }, [start]);
  // after the approval's answer the request is read again from the server: an approved one no longer waits (the status panel tells its state), an uncertain one is back to waiting
  const onApprovalSettled = useCallback((r: ApproveResult) => {
    // a refusal or an UNCERTAIN answer keeps the request and the button on screen (its alert is the only place the customer reads «the points may be held»); only a request that was approved leaves the waiting state, and its sentence stays as a notice
    if (r.state !== "approved" && r.state !== "already_approved") return;
    setWaiting(null); setQuote(null); setForm(null); setNotice(r.message);
    void fetchEditRequest({ missionId, fetchFn: fetch, headers: authHeaders }).then((found) => setWaiting(found));
  }, [missionId]);
  return <EditRequestBody schema={schema} status={status} form={form} onForm={onForm} onAsk={onAsk} busy={busy} quote={quote} error={error} waiting={waiting} onPrepare={onPrepare} preparing={preparing} onCancel={onCancel} cancelling={cancelling} notice={notice} onRetry={onRetry} approval={waiting ? <ApproveAddon missionId={missionId} requestId={waiting.id} points={waiting.holdPoints} onSettled={onApprovalSettled} /> : null} />;
}
