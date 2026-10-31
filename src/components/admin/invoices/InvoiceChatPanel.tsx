"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { adminFetch } from "@/lib/adminApi";
import { toArabicDigits } from "@/lib/arabicDigits";
import type { Action, CountKey } from "@/lib/invoices/chat/actions";
import { applyActions, draftSummary, needsConfirm, type ApplyCtx, type ApplyOutcome } from "@/lib/invoices/chat/apply";
import { AGENT_MAX_CHARS, AGENT_MAX_FILES, AGENT_REQUEST_BODY_SOFT_LIMIT } from "@/lib/invoices/chat/limits";
import { approxActions, importActions, type ImageRow } from "@/lib/invoices/chat/proposal";
import { ROLE_AR, type CountResult, type Role, type SheetMapping } from "@/lib/invoices/chat/types";
import { fmtInt } from "@/lib/invoices/format";
import type { DocForm } from "@/lib/invoices/form";
import type { ItemTypeLite } from "@/lib/invoices/sectors";
import { BTN, BTN_PRIMARY, INPUT, SECTION } from "./ui";

/**
 * «مساعد الفواتير»: a chat inside the builder. The owner types and attaches Excel / CSV files and pictures; the assistant answers with a PROPOSAL (counts made by code from his
 * files, the actions the model chose, before/after totals). Nothing changes until «تمام» for anything that touches money; everything lands in the manual builder as an editable
 * draft, and every applied step can be undone. Nothing is saved to the database from here, and there is no way to send an invoice from here.
 */
interface FileReport { name: string; kind: "sheet" | "image"; sheets: Array<{ sheet: string; rows: number }> }
interface AgentResponse {
  say: string; sayDropped: boolean; actions: Action[]; files: FileReport[]; mapping: SheetMapping[]; unmapped: Array<{ file: string; sheet: string }>;
  count: CountResult | null; imageCounts: Array<{ image: string; sector: string; itemType: CountKey; quantity: number }>;
  usage: { model: string; inputTokens: number; outputTokens: number; costUsd: number };
}
interface Proposal {
  id: string; status: "pending" | "applied" | "dismissed" | "superseded";
  say: string; count: CountResult | null; mapping: SheetMapping[]; unmapped: AgentResponse["unmapped"]; files: FileReport[];
  actions: Action[]; imageRows: ImageRow[]; lineIds: Map<string, string>; imageNames: string[];
}
interface Msg { id: string; role: "owner" | "assistant"; text: string; /** the model's own sentence (digit-free): the only assistant text that goes back to the model */ modelSay?: string; error?: boolean; applied?: string[]; undoId?: string; proposal?: Proposal; files?: string[] }

const COUNT_AR: Record<CountKey, string> = { company: "شركة", manager: "مدير", email: "إيميل", phone: "رقم هاتف" };
const EXAMPLES = ["اعمل فاتورة للشركة دي، الدولار النهارده ٥٦ جنيه", "خلي الإجمالي ١٧ دولار", "خلي الـ PDF صفحة واحدة"];
const ACCEPT = ".xlsx,.csv,.png,.jpg,.jpeg";
let seq = 0;
const nid = (p: string) => `${p}${Date.now().toString(36)}${(seq++).toString(36)}`;

/** A picture is shrunk in the browser first (at most 1600 px, JPEG): the model reads it just as well and it stays far under the upload limit. */
async function prepareImage(file: File): Promise<File> {
  if (!/\.(png|jpe?g)$/i.test(file.name)) return file;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    if (scale === 1 && file.size < 1_500_000) return file;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bmp.width * scale)); canvas.height = Math.max(1, Math.round(bmp.height * scale));
    const g = canvas.getContext("2d");
    if (!g) return file;
    g.fillStyle = "#fff"; g.fillRect(0, 0, canvas.width, canvas.height); g.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const blob: Blob | null = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.85));
    return blob ? new File([blob], file.name.replace(/\.(png|jpe?g)$/i, "") + ".jpg", { type: "image/jpeg" }) : file;
  } catch { return file; }
}

export interface ChatPanelProps {
  form: DocForm; types: ItemTypeLite[]; creditValueE4: number; canChangeDocType: boolean; disabled: boolean;
  open: boolean; onToggle: () => void;
  onApplyForm: (next: DocForm) => void;
  onFit: (pages: number) => void;
  phaseSummary: boolean;
  onPhaseSummary: (show: boolean) => void;
  fitReport: { token: number; text: string } | null;
}

export function InvoiceChatPanel(p: ChatPanelProps) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState("");
  const [attached, setAttached] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [undo, setUndo] = useState<Array<{ id: string; form: DocForm; phase: boolean }>>([]);
  const retained = useRef<File[]>([]);       // the files of a proposal that is still waiting for «تمام»: re-sent if the owner corrects the mapping
  const formRef = useRef(p.form);
  formRef.current = p.form;
  const logRef = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const ctx: ApplyCtx = useMemo(() => ({ types: p.types, creditValueE4: p.creditValueE4, canChangeDocType: p.canChangeDocType }), [p.types, p.creditValueE4, p.canChangeDocType]);

  // a new proposal is read from its TOP; anything else follows the end of the chat
  useEffect(() => {
    const log = logRef.current;
    if (!log) return;
    const last = log.querySelector<HTMLElement>('[data-last="true"]');
    if (last && msgs[msgs.length - 1]?.proposal) log.scrollTo({ top: Math.max(0, last.offsetTop - 6) });
    else log.scrollTo({ top: log.scrollHeight });
  }, [msgs.length, busy]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (p.fitReport) setMsgs((m) => [...m, { id: nid("m"), role: "assistant", text: p.fitReport?.text ?? "" }]); }, [p.fitReport?.token]); // eslint-disable-line react-hooks/exhaustive-deps

  const actionsOf = useCallback((pr: Proposal, form: DocForm): { actions: Action[]; skipped: string[] } => {
    const approx = approxActions(pr.imageRows, form, p.types);
    return { actions: [...(pr.count ? importActions(pr.count) : []), ...approx.actions, ...pr.actions], skipped: approx.skipped };
  }, [p.types]);
  const run = useCallback((pr: Proposal, form: DocForm): { o: ApplyOutcome; actions: Action[]; skipped: string[] } => {
    const { actions, skipped } = actionsOf(pr, form);
    return { o: applyActions(form, actions, ctx, pr.lineIds), actions, skipped };
  }, [actionsOf, ctx]);

  const commit = useCallback((pr: Proposal, label: string): void => {
    const cur = formRef.current;
    const { o } = run(pr, cur);
    const undoId = nid("u");
    setUndo((u) => [...u, { id: undoId, form: cur, phase: p.phaseSummary }]);
    p.onApplyForm(o.form);
    if (o.phaseSummary !== null) p.onPhaseSummary(o.phaseSummary);
    if (o.fitPages !== null) p.onFit(o.fitPages);
    if (pr.count || pr.imageRows.length) retained.current = [];
    setMsgs((m) => [...m.map((x) => (x.proposal?.id === pr.id ? { ...x, proposal: { ...x.proposal, status: "applied" as const } } : x)), { id: nid("m"), role: "assistant", text: label, applied: [...o.applied, ...o.warnings.map((w) => `تنبيه: ${w}`), ...o.refused.map((r) => `لم يُنفَّذ: ${r}`)], undoId }]);
  }, [p, run]);

  const send = async (override?: string) => {
    const message = (override ?? text).trim();
    if ((!message && attached.length === 0) || busy || p.disabled) return;
    const sending = [...attached, ...retained.current.filter((r) => !attached.some((a) => a.name === r.name))];
    if (sending.reduce((s, f) => s + f.size, 0) > AGENT_REQUEST_BODY_SOFT_LIMIT) {
      setMsgs((m) => [...m, { id: nid("m"), role: "assistant", error: true, text: "حجم الملفات أكبر من ٤ ميجابايت في المرة الواحدة. ارفع الملفات على دفعات أو صغّر الصور." }]);
      return;
    }
    const history = msgs.filter((m) => !m.error).map((m) => ({ role: m.role, text: m.role === "owner" ? m.text : m.modelSay ?? "" })).filter((m) => m.text);
    const mine: Msg = { id: nid("m"), role: "owner", text: message || "(ملفات)", files: attached.map((f) => f.name) };
    setMsgs((m) => [...m, mine]);
    setBusy(true);
    try {
      const fd = new FormData();
      const { summary, lineIds } = draftSummary(formRef.current, p.types);
      fd.set("message", message); fd.set("history", JSON.stringify(history)); fd.set("draft", JSON.stringify(summary));
      for (const f of sending) fd.append("files", f, f.name);
      const r = await adminFetch<AgentResponse>("/api/admin/invoices/agent", { method: "POST", body: fd });
      setText(""); setAttached([]);
      if (r.count) retained.current = sending.filter((f) => !/\.(png|jpe?g)$/i.test(f.name));
      const pr: Proposal = {
        id: nid("p"), status: "pending", say: r.say, count: r.count, mapping: r.mapping, unmapped: r.unmapped, files: r.files, actions: r.actions, lineIds,
        imageRows: r.imageCounts.map((c) => ({ sector: c.sector, itemType: c.itemType, quantity: String(c.quantity) })), imageNames: r.files.filter((f) => f.kind === "image").map((f) => f.name),
      };
      const preview = run(pr, formRef.current);
      const nothing = !pr.count && !pr.imageRows.length && pr.actions.length === 0;
      const mustConfirm = Boolean(pr.count) || pr.imageRows.length > 0 || needsConfirm(preview.actions, preview.o);
      const say = r.say || (r.sayDropped || nothing ? (nothing ? "ما فهمتش المطلوب بالظبط. قولها بكلمات تانية أو اكتب الأرقام بنفسك في الخانات." : "") : "");
      if (nothing || (!mustConfirm && !preview.o.changed && preview.o.refused.length === 0)) {
        setMsgs((m) => [...m, { id: nid("m"), role: "assistant", text: say || "تمام.", modelSay: r.say || undefined }]);
      } else if (!mustConfirm) {
        if (say) setMsgs((m) => [...m, { id: nid("m"), role: "assistant", text: say, modelSay: r.say || undefined }]);
        commit(pr, "تم، وده اللي اتغيّر في المسودة:");
      } else {
        setMsgs((m) => [...m.map((x) => (x.proposal?.status === "pending" ? { ...x, proposal: { ...x.proposal, status: "superseded" as const } } : x)), { id: nid("m"), role: "assistant", text: say || "راجع الاقتراح ده وقل تمام لو مظبوط:", modelSay: r.say || undefined, proposal: pr }]);
      }
    } catch (e) {
      setMsgs((m) => [...m, { id: nid("m"), role: "assistant", error: true, text: e instanceof Error ? e.message : "تعذّر الاتصال بالمساعد." }]);
    } finally { setBusy(false); }
  };

  const dismiss = (pr: Proposal) => { retained.current = []; setMsgs((m) => m.map((x) => (x.proposal?.id === pr.id ? { ...x, proposal: { ...x.proposal, status: "dismissed" as const } } : x))); };
  const doUndo = (undoId: string) => {
    const at = undo.findIndex((u) => u.id === undoId);
    if (at < 0 || at !== undo.length - 1) return;
    p.onApplyForm(undo[at].form);
    p.onPhaseSummary(undo[at].phase);
    setUndo((u) => u.slice(0, at));
    setMsgs((m) => [...m.map((x) => (x.undoId === undoId ? { ...x, undoId: undefined } : x)), { id: nid("m"), role: "assistant", text: "رجّعت المسودة زي ما كانت قبل الخطوة دي." }]);
  };

  const onFiles = async (list: FileList | null) => {
    if (!list) return;
    const picked: File[] = [];
    for (const f of Array.from(list)) picked.push(await prepareImage(f));
    setAttached((cur) => [...cur, ...picked].slice(0, AGENT_MAX_FILES));
    if (fileInput.current) fileInput.current.value = "";
  };

  const total = (o: ApplyOutcome["before"]) => (o.statement ? "بدون أسعار" : o.text.join("، ") || "٠");

  const renderProposal = (m: Msg, pr: Proposal) => {
    const pending = pr.status === "pending";
    const view = pending ? run(pr, p.form) : null;
    return (
      <div className="mt-2 flex min-w-0 flex-col gap-2.5 rounded-xl border border-ln bg-bg p-3 text-[13px] text-ink" data-testid="agent-card" data-status={pr.status}>
        {pr.count ? (
          <div className="flex min-w-0 flex-col gap-1.5" data-testid="agent-counts">
            <strong>الأعداد اللي حسبتها الأداة من ملفاتك (مش المساعد):</strong>
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
              {pr.count.sectors.map((s) => (
                <li key={s.sector} className="rounded-lg border border-ln bg-sf p-2" data-testid="agent-sector-count">
                  <b>{s.sector}</b>: {fmtInt(s.companies)} شركة، {fmtInt(s.managers)} مدير، {fmtInt(s.emails)} إيميل، {fmtInt(s.phones)} رقم هاتف
                  {s.invalidEmails || s.ignoredPhones ? <span className="block text-[11px] text-mut">لم تُحسب: {s.invalidEmails ? `${fmtInt(s.invalidEmails)} خانة إيميل غير صالحة` : ""}{s.invalidEmails && s.ignoredPhones ? "، " : ""}{s.ignoredPhones ? `${fmtInt(s.ignoredPhones)} قيمة هاتف غير صالحة` : ""}</span> : null}
                </li>
              ))}
            </ul>
            <details className="text-[12px] text-ink2">
              <summary className="min-h-[36px] cursor-pointer py-2">الأعمدة اللي استخدمتها (راجعها)</summary>
              <ul className="m-0 flex list-none flex-col gap-1.5 p-0 ps-1" data-testid="agent-mapping">
                {pr.count.sheets.map((s) => (
                  <li key={`${s.file}|${s.sheet}`}>
                    <b>{s.file}</b> / {s.sheet} ({fmtInt(s.dataRows)} صف، العناوين في الصف {fmtInt(s.headerRow)}){s.sector ? <> — القطاع: {s.sector}</> : <> — القطاع من عمود</>}
                    <br />
                    {(Object.entries(s.used) as Array<[Role, { col: string; header: string }]>).map(([role, u]) => `${ROLE_AR[role]}: عمود ${u.col}${u.header ? ` («${u.header}»)` : ""}`).join("، ")}
                  </li>
                ))}
              </ul>
            </details>
            {pr.unmapped.length ? <p className="m-0 text-[12px] text-mut">تجاهلت: {pr.unmapped.map((u) => `«${u.sheet}» في ${u.file}`).join("، ")} (مفيهاش أعمدة بيانات).</p> : null}
            <p className="m-0 text-[12px] text-mut">لو عمود غلط، اكتب مثلًا «عمود المدير هو D» وأعيد الحساب من نفس الملفات.</p>
          </div>
        ) : null}

        {pr.imageRows.length ? (
          <div className="flex min-w-0 flex-col gap-1.5" data-testid="agent-images">
            <strong>من الصورة <span className="rounded-md border border-bad px-1.5 py-0.5 text-[11px] text-bad" data-testid="agent-approx-badge">تقريبي</span></strong>
            <p className="m-0 text-[12px] text-mut">دي تقديرات المساعد من الصورة، مش حساب أداة. عدّلها أو امسحها قبل «تمام». لا تدخل في خانة فيها رقم من ملف أو كتبته أنت.</p>
            {pr.imageRows.map((r, i) => (
              <label key={`${r.sector}-${r.itemType}-${i}`} className="flex min-h-[44px] items-center gap-2">
                <span className="min-w-0 flex-1">{r.sector} — {COUNT_AR[r.itemType]}</span>
                <input className={`${INPUT} !min-h-[40px] !w-[96px]`} inputMode="numeric" dir="ltr" disabled={!pending} value={toArabicDigits(r.quantity)} aria-label={`عدد ${COUNT_AR[r.itemType]} في ${r.sector} (تقريبي)`} data-testid={`agent-image-qty-${i}`}
                  onChange={(e) => { const v = e.target.value; setMsgs((all) => all.map((x) => (x.proposal?.id === pr.id ? { ...x, proposal: { ...x.proposal, imageRows: x.proposal.imageRows.map((row, k) => (k === i ? { ...row, quantity: v } : row)) } } : x))); }} />
              </label>
            ))}
            {view?.skipped.length ? <ul className="m-0 list-none p-0 text-[12px] text-bad">{view.skipped.map((s) => <li key={s}>{s}</li>)}</ul> : null}
          </div>
        ) : null}

        {view ? (
          <div className="flex min-w-0 flex-col gap-1.5" data-testid="agent-changes">
            {view.o.applied.length ? <><strong>هعمل كده:</strong><ul className="m-0 list-disc ps-5">{view.o.applied.map((a, i) => <li key={i}>{a}</li>)}</ul></> : null}
            {view.o.applied.length === 0 && view.o.refused.length === 0 ? <p className="m-0 text-bad" data-testid="agent-nothing">مفيش خانة تنطبق عليها الأرقام دي، فلن يتغير شيء.</p> : null}
            {view.o.refused.length ? <ul className="m-0 list-disc ps-5 text-bad" role="alert">{view.o.refused.map((a, i) => <li key={i}>{a}</li>)}</ul> : null}
            {view.o.warnings.length ? <ul className="m-0 list-disc ps-5 text-bad">{view.o.warnings.map((a, i) => <li key={i}>{a}</li>)}</ul> : null}
            {!view.o.before.statement || !view.o.after.statement ? (
              <p className="m-0 rounded-lg border border-ln bg-sf p-2 leading-7" data-testid="agent-before-after">
                الإجمالي: قبل <b dir="ltr">{total(view.o.before)}</b> ← بعد <b dir="ltr">{total(view.o.after)}</b>
              </p>
            ) : null}
          </div>
        ) : null}

        {pending ? (
          <div className="flex flex-wrap gap-2">
            <button type="button" className={BTN_PRIMARY} disabled={Boolean(view && view.o.applied.length === 0)} onClick={() => commit(pr, "تم، وده اللي اتغيّر في المسودة:")} data-testid="agent-confirm">تمام</button>
            <button type="button" className={BTN} onClick={() => dismiss(pr)} data-testid="agent-cancel">لا، إلغاء</button>
          </div>
        ) : <p className="m-0 text-[12px] text-mut" data-testid="agent-status">{pr.status === "applied" ? "اتنفّذ." : pr.status === "dismissed" ? "اتلغى." : "حلّ محله اقتراح أحدث."}</p>}
        <span hidden data-msg={m.id} />
      </div>
    );
  };

  return (
    <section className={SECTION} data-testid="agent-panel" aria-label="مساعد الفواتير">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <h3 className="m-0 text-sm font-semibold text-ink">مساعد الفواتير</h3>
        <button type="button" className={BTN} aria-expanded={p.open} onClick={p.onToggle} data-testid="agent-toggle">{p.open ? "إخفاء" : "فتح المساعد"}</button>
      </div>
      {!p.open ? <p className="m-0 text-[12px] leading-6 text-mut">اكتب له أو ارفع ملفات إكسل وصور، وهو يرتّب المسودة. الأرقام تحسبها الأداة، وأنت توافق قبل أي تغيير في المبلغ.</p> : (
        <>
          <div ref={logRef} role="log" aria-live="polite" className="relative flex max-h-[52vh] min-h-[120px] min-w-0 flex-col gap-2 overflow-y-auto rounded-xl border border-ln bg-bg p-2.5" data-testid="agent-log">
            {msgs.length === 0 ? (
              <div className="flex flex-col gap-2 text-[13px] leading-7 text-ink2">
                <p className="m-0">أرفق ملفات إكسل (أو صور) واكتب طلبك بكلامك. مثال:</p>
                {EXAMPLES.map((ex, i) => <button key={ex} type="button" className={`${BTN} !h-auto !justify-start !py-2 text-start`} onClick={() => setText(ex)} data-testid={`agent-example-${i}`}>{ex}</button>)}
              </div>
            ) : null}
            {msgs.map((m) => (
              <div key={m.id} className={`flex min-w-0 flex-col ${m.role === "owner" ? "items-start" : "items-stretch"}`} data-testid="agent-msg" data-role={m.role} data-last={m === msgs[msgs.length - 1] ? "true" : undefined}>
                <div className={`min-w-0 max-w-full whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-[13px] leading-7 ${m.role === "owner" ? "bg-ink text-sf" : m.error ? "border border-bad bg-sf text-bad" : "border border-ln bg-sf text-ink"}`} role={m.error ? "alert" : undefined}>
                  {m.text}
                  {m.files?.length ? <span className="mt-1 block text-[11px] opacity-80">{m.files.join("، ")}</span> : null}
                </div>
                {m.applied?.length ? (
                  <ul className="m-0 mt-1 list-disc ps-5 text-[13px] leading-7 text-ink" data-testid="agent-applied">{m.applied.map((a, i) => <li key={i} className={a.startsWith("لم يُنفَّذ") || a.startsWith("تنبيه") ? "text-bad" : ""}>{a}</li>)}</ul>
                ) : null}
                {m.undoId && undo.length && undo[undo.length - 1].id === m.undoId ? <div className="mt-1"><button type="button" className={BTN} onClick={() => doUndo(m.undoId as string)} data-testid="agent-undo">تراجع</button></div> : null}
                {m.proposal ? renderProposal(m, m.proposal) : null}
              </div>
            ))}
            {busy ? <p className="m-0 text-[13px] text-mut" role="status" data-testid="agent-busy">المساعد بيقرا ويرتّب…</p> : null}
          </div>

          {p.disabled ? <p className="m-0 text-[12px] text-mut">الوثيقة مقفلة؛ المساعد يعمل على المسودات فقط.</p> : (
            <div className="flex min-w-0 flex-col gap-2">
              {attached.length ? (
                <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0" data-testid="agent-files">
                  {attached.map((f, i) => (
                    <li key={`${f.name}-${i}`} className="flex min-h-[36px] items-center gap-1 rounded-lg border border-ln bg-bg ps-2 text-[12px] text-ink" data-testid="agent-file-chip">
                      <span className="max-w-[170px] truncate">{f.name}</span>
                      <button type="button" className="min-h-[36px] min-w-[36px] text-mut" aria-label={`إزالة ${f.name}`} onClick={() => setAttached((cur) => cur.filter((_, k) => k !== i))}>×</button>
                    </li>
                  ))}
                </ul>
              ) : null}
              <textarea className={`${INPUT} min-h-[72px] py-2`} value={text} maxLength={AGENT_MAX_CHARS} onChange={(e) => setText(e.target.value)} placeholder="اكتب طلبك… (مثال: خلي الإجمالي ١٧ دولار)" aria-label="رسالة للمساعد" data-testid="agent-input"
                onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void send(); } }} />
              <div className="flex flex-wrap items-center gap-2">
                <input ref={fileInput} type="file" multiple accept={ACCEPT} className="sr-only" id="agent-file-input" onChange={(e) => void onFiles(e.target.files)} data-testid="agent-file-input" />
                <label htmlFor="agent-file-input" className={`${BTN} inline-flex cursor-pointer items-center`} data-testid="agent-attach">إرفاق ملفات</label>
                <button type="button" className={BTN_PRIMARY} disabled={busy || (!text.trim() && attached.length === 0)} onClick={() => void send()} data-testid="agent-send">{busy ? "…" : "اطلب"}</button>
                <span className="text-[11px] text-mut">إكسل وCSV وصور، حتى ٥ ملفات. الملفات لا تُحفظ.</span>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}
