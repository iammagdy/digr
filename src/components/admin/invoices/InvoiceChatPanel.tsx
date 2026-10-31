"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { adminFetch } from "@/lib/adminApi";
import { toArabicDigits } from "@/lib/arabicDigits";
import type { Action, CountKey } from "@/lib/invoices/chat/actions";
import { applyActions, draftSummary, needsConfirm, type ApplyCtx, type ApplyOutcome } from "@/lib/invoices/chat/apply";
import {
  answerChip, answerText, buildFlowActions, effective, moveContact, newFlow, nextQuestion, prefillFromActions, summaryText, type FlowCtx, type FlowState, type Question, type QuestionId,
} from "@/lib/invoices/chat/flow";
import { AGENT_MAX_CHARS, AGENT_MAX_FILES, AGENT_REQUEST_BODY_SOFT_LIMIT } from "@/lib/invoices/chat/limits";
import { approxActions, type ImageRow } from "@/lib/invoices/chat/proposal";
import { ROLE_AR, type CountResult, type Role, type SheetMapping, type UnmappedSheet } from "@/lib/invoices/chat/types";
import { fmtInt } from "@/lib/invoices/format";
import type { DocForm } from "@/lib/invoices/form";
import { parseScaled } from "@/lib/invoices/money";
import { quickFields, type ItemTypeLite } from "@/lib/invoices/sectors";
import { unitUsdText } from "@/lib/invoices/priceInput";
import { BTN, BTN_PRIMARY } from "./ui";

/**
 * «مساعد الفواتير»: a chat inside the builder, dressed like Diger's customer chat (plain assistant text, soft user bubbles, pill answer chips, pill file chips, three moving dots,
 * a pill composer). The owner types and attaches Excel / CSV files and pictures. After his files are counted (by code) the assistant says what it found in one short sentence and
 * asks, ONE question at a time with tappable answers, what to bill, how to price, the dollar rate and the client; then it shows the draft it would build with the total before and
 * after, and waits for «تمام». Nothing changes before that for anything that touches money; everything lands in the manual builder as an editable draft; every applied step can be
 * undone. Nothing is saved to the database from here, and there is no way to send an invoice from here.
 */
interface FileReport { name: string; kind: "sheet" | "image"; sheets: Array<{ sheet: string; rows: number }> }
interface AgentResponse {
  say: string; sayDropped: boolean; actions: Action[]; files: FileReport[]; mapping: SheetMapping[]; unmapped: UnmappedSheet[]; inferred: Array<{ file: string; sheet: string }>;
  count: CountResult | null; imageCounts: Array<{ image: string; sector: string; itemType: CountKey; quantity: number }>;
  usage: { model: string; inputTokens: number; outputTokens: number; costUsd: number };
}
interface Proposal {
  id: string; status: "pending" | "applied" | "dismissed" | "superseded";
  actions: Action[]; imageRows: ImageRow[]; lineIds: Map<string, string>;
}
type QId = QuestionId | "sheets";
interface Ask { q: Question | { id: "sheets"; text: string; chips: Array<{ label: string; value: string }> }; answered: string | null; error?: string }
/** the files counted and waiting for the conversation: the analysis, where the owner is in the questions, and the model's own actions from his first message */
interface Active { id: string; res: AgentResponse; flow: FlowState; rest: Action[]; lineIds: Map<string, string> }
interface Msg {
  id: string; role: "owner" | "assistant"; text: string;
  /** the model's own sentence (digit-free): the only assistant text that goes back to the model */
  modelSay?: string; local?: boolean; error?: boolean; applied?: string[]; undoId?: string; proposal?: Proposal; files?: string[]; ask?: Ask; summaryOf?: string;
}

const COUNT_AR: Record<CountKey, string> = { company: "شركة", manager: "مدير", email: "إيميل", phone: "رقم هاتف", department: "جهة إدارية" };
const EXAMPLES = ["اعمل فاتورة للشركة دي، الدولار النهارده ٥٦ جنيه", "خلي الإجمالي ١٧ دولار", "خلي الـ PDF صفحة واحدة"];
const ACCEPT = ".xlsx,.csv,.png,.jpg,.jpeg";
const CHIP = "min-h-11 cursor-pointer rounded-full border border-ln2 bg-sf px-4 py-2 text-xs font-semibold text-ink transition-colors hover:bg-sf2 disabled:cursor-default disabled:opacity-50";
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

/** «كهروميكانيكا 1.xlsx» -> the stem alone reads naturally in Arabic; a name that mixes Arabic, a number and «.xlsx» does not (the bidi algorithm reorders it), so the extension is shown apart */
const stemOf = (name: string): string => name.replace(/\.[A-Za-z0-9]{2,5}$/, "");
const extOf = (name: string): string => (/\.([A-Za-z0-9]{2,5})$/.exec(name)?.[1] ?? "").toLowerCase();
const Ext = ({ name }: { name: string }) => (extOf(name) ? <span dir="ltr" className="shrink-0 rounded-md bg-ac/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-ac">{extOf(name)}</span> : null);

const Paperclip = () => (<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" /></svg>);
const ArrowUp = () => (<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 19V5M5.5 11.5L12 5l6.5 6.5" /></svg>);

/** the same three moving dots as the customer chat's «جاري العمل على طلبك» */
function Typing({ label }: { label: string }) {
  return (
    <div role="status" aria-live="polite" data-testid="agent-busy" className="mt-3 flex items-center gap-2 text-xs font-medium text-ink2" style={{ animation: "up .3s both" }}>
      <span aria-hidden="true" className="flex shrink-0 items-center gap-1">{[0, 1, 2].map((i) => <span key={i} className="run-dot h-1.5 w-1.5 rounded-full bg-ac" style={{ animationDelay: `${i * 0.18}s` }} />)}</span>
      <span>{label}</span>
    </div>
  );
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
  const [active, setActive] = useState<Active | null>(null);
  const [undo, setUndo] = useState<Array<{ id: string; form: DocForm; phase: boolean }>>([]);
  const [typedAnswer, setTypedAnswer] = useState("");
  const retained = useRef<File[]>([]);       // the files being counted: kept until the draft is built or the owner cancels, so a correction can re-read them
  const formRef = useRef(p.form);
  formRef.current = p.form;
  const logRef = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const ctx: ApplyCtx = useMemo(() => ({ types: p.types, creditValueE4: p.creditValueE4, canChangeDocType: p.canChangeDocType }), [p.types, p.creditValueE4, p.canChangeDocType]);

  // a new question or proposal is read from its TOP; anything else follows the end of the chat
  useEffect(() => {
    const log = logRef.current;
    if (!log) return;
    const last = log.querySelector<HTMLElement>('[data-last="true"]');
    const tail = msgs[msgs.length - 1];
    if (last && (tail?.proposal || tail?.ask || tail?.summaryOf)) log.scrollTo({ top: Math.max(0, last.offsetTop - 6) });
    else log.scrollTo({ top: log.scrollHeight });
  }, [msgs.length, busy]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (p.fitReport) setMsgs((m) => [...m, { id: nid("m"), role: "assistant", text: p.fitReport?.text ?? "" }]); }, [p.fitReport?.token]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = useCallback((pr: Proposal, form: DocForm): { o: ApplyOutcome; actions: Action[]; skipped: string[] } => {
    const approx = approxActions(pr.imageRows, form, p.types);
    const actions = [...approx.actions, ...pr.actions];
    return { o: applyActions(form, actions, ctx, pr.lineIds), actions, skipped: approx.skipped };
  }, [p.types, ctx]);

  const flowCtx = useCallback((a: Active): FlowCtx => {
    const f = formRef.current;
    const manager = quickFields(p.types).find((q) => q.name === "مدير")?.type;
    return {
      sectors: a.res.count?.sectors ?? [], docType: f.docType, rateE4: f.rate.trim() === "" ? null : parseScaled(f.rate, 4),
      showUsd: f.showUsd, showPoints: f.showPoints, showEgp: f.showEgp, clientName: f.company.trim(), managerUnitUsdText: manager ? unitUsdText(manager.unitCc) : null,
    };
  }, [p.types]);

  const commit = useCallback((pr: Proposal, label: string): void => {
    const cur = formRef.current;
    const { o } = run(pr, cur);
    const undoId = nid("u");
    setUndo((u) => [...u, { id: undoId, form: cur, phase: p.phaseSummary }]);
    p.onApplyForm(o.form);
    if (o.phaseSummary !== null) p.onPhaseSummary(o.phaseSummary);
    if (o.fitPages !== null) p.onFit(o.fitPages);
    if (pr.imageRows.length || active) { retained.current = []; }
    setActive(null);
    setMsgs((m) => [...m.map((x) => (x.proposal?.id === pr.id ? { ...x, proposal: { ...x.proposal, status: "applied" as const } } : x)), { id: nid("m"), role: "assistant", text: label, applied: [...o.applied, ...o.warnings.map((w) => `تنبيه: ${w}`), ...o.refused.map((r) => `لم يُنفَّذ: ${r}`)], undoId }]);
  }, [p, run, active]);

  /** the next thing to ask, or the draft to show once everything is known */
  const advance = useCallback((a: Active) => {
    const q = nextQuestion(a.flow, flowCtx(a));
    if (q) { setMsgs((m) => [...m, { id: nid("m"), role: "assistant", text: q.text, ask: { q, answered: null } }]); return; }
    const built = buildFlowActions(a.flow, flowCtx(a));
    const pr: Proposal = { id: nid("p"), status: "pending", actions: [...built, ...a.rest], imageRows: [], lineIds: a.lineIds };
    setMsgs((m) => [...m.map((x) => (x.proposal?.status === "pending" ? { ...x, proposal: { ...x.proposal, status: "superseded" as const } } : x)), { id: nid("m"), role: "assistant", text: "تمام. ده اللي هبنيه في المسودة، راجعه وقل تمام:", proposal: pr }]);
  }, [flowCtx]);

  const send = async (override?: string) => {
    const message = (override ?? text).trim();
    if ((!message && attached.length === 0) || busy || p.disabled) return;
    const sending = [...attached, ...retained.current.filter((r) => !attached.some((a) => a.name === r.name))];
    if (sending.reduce((s, f) => s + f.size, 0) > AGENT_REQUEST_BODY_SOFT_LIMIT) {
      setMsgs((m) => [...m, { id: nid("m"), role: "assistant", error: true, text: "حجم الملفات أكبر من ٤ ميجابايت في المرة الواحدة. ارفع الملفات على دفعات أو صغّر الصور." }]);
      return;
    }
    const history = msgs.filter((m) => !m.error && !m.local && !m.ask).map((m) => ({ role: m.role, text: m.role === "owner" ? m.text : m.modelSay ?? "" })).filter((m) => m.text);
    setMsgs((m) => [...m, { id: nid("m"), role: "owner", text: message || "(ملفات)", files: attached.map((f) => f.name) }]);
    setBusy(true);
    try {
      const fd = new FormData();
      const { summary, lineIds } = draftSummary(formRef.current, p.types);
      fd.set("message", message); fd.set("history", JSON.stringify(history)); fd.set("draft", JSON.stringify(summary));
      for (const f of sending) fd.append("files", f, f.name);
      const r = await adminFetch<AgentResponse>("/api/admin/invoices/agent", { method: "POST", body: fd });
      setText(""); setAttached([]);
      if (r.count) {
        // FILES COUNTED: a short summary, then the questions (the model is not called again until the owner types something new)
        retained.current = sending.filter((f) => !/\.(png|jpe?g)$/i.test(f.name));
        const pre = prefillFromActions(newFlow(), r.actions);
        const a: Active = { id: nid("a"), res: r, flow: pre.state, rest: pre.rest, lineIds };
        setActive(a);
        setMsgs((m) => [...m.map((x) => (x.proposal?.status === "pending" ? { ...x, proposal: { ...x.proposal, status: "superseded" as const } } : x)), { id: nid("m"), role: "assistant", text: "", summaryOf: a.id, modelSay: r.say || undefined }]);
        const asks = r.unmapped.filter((u) => u.status === "ask");
        if (asks.length) {
          setMsgs((m) => [...m, { id: nid("m"), role: "assistant", text: `${asks.length === 1 ? "الورقة دي" : "الأوراق دي"} ما اتحسبتش: ${asks.map((u) => `«${u.sheet}» (${fmtInt(u.rows)} صف)`).join("، ")}. أحسبها؟`, ask: { q: { id: "sheets", text: "", chips: [{ label: "احسبها", value: "map" }, { label: "سيبها", value: "skip" }] }, answered: null } }]);
        } else advance(a);
        return;
      }
      const pr: Proposal = { id: nid("p"), status: "pending", actions: r.actions, lineIds, imageRows: r.imageCounts.map((c) => ({ sector: c.sector, itemType: c.itemType, quantity: String(c.quantity) })) };
      const preview = run(pr, formRef.current);
      const nothing = pr.imageRows.length === 0 && pr.actions.length === 0;
      const mustConfirm = pr.imageRows.length > 0 || needsConfirm(preview.actions, preview.o);
      const say = r.say || (nothing ? "ما فهمتش المطلوب بالظبط. قولها بكلمات تانية أو اكتب الأرقام بنفسك في الخانات." : "");
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

  /** the owner answered a question: with a chip (value) or by typing (the question's own box) */
  const answer = (msgId: string, id: QId, kind: "chip" | "text", value: string, label: string) => {
    if (!active) return;
    if (id === "sheets") {
      setMsgs((m) => [...m.map((x) => (x.id === msgId && x.ask ? { ...x, ask: { ...x.ask, answered: label } } : x)), { id: nid("m"), role: "owner", text: label, local: true }]);
      if (value === "map") {
        const names = (active.res.unmapped ?? []).filter((u) => u.status === "ask").map((u) => `«${u.sheet}»`).join("، ");
        void send(`حدد أعمدة الأوراق دي من نفس الملفات: ${names}`);
      } else advance(active);
      return;
    }
    let next: FlowState;
    if (kind === "chip") next = answerChip(active.flow, id, value);
    else {
      const r = answerText(active.flow, id, value);
      if (!r.ok) { setMsgs((m) => m.map((x) => (x.id === msgId && x.ask ? { ...x, ask: { ...x.ask, error: r.error } } : x))); setTimeout(() => logRef.current?.scrollTo({ top: logRef.current.scrollHeight }), 50); return; }
      next = r.state;
    }
    setTypedAnswer("");
    const a2: Active = { ...active, flow: next };
    setActive(a2);
    setMsgs((m) => [...m.map((x) => (x.id === msgId && x.ask ? { ...x, ask: { ...x.ask, answered: label, error: undefined } } : x)), { id: nid("m"), role: "owner", text: label, local: true }]);
    advance(a2);
  };

  const move = (contactId: string) => { if (active) setActive({ ...active, flow: moveContact(active.flow, contactId) }); };

  const dismiss = (pr: Proposal) => { retained.current = []; setActive(null); setMsgs((m) => m.map((x) => (x.proposal?.id === pr.id ? { ...x, proposal: { ...x.proposal, status: "dismissed" as const } } : x))); };
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
  const lastId = msgs[msgs.length - 1]?.id;

  // ---------------------------------------------------------------- pieces

  const renderSummary = (m: Msg) => {
    const a = active && active.id === m.summaryOf ? active : null;
    const res = a?.res;
    if (!res?.count) return <p className="mb-0 mt-3 text-[15px] font-light leading-[2] text-ink" data-testid="agent-summary">تم حساب الملفات.</p>;
    const moved = a?.flow.moved ?? [];
    const sentence = summaryText({ sectors: res.count.sectors }, moved, res.count.duplicateCompanies);
    const contacts = res.count.sectors.flatMap((s) => s.contacts.map((c) => ({ ...c, sector: s.sector })));
    const movedSet = new Set(moved);
    const kindOf = (c: { id: string; kind: "person" | "department" }) => (movedSet.has(c.id) ? (c.kind === "person" ? "department" : "person") : c.kind);
    const departments = contacts.filter((c) => kindOf(c) === "department");
    const people = contacts.filter((c) => kindOf(c) === "person");
    return (
      <div className="mt-3 flex min-w-0 flex-col gap-2" data-testid="agent-summary">
        <p className="m-0 whitespace-pre-wrap break-words text-[15px] font-light leading-[2] text-ink" data-testid="agent-summary-text">{sentence}</p>
        <details className="rounded-[18px] bg-sf2 px-4 py-1 text-[13px] text-ink2" data-testid="agent-details">
          <summary className="min-h-11 cursor-pointer py-3 font-semibold text-ink">التفاصيل</summary>
          <div className="flex min-w-0 flex-col gap-3 pb-3">
            <ul className="m-0 flex list-none flex-col gap-1.5 p-0" data-testid="agent-sector-counts">
              {res.count.sectors.map((s) => {
                const e = effective(s, moved);
                return (
                  <li key={s.sector} data-testid="agent-sector-count">
                    <b className="text-ink">{s.sector}</b>: {fmtInt(e.companies)} شركة، {fmtInt(e.managers)} مدير، {fmtInt(e.departments)} جهة إدارية
                    <span className="block text-[12px] text-mut">إيميلات {fmtInt(s.emails)} وأرقام {fmtInt(s.phones)} (مش بتتحاسب لوحدها){s.invalidEmails || s.ignoredPhones ? `، ولم تُحسب ${fmtInt(s.invalidEmails)} إيميل و${fmtInt(s.ignoredPhones)} رقم غير صالح` : ""}</span>
                  </li>
                );
              })}
            </ul>
            {res.count.duplicateCompanies > 0 ? <p className="m-0 text-[12px]" data-testid="agent-duplicates">تم تجاهل {fmtInt(res.count.duplicateCompanies)} تكرار للشركات (نفس الشركة في أكتر من ورقة أو ملف){res.count.sectors.some((s) => s.duplicateContacts > 0) ? `، و${fmtInt(res.count.sectors.reduce((n, s) => n + s.duplicateContacts, 0))} تكرار لمديرين` : ""}.</p> : null}
            <div>
              <strong className="text-ink">الأوراق اللي اتقرت ({fmtInt(res.count.sheets.length)}):</strong>
              <ul className="m-0 mt-1 flex list-none flex-col gap-1 p-0 text-[12px]" data-testid="agent-mapping">
                {res.count.sheets.map((s) => (
                  <li key={`${s.file}|${s.sheet}`}>
                    <b>{stemOf(s.file)}</b> / <bdi>{s.sheet}</bdi>: {fmtInt(s.companyRows)} صف شركة، العناوين في الصف {fmtInt(s.headerRow)}
                    {s.role === "overall" ? " (القائمة الكاملة)" : s.role === "detail" ? " (تفاصيل لنفس الشركات)" : ""}{s.inferred ? " (أعمدتها من ورقة مشابهة)" : ""}
                  </li>
                ))}
              </ul>
              <strong className="mt-2 block text-ink">الأعمدة المستخدمة:</strong>
              <ul className="m-0 mt-1 flex list-none flex-col gap-1 p-0 text-[12px]" data-testid="agent-columns">
                {[...res.count.sheets.reduce((acc, s) => { const t = (Object.entries(s.used) as Array<[Role, { col: string; header: string }]>).map(([role, u]) => `${ROLE_AR[role]}: عمود ${u.col}${u.header ? ` («${u.header}»)` : ""}`).join("، "); acc.set(t, (acc.get(t) ?? 0) + 1); return acc; }, new Map<string, number>())].map(([t, n]) => <li key={t}>{t}{n > 1 ? ` (في ${fmtInt(n)} أوراق)` : ""}</li>)}
              </ul>
              {res.unmapped.length ? <p className="m-0 mt-1 text-[12px]">{res.unmapped.map((u) => `«${u.sheet}» (${fmtInt(u.rows)} صف): ${u.status === "ask" ? "محتاجة قرارك" : "صغيرة جدًا فاتجاهلتها"}`).join("، ")}.</p> : null}
            </div>
            {departments.length ? (
              <div data-testid="agent-departments">
                <strong className="text-ink">الجهات الإدارية ({fmtInt(departments.length)}):</strong>
                <ul className="m-0 mt-1 flex max-h-56 list-none flex-col gap-1 overflow-y-auto p-0">
                  {departments.map((c) => (
                    <li key={c.id} className="flex min-h-11 items-center justify-between gap-2 text-[12px]"><span className="min-w-0 flex-1 break-words">{c.name} <span className="text-mut">({c.company})</span></span>
                      <button type="button" className={CHIP} onClick={() => move(c.id)} disabled={!a} data-testid="agent-move-to-person">ده شخص</button></li>
                  ))}
                </ul>
              </div>
            ) : null}
            {people.length ? <PeopleList people={people} onMove={move} disabled={!a} /> : null}
          </div>
        </details>
      </div>
    );
  };

  const renderAsk = (m: Msg, ask: Ask) => {
    const isLast = m.id === lastId && ask.answered === null;
    const q = ask.q;
    const input = "input" in q ? q.input : undefined;
    return (
      <div className="mt-2 flex min-w-0 flex-col gap-2" data-testid="agent-question" data-qid={q.id}>
        <div className="flex flex-wrap gap-2">
          {q.chips.map((c) => <button key={c.value} type="button" className={CHIP} disabled={!isLast} onClick={() => answer(m.id, q.id, "chip", c.value, c.label)} data-testid={`agent-chip-${c.value}`}>{c.label}</button>)}
        </div>
        {isLast && input ? (
          <form className="flex w-full items-center gap-1.5 rounded-full border border-ln bg-sf p-1.5" onSubmit={(e) => { e.preventDefault(); if (typedAnswer.trim()) answer(m.id, q.id, "text", typedAnswer, typedAnswer.trim()); }}>
            <input className="min-h-[44px] min-w-0 flex-1 border-0 bg-transparent px-3.5 text-base font-light text-ink outline-none" inputMode={input.kind === "text" ? "text" : "decimal"} value={typedAnswer} onChange={(e) => setTypedAnswer(e.target.value)} placeholder={input.placeholder} aria-label={q.text} data-testid="agent-answer-input" />
            <button type="submit" className="flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-ac text-onac disabled:opacity-60" disabled={!typedAnswer.trim()} aria-label="تأكيد الإجابة" data-testid="agent-answer-send"><ArrowUp /></button>
          </form>
        ) : null}
        {ask.error ? <p role="alert" className="m-0 text-[13px] text-bad" data-testid="agent-answer-error">{ask.error}</p> : null}
      </div>
    );
  };

  const renderProposal = (m: Msg, pr: Proposal) => {
    const pending = pr.status === "pending";
    const view = pending ? run(pr, p.form) : null;
    return (
      <div className="mt-2 flex min-w-0 flex-col gap-2.5 rounded-[18px] bg-sf2 p-3.5 text-[13px] text-ink" data-testid="agent-card" data-status={pr.status}>
        {pr.imageRows.length ? (
          <div className="flex min-w-0 flex-col gap-1.5" data-testid="agent-images">
            <strong>من الصورة <span className="rounded-full border border-bad px-2 py-0.5 text-[11px] text-bad" data-testid="agent-approx-badge">تقريبي</span></strong>
            <p className="m-0 text-[12px] text-mut">دي تقديرات المساعد من الصورة، مش حساب أداة. عدّلها أو امسحها قبل «تمام». لا تدخل في خانة فيها رقم من ملف أو كتبته أنت.</p>
            {pr.imageRows.map((r, i) => (
              <label key={`${r.sector}-${r.itemType}-${i}`} className="flex min-h-[44px] items-center gap-2">
                <span className="min-w-0 flex-1">{r.sector} — {COUNT_AR[r.itemType]}</span>
                <input className="min-h-[40px] w-[96px] rounded-xl border border-ln bg-sf px-3 text-base text-ink outline-none" inputMode="numeric" dir="ltr" disabled={!pending} value={toArabicDigits(r.quantity)} aria-label={`عدد ${COUNT_AR[r.itemType]} في ${r.sector} (تقريبي)`} data-testid={`agent-image-qty-${i}`}
                  onChange={(e) => { const v = e.target.value; setMsgs((all) => all.map((x) => (x.proposal?.id === pr.id ? { ...x, proposal: { ...x.proposal, imageRows: x.proposal.imageRows.map((row, k) => (k === i ? { ...row, quantity: v } : row)) } } : x))); }} />
              </label>
            ))}
            {view?.skipped.length ? <ul className="m-0 list-none p-0 text-[12px] text-bad">{view.skipped.map((s) => <li key={s}>{s}</li>)}</ul> : null}
          </div>
        ) : null}

        {view ? (
          <div className="flex min-w-0 flex-col gap-1.5" data-testid="agent-changes">
            {view.o.applied.length ? <><strong>هعمل كده:</strong><ul className="m-0 list-disc ps-5 leading-[1.9]">{view.o.applied.map((a, i) => <li key={i}>{a}</li>)}</ul></> : null}
            {view.o.applied.length === 0 && view.o.refused.length === 0 ? <p className="m-0 text-bad" data-testid="agent-nothing">مفيش خانة تنطبق عليها الأرقام دي، فلن يتغير شيء.</p> : null}
            {view.o.refused.length ? <ul className="m-0 list-disc ps-5 text-bad" role="alert">{view.o.refused.map((a, i) => <li key={i}>{a}</li>)}</ul> : null}
            {view.o.warnings.length ? <ul className="m-0 list-disc ps-5 text-bad">{view.o.warnings.map((a, i) => <li key={i}>{a}</li>)}</ul> : null}
            {!view.o.before.statement || !view.o.after.statement ? (
              <p className="m-0 rounded-xl bg-sf p-2.5 leading-7" data-testid="agent-before-after">
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
    <section className="flex min-w-0 flex-col gap-3 rounded-[20px] border border-ln bg-sf p-3 sm:p-4" data-testid="agent-panel" aria-label="مساعد الفواتير">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <h3 className="m-0 text-sm font-semibold text-ink">مساعد الفواتير</h3>
        <button type="button" className={`${CHIP} !min-h-[40px]`} aria-expanded={p.open} onClick={p.onToggle} data-testid="agent-toggle">{p.open ? "إخفاء" : "فتح المساعد"}</button>
      </div>
      {!p.open ? <p className="m-0 text-[12px] font-light leading-6 text-mut">اكتب له أو ارفع ملفات إكسل وصور، وهو يرتّب المسودة. الأرقام تحسبها الأداة، وأنت توافق قبل أي تغيير في المبلغ.</p> : (
        <div className="flex h-[calc(100dvh-150px)] min-h-[460px] min-w-0 flex-col gap-2 lg:h-[min(720px,calc(100dvh-160px))]" data-testid="agent-body">
          <div ref={logRef} role="log" aria-live="polite" className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto overflow-x-hidden px-0.5 pb-2" data-testid="agent-log">
            {msgs.length === 0 ? (
              <div className="mt-2 flex flex-col gap-3 text-[15px] font-light leading-[2] text-ink" style={{ animation: "up .3s both" }}>
                <p className="m-0">أرفق ملفات إكسل أو صور، واكتب طلبك بكلامك. مثلًا:</p>
                <div className="flex flex-wrap gap-2">{EXAMPLES.map((ex, i) => <button key={ex} type="button" className={`${CHIP} !text-start`} onClick={() => setText(ex)} data-testid={`agent-example-${i}`}>{ex}</button>)}</div>
              </div>
            ) : null}
            {msgs.map((m) => (
              <div key={m.id} className={`flex min-w-0 flex-col ${m.role === "owner" ? "items-start" : "items-stretch"}`} data-testid="agent-msg" data-role={m.role} data-last={m.id === lastId ? "true" : undefined} style={{ animation: "up .3s both" }}>
                {m.role === "owner" ? (
                  <div className="mt-3 flex w-fit max-w-full flex-col gap-1.5">
                    <p className="m-0 w-fit max-w-full whitespace-pre-wrap break-words rounded-[18px] bg-sf2 px-4 py-2.5 text-sm font-light leading-[1.8] text-ink">{m.text}</p>
                    {m.files?.length ? m.files.map((f) => <span key={f} className="flex w-fit max-w-full items-center gap-2 rounded-full border border-ac/25 bg-ac/5 px-3 py-1 text-xs font-light text-ink"><span className="text-ac"><Paperclip /></span><span className="truncate font-medium">{stemOf(f)}</span><Ext name={f} /></span>) : null}
                  </div>
                ) : m.summaryOf ? renderSummary(m) : m.text ? (
                  <p className={`m-0 mt-3 whitespace-pre-wrap break-words text-[15px] font-light leading-[2] ${m.error ? "rounded-[18px] p-3 text-bad" : "text-ink"}`} style={m.error ? { background: "color-mix(in oklab, var(--bad) 8%, var(--sf))" } : undefined} role={m.error ? "alert" : undefined}>{m.text}</p>
                ) : null}
                {m.applied?.length ? <ul className="m-0 mt-1 list-disc ps-5 text-[14px] font-light leading-[1.9] text-ink" data-testid="agent-applied">{m.applied.map((a, i) => <li key={i} className={a.startsWith("لم يُنفَّذ") || a.startsWith("تنبيه") ? "text-bad" : ""}>{a}</li>)}</ul> : null}
                {m.undoId && undo.length && undo[undo.length - 1].id === m.undoId ? <div className="mt-2"><button type="button" className={CHIP} onClick={() => doUndo(m.undoId as string)} data-testid="agent-undo">تراجع</button></div> : null}
                {m.ask ? renderAsk(m, m.ask) : null}
                {m.proposal ? renderProposal(m, m.proposal) : null}
              </div>
            ))}
            {busy ? <Typing label={attached.length || retained.current.length ? "بيقرا الملفات ويرتّب…" : "بيفكر…"} /> : null}
          </div>

          {p.disabled ? <p className="m-0 text-[12px] text-mut">الوثيقة مقفلة؛ المساعد يعمل على المسودات فقط.</p> : (
            <div className="flex shrink-0 flex-col gap-2">
              {attached.length ? (
                <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0" data-testid="agent-files">
                  {attached.map((f, i) => (
                    <li key={`${f.name}-${i}`} className="flex w-fit max-w-full items-center gap-2 rounded-full border border-ac/25 bg-ac/5 px-3 py-1 text-xs text-ink" data-testid="agent-file-chip">
                      <span className="text-ac"><Paperclip /></span><span className="max-w-[150px] truncate font-medium" title={f.name}>{stemOf(f.name)}</span><Ext name={f.name} /><span className="text-[11px] text-mut">({fmtInt(Math.max(1, Math.round(f.size / 1024)))} ك.ب)</span>
                      <button type="button" className="relative flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded-full bg-mut/20 text-[10px] text-mut after:absolute after:-inset-[12px] after:content-['']" aria-label={`إزالة ${f.name}`} onClick={() => setAttached((cur) => cur.filter((_, k) => k !== i))}>✕</button>
                    </li>
                  ))}
                </ul>
              ) : null}
              <form className="flex w-full items-center gap-1.5 rounded-full border border-ln bg-sf p-1.5" style={{ boxShadow: "var(--shadow)" }} onSubmit={(e) => { e.preventDefault(); void send(); }}>
                <input ref={fileInput} type="file" multiple accept={ACCEPT} className="sr-only" id="agent-file-input" onChange={(e) => void onFiles(e.target.files)} data-testid="agent-file-input" />
                <label htmlFor="agent-file-input" className="flex h-[46px] w-[46px] shrink-0 cursor-pointer items-center justify-center rounded-full bg-transparent text-mut transition-colors hover:bg-sf2 hover:text-ac" aria-label="إرفاق ملفات إكسل أو CSV أو صور" title="إرفاق ملفات" data-testid="agent-attach"><Paperclip /></label>
                <input type="text" value={text} maxLength={AGENT_MAX_CHARS} onChange={(e) => setText(e.target.value)} placeholder="اكتب طلبك…" aria-label="رسالة للمساعد" enterKeyHint="send" autoComplete="off" data-testid="agent-input"
                  className="min-h-[46px] min-w-0 flex-1 border-0 bg-transparent px-[14px] text-base font-light text-ink outline-none" />
                <button type="submit" aria-label="اطلب من المساعد" disabled={busy || (!text.trim() && attached.length === 0)} data-testid="agent-send"
                  className="flex h-[46px] w-[46px] shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-ac text-onac transition-opacity disabled:cursor-not-allowed disabled:opacity-60"><ArrowUp /></button>
              </form>
              <p className="m-0 text-center text-[11px] font-light text-mut">إكسل وCSV وصور، حتى ٥ ملفات. الملفات لا تُحفظ.</p>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/** the people found, searchable (hundreds of rows): each can be moved to the departments */
function PeopleList({ people, onMove, disabled }: { people: Array<{ id: string; name: string; company: string }>; onMove: (id: string) => void; disabled: boolean }) {
  const [q, setQ] = useState("");
  const shown = people.filter((c) => q.trim() === "" || c.name.includes(q.trim()) || c.company.includes(q.trim())).slice(0, 40);
  return (
    <div data-testid="agent-people">
      <strong className="text-ink">المديرين ({fmtInt(people.length)}):</strong>
      <input className="mt-1 min-h-11 w-full min-w-0 rounded-full border border-ln bg-sf px-4 text-base font-light text-ink outline-none" value={q} onChange={(e) => setQ(e.target.value)} placeholder="دوّر باسم أو شركة…" aria-label="بحث في المديرين" data-testid="agent-people-search" />
      <ul className="m-0 mt-1 flex max-h-56 list-none flex-col gap-1 overflow-y-auto p-0">
        {shown.map((c) => (
          <li key={c.id} className="flex min-h-11 items-center justify-between gap-2 text-[12px]"><span className="min-w-0 flex-1 break-words">{c.name} <span className="text-mut">({c.company})</span></span>
            <button type="button" className={CHIP} onClick={() => onMove(c.id)} disabled={disabled} data-testid="agent-move-to-department">دي جهة إدارية</button></li>
        ))}
      </ul>
      {people.length > shown.length ? <p className="m-0 mt-1 text-[11px] text-mut">بيظهر أول ٤٠ بس؛ استخدم البحث.</p> : null}
    </div>
  );
}
