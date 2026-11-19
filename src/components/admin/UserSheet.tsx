"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode, type Ref } from "react";
import { useRouter } from "next/navigation";
import { adminFetch } from "@/lib/adminApi";
import { formatAr } from "@/lib/arabicDigits";
import { useAdmin } from "./AdminShell";
import { KV, Sheet, SheetHandle } from "./Sheet";
import { CustomerEmailPanel } from "./CustomerEmailPanel";
import { FreeRerunPanel } from "./FreeRerunPanel";
import { ConfirmDialog } from "./ConfirmDialog";
import { EmptyState, ErrorState, StatTile, StatusBadge, SubTabs } from "./ui";
import { EGP, agoAr, badgeFor, dateTimeAr, initials } from "./format";
import {
  MISSION_STATUS_AR, SUSPEND_DURATIONS, USER_TABS, createGrantFlow, createSuspendFlow, missionStatusTone, newRequestId, runningMissionsCount, runningNoteAr, suspendControlOf, userBadges,
  type SuspendDuration, type UserMissionItem, type UserTab,
} from "./userSheetLogic";

interface HistoryRow { id: string; at: string; kind: string; kindAr: string; amount: number; runningBalance: number; note: string; grantedBy: string | null; jobId: string | null }
/** GET /api/admin/users/[id]. `jobs` and `lastJobAt` are the customer's requests in `missions` (the names stay). */
export interface UserDetail {
  id: string; name: string; email: string; registration: string; lastLogin: string | null; balance: number; totalTopupsEgp: number;
  lastTopupAt: string | null; jobs: number; lastJobAt: string | null; promo: { used: boolean; codes: Array<{ code: string; redeemedAt: string }> };
  topups: Array<{ id: string; amountEgp: number; status: string; createdAt: string }>; history: HistoryRow[];
}

const LEDGER_PAGE = 30;
const SECTION_TITLE = "mb-1.5 mt-0 text-[13px] font-semibold text-mut";
const BLOCK = "flex flex-col gap-2 rounded-[14px] border border-ln p-3";
const OUTLINE = "min-h-11 cursor-pointer rounded-full border border-ln2 bg-transparent px-4 text-[13px] font-semibold";
const GHOST_BUTTON = `${OUTLINE} text-ink`;
const DANGER_BUTTON = `${OUTLINE} text-bad`;

/* ── the pieces of the profile (each rendered on its own in tests/admin-user-sheet.test.tsx) ── */

/** The actions row under the tiles: راسل · أضف رصيدًا · the account action (hidden on the admin's own profile; behind «⋯» on a phone so a mis-tap is harder). */
export function UserActionsRow(props: { phone: boolean; suspend: { suspended: boolean } | null; moreOpen: boolean; onToggleMore: () => void; onMessage: () => void; onGrant: () => void; onSuspend: () => void; onReactivate: () => void }) {
  const { phone, suspend, moreOpen } = props;
  const account = suspend && (suspend.suspended
    ? <button type="button" onClick={props.onReactivate} className={GHOST_BUTTON}>أعد تفعيل الحساب</button>
    : <button type="button" onClick={props.onSuspend} className={DANGER_BUTTON}>أوقف الحساب</button>);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" onClick={props.onMessage} className={GHOST_BUTTON}>راسل</button>
      <button type="button" onClick={props.onGrant} className="min-h-11 cursor-pointer rounded-full border-0 bg-ac px-4 text-[13px] font-semibold text-onac">أضف رصيدًا</button>
      {account && !phone && account}
      {account && phone && (
        <span className="relative">
          <button type="button" onClick={props.onToggleMore} aria-label="إجراءات أخرى" aria-expanded={moreOpen} className="min-h-11 min-w-11 cursor-pointer rounded-full border border-ln2 bg-transparent px-3 text-[15px] font-semibold text-ink">⋯</button>
          {moreOpen && <span className="absolute end-0 top-full z-10 mt-1.5 flex rounded-[14px] border border-ln bg-sf p-1.5" style={{ boxShadow: "var(--admin-shadow)" }}>{account}</span>}
        </span>
      )}
    </div>
  );
}

/** «إضافة رصيد يدوي»: the form only reviews; the grant is sent from the confirm dialog. */
export function GrantForm(props: { points: string; note: string; onPoints: (v: string) => void; onNote: (v: string) => void; onReview: (e: FormEvent) => void; msg: { ok: boolean; text: string } | null; pointsRef?: Ref<HTMLInputElement> }) {
  const { points, note, msg } = props;
  return (
    <section>
      <h3 className={SECTION_TITLE}>إضافة رصيد يدوي</h3>
      <form onSubmit={props.onReview} className="flex flex-col gap-2.5 rounded-[14px] border border-ln p-3">
        <label className="flex flex-col gap-1.5"><span className="text-xs text-mut">عدد النقاط</span><input ref={props.pointsRef} inputMode="numeric" value={points} onChange={(e) => props.onPoints(e.target.value)} placeholder="١٠٠" required className="min-h-11 rounded-xl border border-ln bg-bg px-3 text-base text-ink outline-none" /></label>
        <label className="flex flex-col gap-1.5"><span className="text-xs text-mut">السبب (يُسجَّل مع اسمك)</span><input value={note} maxLength={200} onChange={(e) => props.onNote(e.target.value)} placeholder="مثال: تعويض عن مشكلة" required className="min-h-11 rounded-xl border border-ln bg-bg px-3 text-base text-ink outline-none" /></label>
        <button type="submit" disabled={!points.trim() || note.trim().length < 3} className="min-h-11 cursor-pointer self-start rounded-full border-0 bg-ac px-5 text-[13px] font-semibold text-onac disabled:opacity-50">مراجعة</button>
        <p role="status" aria-live="polite" className="m-0 min-h-[1.1rem] text-xs leading-[1.8]" style={{ color: msg ? (msg.ok ? "var(--ok)" : "var(--bad)") : "var(--fnt)" }}>{msg?.text || "تُضاف النقاط بعد التأكيد ويظهر السجل أدناه."}</p>
      </form>
    </section>
  );
}

/** «تأكيد إضافة الرصيد» (spec §5.4): the number, the name and the current balance; the button is busy while the request runs. */
export function GrantConfirmDialog(props: { open: boolean; points: string; name: string; balance: number; working: boolean; error: string | null; onConfirm: () => void; onCancel: () => void }) {
  const who = props.name.trim() || "هذا العميل";
  return (
    <ConfirmDialog open={props.open} title="تأكيد إضافة الرصيد" confirmLabel={props.working ? "جارٍ الإضافة…" : "أؤكد الإضافة"} working={props.working} error={props.error} onConfirm={props.onConfirm} onCancel={props.onCancel}
      body={(
        <div className="flex flex-col gap-2">
          <p className="m-0">{`ستُضاف ${formatAr(Number(props.points) || 0)} نقطة إلى رصيد ${who}. رصيده الحالي ${formatAr(props.balance)} نقطة.`}</p>
          <p className="m-0 text-[13px] text-mut">تُسجَّل الحركة باسمك في سجل الرصيد وفي سجل العمليات، ولا تُحذف. الخطأ لا يُصحَّح إلا بحركة جديدة.</p>
        </div>
      )} />
  );
}

/** «أوقف الحساب» / «أعد تفعيل الحساب»: a reason (3 characters or more, written to the audit log), the duration, and what the suspension does not change. */
export function SuspendDialog(props: { open: boolean; mode: "suspend" | "reactivate"; reason: string; onReason: (v: string) => void; duration: SuspendDuration; onDuration: (d: SuspendDuration) => void; running: number | null; working: boolean; error: string | null; onConfirm: () => void; onCancel: () => void }) {
  const suspend = props.mode === "suspend";
  return (
    <ConfirmDialog open={props.open} danger={suspend} title={suspend ? "إيقاف الحساب" : "إعادة تفعيل الحساب"} confirmLabel={props.working ? "جارٍ التنفيذ…" : suspend ? "أوقف الحساب" : "أعد تفعيل الحساب"}
      working={props.working} error={props.error} onConfirm={props.onConfirm} onCancel={props.onCancel}
      body={(
        <div className="flex flex-col gap-3">
          {suspend ? (
            <>
              <p className="m-0">يمنع الإيقاف العميل من تسجيل الدخول ومن بدء أي طلب أو شحن، حتى تنتهي المدة أو تعيد تفعيل الحساب.</p>
              <p className="m-0 text-[13px] text-mut">{props.running === null ? "تعذّر عدّ المهام قيد التنفيذ الآن؛ الإيقاف لا يلغي أي مهمة ولا يلمس أي حجز." : runningNoteAr(props.running)}</p>
              <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0">
                <legend className="mb-1.5 p-0 text-xs text-mut">مدة الإيقاف</legend>
                <div className="flex flex-wrap gap-1.5">
                  {SUSPEND_DURATIONS.map(([d, label]) => (
                    <label key={d} className="flex min-h-11 cursor-pointer items-center gap-2 rounded-full border border-ln2 px-4 text-[13px] text-ink">
                      <input type="radio" name="suspend-duration" value={d} checked={props.duration === d} onChange={() => props.onDuration(d)} />
                      {label}
                    </label>
                  ))}
                </div>
              </fieldset>
            </>
          ) : (
            <p className="m-0">يعود العميل قادرًا على الدخول والطلب والشحن.</p>
          )}
          <label className="flex flex-col gap-1.5">
            <span className="text-xs text-mut">{suspend ? "سبب الإيقاف (يُسجَّل في سجل العمليات)" : "سبب إعادة التفعيل (يُسجَّل في سجل العمليات)"}</span>
            <input value={props.reason} maxLength={300} onChange={(e) => props.onReason(e.target.value)} className="min-h-11 rounded-xl border border-ln bg-bg px-3 text-base text-ink outline-none" />
          </label>
        </div>
      )} />
  );
}

/** One tab of the profile; only the chosen tab is rendered. */
export function UserTabPanel(props: { tab: UserTab; u: UserDetail; missions: { rows: UserMissionItem[] | null; error: string }; onRetryMissions: () => void; ledgerShown: number; onMoreLedger: () => void; grantForm: ReactNode; messages: ReactNode; actions: ReactNode }) {
  const { tab, u, missions } = props;
  let content: ReactNode = null;
  if (tab === "summary") {
    content = (
      <section>
        <h3 className={SECTION_TITLE}>الحساب</h3>
        <KV k="تاريخ التسجيل" v={dateTimeAr(u.registration)} />
        <KV k="آخر تسجيل دخول" v={u.lastLogin ? agoAr(u.lastLogin) : "—"} />
        <KV k="آخر شحن" v={u.lastTopupAt ? agoAr(u.lastTopupAt) : "—"} />
        <KV k="آخر بحث" v={u.lastJobAt ? agoAr(u.lastJobAt) : "—"} />
        <KV k="استخدم كودًا ترويجيًا" v={u.promo.used ? `نعم (${u.promo.codes.map((c) => c.code).join("، ")})` : "لا"} />
        <KV k="معرف العميل" v={u.id} dir="ltr" mono />
        <KV k="طريقة الدخول" v="بريد إلكتروني وكلمة مرور" />
      </section>
    );
  } else if (tab === "balance") {
    const shown = u.history.slice(0, props.ledgerShown);
    content = (
      <>
        {props.grantForm}
        <section>
          <h3 className={SECTION_TITLE}>سجل الرصيد الكامل</h3>
          {shown.map((h) => (
            <div key={h.id} className="flex min-h-[54px] items-center justify-between gap-3 border-b border-ln py-1.5">
              <span className="min-w-0">
                <span className="block text-[13px] font-semibold text-ink">{h.kindAr}</span>
                <span className="block text-[11px] text-fnt">{dateTimeAr(h.at)}{h.grantedBy ? ` · بواسطة ${h.grantedBy}` : ""}</span>
                {h.note && <span className="block truncate text-[11px] text-mut" title={h.note}>{h.note}</span>}
              </span>
              <span className="shrink-0 text-start" dir="ltr">
                <span className="block text-[14px] font-semibold" style={{ color: h.amount > 0 ? "var(--ok)" : "var(--ink)" }}>{h.amount > 0 ? "+" : "−"}{formatAr(Math.abs(h.amount))}</span>
                <span className="block text-[11px] text-fnt">{formatAr(h.runningBalance)}</span>
              </span>
            </div>
          ))}
          {u.history.length === 0 && <p className="m-0 text-xs text-fnt">لا توجد حركات بعد.</p>}
          {u.history.length > shown.length && <button type="button" onClick={props.onMoreLedger} className={`${GHOST_BUTTON} mt-2`}>عرض المزيد</button>}
        </section>
      </>
    );
  } else if (tab === "missions") {
    content = (
      <section>
        <h3 className={SECTION_TITLE}>آخر ٢٠ مهمة</h3>
        {missions.error ? <ErrorState title={missions.error} onRetry={props.onRetryMissions} />
          : missions.rows === null ? [0, 1, 2].map((i) => <div key={i} aria-hidden="true" className="mb-2 h-[72px] rounded-[14px] bg-sf2 motion-safe:animate-pulse motion-reduce:animate-none" />)
          : missions.rows.length === 0 ? <EmptyState title="لا توجد مهام لهذا العميل بعد." />
          : (
            <ul className="m-0 flex list-none flex-col p-0">
              {missions.rows.map((m) => (
                <li key={m.id} className="flex min-h-[64px] flex-col gap-1 border-b border-ln py-2">
                  <span className="truncate text-[13px] font-semibold text-ink" title={m.request}>{m.request || "—"}</span>
                  <span className="flex flex-wrap items-center gap-2 text-[11px] text-fnt">
                    <StatusBadge tone={missionStatusTone(m.status)}>{MISSION_STATUS_AR[m.status] ?? "غير معروفة"}</StatusBadge>
                    <span>{dateTimeAr(m.created_at)}</span>
                    {m.delivered !== null && <span>{m.asked > 0 ? `سُلِّم ${formatAr(m.delivered)} من ${formatAr(m.asked)}` : `سُلِّم ${formatAr(m.delivered)}`}</span>}
                    {m.charged_points !== null && <span>{`${formatAr(m.charged_points)} نقطة`}</span>}
                  </span>
                </li>
              ))}
            </ul>
          )}
      </section>
    );
  } else if (tab === "topups") {
    content = (
      <section>
        <h3 className={SECTION_TITLE}>طلبات الشحن</h3>
        {u.topups.map((t) => {
          const b = badgeFor(t.status);
          return (
            <div key={t.id} className="flex min-h-[50px] items-center justify-between gap-3 border-b border-ln">
              <span><span className="block text-[13px] font-semibold text-ink">{EGP(t.amountEgp)}</span><span className="block text-[11px] text-fnt">{dateTimeAr(t.createdAt)}</span></span>
              <span className="rounded-full px-[9px] py-0.5 text-[11px] font-semibold" style={{ background: b.bg, color: b.fg }}>{b.label}</span>
            </div>
          );
        })}
        {u.topups.length === 0 && <p className="m-0 text-xs text-fnt">لم يشحن بعد.</p>}
      </section>
    );
  } else if (tab === "messages") {
    content = props.messages;
  } else {
    content = props.actions;
  }
  return <div role="tabpanel" id={`user-panel-${tab}`} aria-labelledby={`user-tab-${tab}`} className="flex flex-col gap-[18px]">{content}</div>;
}

/* ── the sheet ── */

/** The user's profile (DT-20261118-06 §5.3): header with badges, three tiles, the actions row, and one tab at a time. */
export function UserSheet({ userId, onClose }: { userId: string; onClose: () => void }) {
  const router = useRouter();
  const { toast, isMobile } = useAdmin();
  const [u, setU] = useState<UserDetail | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [tab, setTab] = useState<UserTab>("summary");
  const [ledgerShown, setLedgerShown] = useState(LEDGER_PAGE);
  const [moreOpen, setMoreOpen] = useState(false);

  // «verified business»: the flag that lets a customer account use the sensitive data category (the admin sets it; the table may not be applied yet).
  const [vb, setVb] = useState<{ verified: boolean; available: boolean } | null>(null);
  const [vbBusy, setVbBusy] = useState(false);
  const [vbMsg, setVbMsg] = useState("");
  useEffect(() => { adminFetch<{ verified: boolean; available: boolean }>(`/api/admin/users/${userId}/verified-business`).then(setVb).catch(() => setVb(null)); }, [userId]);
  const toggleVerified = async () => {
    if (!vb || vbBusy) return;
    setVbBusy(true); setVbMsg("");
    try {
      await adminFetch(`/api/admin/users/${userId}/verified-business`, { method: "PUT", body: JSON.stringify({ verified: !vb.verified }) });
      setVb({ ...vb, verified: !vb.verified });
      setVbMsg(!vb.verified ? "تم توثيق الحساب كحساب أعمال." : "أُلغي توثيق الحساب.");
    } catch (e) { setVbMsg(e instanceof Error ? e.message : "تعذّر الحفظ"); } finally { setVbBusy(false); }
  };

  const load = useCallback(() => adminFetch<UserDetail>(`/api/admin/users/${userId}`).then(setU).catch((e) => setError(e.message)), [userId]);
  useEffect(() => { void load(); }, [load]);

  // the «المهام» tab and the suspend dialog's running count read the same rows
  const [missions, setMissions] = useState<{ rows: UserMissionItem[] | null; error: string }>({ rows: null, error: "" });
  const loadMissions = useCallback(() => {
    setMissions({ rows: null, error: "" });
    adminFetch<{ missions: UserMissionItem[] }>(`/api/admin/users/${userId}/missions`)
      .then((r) => setMissions({ rows: Array.isArray(r.missions) ? r.missions : [], error: "" }))
      .catch((e) => setMissions({ rows: null, error: e instanceof Error && e.message ? e.message : "تعذّر تحميل المهام." }));
  }, [userId]);
  useEffect(() => { loadMissions(); }, [loadMissions]);

  // the account's suspension: hidden on the admin's own profile (`self`) or when it could not be read
  const [suspendState, setSuspendState] = useState<{ suspended: boolean; self: boolean } | null>(null);
  useEffect(() => {
    adminFetch<{ suspended: boolean; self: boolean }>(`/api/admin/users/${userId}/suspend`).then((r) => setSuspendState({ suspended: !!r.suspended, self: !!r.self })).catch(() => setSuspendState(null));
  }, [userId]);
  const suspendControl = suspendControlOf(suspendState);

  /* grant: form → «مراجعة» → confirm → the existing credit route, once, with one requestId */
  const [points, setPoints] = useState("");
  const [note, setNote] = useState("");
  const [grantMsg, setGrantMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [grantOpen, setGrantOpen] = useState(false);
  const [grantWorking, setGrantWorking] = useState(false);
  const [grantError, setGrantError] = useState<string | null>(null);
  const pointsRef = useRef<HTMLInputElement | null>(null);
  const grantFlow = useMemo(() => createGrantFlow({
    post: (body) => adminFetch<{ messageAr: string }>(`/api/admin/users/${userId}/credit`, { method: "POST", body: JSON.stringify(body) }),
    newId: newRequestId,
  }), [userId]);
  const review = (event: FormEvent) => {
    event.preventDefault();
    const r = grantFlow.review(points, note);
    if (!r.ok) { setGrantMsg({ ok: false, text: r.errorAr }); return; }
    setGrantMsg(null); setGrantError(null); setGrantOpen(true);
  };
  const confirmGrant = async () => {
    const running = grantFlow.confirm();
    if (!running) return;
    setGrantWorking(true);
    const r = await running;
    setGrantWorking(false);
    if (!r.ok) { setGrantError(r.errorAr); return; }
    setGrantOpen(false);
    setGrantMsg({ ok: true, text: r.messageAr });
    setPoints(""); setNote("");
    await load();
  };
  const cancelGrant = () => { grantFlow.cancel(); setGrantOpen(false); setGrantError(null); };

  /* suspend / reactivate: a reason, a duration, the honest running count; posted once */
  const [suspendMode, setSuspendMode] = useState<"suspend" | "reactivate" | null>(null);
  const [reason, setReason] = useState("");
  const [duration, setDuration] = useState<SuspendDuration>("7d");
  const [suspendWorking, setSuspendWorking] = useState(false);
  const [suspendError, setSuspendError] = useState<string | null>(null);
  const suspendFlow = useMemo(() => createSuspendFlow((body) => adminFetch<{ suspended: boolean; bannedUntil: string | null }>(`/api/admin/users/${userId}/suspend`, { method: "POST", body: JSON.stringify(body) })), [userId]);
  const openSuspend = (mode: "suspend" | "reactivate") => {
    setMoreOpen(false); setSuspendError(null); setDuration("7d");
    setReason(mode === "reactivate" ? "إعادة تفعيل بعد المراجعة" : "");
    setSuspendMode(mode);
  };
  const confirmSuspend = async () => {
    if (!suspendMode) return;
    setSuspendWorking(true);
    const r = await suspendFlow.submit(suspendMode === "suspend" ? { action: "suspend", duration, reason } : { action: "reactivate", reason });
    setSuspendWorking(false);
    if (!r.ok) { setSuspendError(r.errorAr); return; }
    setSuspendState({ suspended: r.suspended, self: false });
    setSuspendMode(null);
    toast(r.suspended ? "أُوقف الحساب." : "أُعيد تفعيل الحساب.");
  };

  const copyEmail = async () => {
    if (!u) return;
    try { await navigator.clipboard?.writeText(u.email); } catch { /* blocked */ }
    setCopied(true); setTimeout(() => setCopied(false), 1500);
  };
  const goGrant = () => { setTab("balance"); setTimeout(() => pointsRef.current?.focus(), 0); };

  const badges = u ? userBadges({ lastLogin: u.lastLogin, suspended: !!suspendState?.suspended, verified: vb?.verified === true }) : [];

  const actions = (
    <>
      <FreeRerunPanel userId={userId} />
      <section>
        <h3 className={SECTION_TITLE}>حساب أعمال موثّق</h3>
        <div className={BLOCK}>
          <p className="m-0 text-xs leading-[1.8] text-mut">الحساب الموثّق يستطيع طلب الخدمات الحسّاسة (بيانات شخصية وبحث عكسي) بعد ذكر الغرض، وكل استعلام يُسجَّل.</p>
          <button type="button" onClick={toggleVerified} disabled={!vb || vbBusy || vb.available === false} aria-pressed={vb?.verified === true} className="min-h-11 cursor-pointer self-start rounded-full border border-ln2 bg-transparent px-5 text-[13px] font-semibold text-ink disabled:opacity-50">{vb?.verified ? "إلغاء التوثيق" : "توثيق كحساب أعمال"}</button>
          <p role="status" aria-live="polite" className="m-0 min-h-[1.1rem] text-xs text-fnt">{vb && vb.available === false ? "الميزة غير مُفعَّلة بعد في قاعدة البيانات." : vbMsg}</p>
        </div>
      </section>
      {suspendControl && (
        <section>
          <h3 className={SECTION_TITLE}>{suspendControl.suspended ? "إعادة تفعيل الحساب" : "إيقاف الحساب"}</h3>
          <div className={BLOCK}>
            <p className="m-0 text-xs leading-[1.8] text-mut">{suspendControl.suspended ? "الحساب موقوف الآن: لا يستطيع العميل الدخول ولا بدء طلب أو شحن." : "يمنع الإيقاف العميل من تسجيل الدخول ومن بدء أي طلب أو شحن، ولا يلغي المهام قيد التنفيذ ولا يلمس الرصيد."}</p>
            {suspendControl.suspended
              ? <button type="button" onClick={() => openSuspend("reactivate")} className={`${GHOST_BUTTON} self-start`}>أعد تفعيل الحساب</button>
              : <button type="button" onClick={() => openSuspend("suspend")} className={`${DANGER_BUTTON} self-start`}>أوقف الحساب</button>}
          </div>
        </section>
      )}
    </>
  );

  return (
    <Sheet label="بيانات المستخدم" onClose={onClose}>
      <div className="shrink-0 border-b border-ln px-[18px] pb-4 pt-3.5">
        <SheetHandle />
        <div className="flex items-center gap-3">
          <span className="flex h-[52px] w-[52px] items-center justify-center rounded-full bg-sf2 text-base font-semibold text-ink">{initials(u?.name || "")}</span>
          <div className="min-w-0 flex-1">
            <p className="m-0 truncate text-[17px] font-semibold text-ink" title={u?.name || ""}>{u?.name || "…"}</p>
            <bdi dir="ltr" className="mt-0.5 block truncate text-end text-xs text-fnt">{u?.email}</bdi>
          </div>
          <button type="button" onClick={onClose} aria-label="إغلاق" className="h-11 w-11 shrink-0 cursor-pointer rounded-full border-0 bg-sf2 text-xl text-ink">×</button>
        </div>
        {badges.length > 0 && <div className="mt-2.5 flex flex-wrap gap-1.5">{badges.map((b) => <StatusBadge key={b.label} tone={b.tone}>{b.label}</StatusBadge>)}</div>}
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-[18px] overflow-y-auto p-[18px]">
        {error && <p role="alert" className="m-0 text-[13px] text-bad">{error}</p>}
        <div className="grid grid-cols-3 gap-2">
          <StatTile label="الرصيد" value={u ? formatAr(u.balance) : "…"} />
          <StatTile label="إجمالي الشحن" value={u ? (u.totalTopupsEgp ? EGP(u.totalTopupsEgp) : "—") : "…"} />
          <StatTile label="المهام" value={u ? formatAr(u.jobs) : "…"} />
        </div>
        {u && (
          <>
            <UserActionsRow phone={isMobile} suspend={suspendControl} moreOpen={moreOpen} onToggleMore={() => setMoreOpen((o) => !o)}
              onMessage={() => setTab("messages")} onGrant={goGrant} onSuspend={() => openSuspend("suspend")} onReactivate={() => openSuspend("reactivate")} />
            <SubTabs label="أقسام ملف المستخدم" value={tab} items={USER_TABS} onChange={setTab} idPrefix="user-tab" />
            <UserTabPanel tab={tab} u={u} missions={missions} onRetryMissions={loadMissions} ledgerShown={ledgerShown} onMoreLedger={() => setLedgerShown((n) => n + LEDGER_PAGE)}
              grantForm={<GrantForm points={points} note={note} onPoints={setPoints} onNote={setNote} onReview={review} msg={grantMsg} pointsRef={pointsRef} />}
              messages={<CustomerEmailPanel userId={u.id} />}
              actions={actions} />
          </>
        )}
      </div>
      <div className="grid shrink-0 grid-cols-2 gap-2 border-t border-ln px-[18px] pt-3" style={{ paddingBottom: "calc(16px + env(safe-area-inset-bottom))" }}>
        <button type="button" onClick={copyEmail} className="min-h-[50px] cursor-pointer rounded-full border border-ln2 bg-transparent text-[13px] font-semibold text-ink">{copied ? "تم نسخ البريد" : "نسخ البريد"}</button>
        <button type="button" onClick={() => { onClose(); router.push("/admin/topups?status=all"); toast("عرض كل طلبات الشحن"); }} className="min-h-[50px] cursor-pointer rounded-full border-0 bg-ac text-[13px] font-semibold text-onac">طلبات الشحن</button>
      </div>
      <GrantConfirmDialog open={grantOpen} points={grantFlow.pending?.points ?? "0"} name={u?.name ?? ""} balance={u?.balance ?? 0} working={grantWorking} error={grantError} onConfirm={() => { void confirmGrant(); }} onCancel={cancelGrant} />
      {suspendMode && (
        <SuspendDialog open mode={suspendMode} reason={reason} onReason={setReason} duration={duration} onDuration={setDuration}
          running={missions.rows ? runningMissionsCount(missions.rows) : null} working={suspendWorking} error={suspendError} onConfirm={() => { void confirmSuspend(); }} onCancel={() => { if (!suspendWorking) setSuspendMode(null); }} />
      )}
    </Sheet>
  );
}
