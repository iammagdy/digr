"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import { adminFetch } from "@/lib/adminApi";
import { formatAr, normalizeDigits, toArabicDigits } from "@/lib/arabicDigits";
import type { PoolKeyView, PoolOverview } from "@/lib/server/tregPoolAdmin";
import { agoAr } from "./format";
import { StatusBadge, type BadgeTone } from "./ui";

/**
 * «مجمّع مفاتيح TREG» inside the TREG tab of «مزودو الخدمة» (docs/proposals/treg-key-pool). Admin only. A key is typed into a password field, sent once, validated against
 * the provider on the server and stored encrypted; the screen only ever receives the last 4 characters. The rollout switch is OFF until the admin turns it on: while OFF the
 * platform uses the key it always used.
 */
const SECTION = "flex flex-col gap-3 rounded-[18px] border border-ln bg-bg p-4";
const FIELD = "min-h-[46px] w-full rounded-xl border border-ln bg-bg px-3.5 text-sm text-ink outline-none text-left";
const MONO = { fontFamily: "ui-monospace,monospace" } as const;
const BTN = "min-h-11 cursor-pointer whitespace-nowrap rounded-full border border-ln2 bg-sf px-4 text-xs text-ink";
const BTN_SMALL = "min-h-9 cursor-pointer whitespace-nowrap rounded-full border border-ln2 bg-sf px-3 text-[11px] text-ink";
const BTN_SMALL_PRIMARY = "min-h-9 cursor-pointer whitespace-nowrap rounded-full border-0 bg-ac px-3.5 text-[11px] font-semibold text-onac disabled:opacity-50";
const BTN_PRIMARY = "min-h-11 cursor-pointer rounded-full border-0 bg-ac px-4 text-xs font-semibold text-onac";

export const STATUS_AR: Record<PoolKeyView["status"], string> = { connected: "متصل", error: "خطأ", revoked: "ملغى", out_of_balance: "الرصيد خلص", unknown: "لم يُفحص" };
const STATUS_TONE: Record<PoolKeyView["status"], BadgeTone> = { connected: "ok", error: "bad", revoked: "bad", out_of_balance: "bad", unknown: "mute" };
const MENU_ITEM = "flex min-h-10 w-full cursor-pointer items-center rounded-lg border-0 bg-transparent px-3 text-start text-[12px] text-ink hover:bg-sf2 disabled:cursor-default disabled:opacity-45";
const closeMenu = (e: { currentTarget: HTMLElement }) => e.currentTarget.closest("details")?.removeAttribute("open");
const usd = (n: number) => `${toArabicDigits(n.toFixed(n < 1 ? 4 : 2).replace(/\.?0+$/, "") || "0")} دولار`;

/** The key's name with Arabic-Indic digits. Empty when the name is only the key's own number, so the number is never shown twice beside the name. */
export function shownLabel(k: Pick<PoolKeyView, "label" | "number">): string {
  const t = normalizeDigits(k.label).trim();
  if (t === String(k.number) || t === `رقم ${k.number}` || t === `مفتاح ${k.number}`) return "";
  return toArabicDigits(k.label);
}

/** The order the chain follows: pool keys by position, the main key last, keys outside the chain after everything. */
export function chainOrder(keys: PoolKeyView[]): PoolKeyView[] {
  const inChain = keys.filter((k) => k.inChain && !k.isMain).sort((a, b) => a.chainPosition - b.chainPosition || a.number - b.number);
  const main = keys.filter((k) => k.isMain);
  const outside = keys.filter((k) => !k.inChain && !k.isMain).sort((a, b) => a.number - b.number);
  return [...inChain, ...main, ...outside];
}

export function TregKeyPool({ initial }: { initial?: PoolOverview | null }) {
  const [ov, setOv] = useState<PoolOverview | null>(initial ?? null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [label, setLabel] = useState("");
  const [secret, setSecret] = useState("");
  const [adding, setAdding] = useState(false);
  const [replacing, setReplacing] = useState<string | null>(null);
  const [mainPaste, setMainPaste] = useState(false);
  const [confirmOn, setConfirmOn] = useState(false);

  const load = useCallback(async (refresh: boolean) => {
    setBusy(refresh ? "refresh" : "load");
    try {
      const r = await adminFetch<{ overview: PoolOverview }>(`/api/admin/treg-keys${refresh ? "?refresh=1" : ""}`);
      setOv(r.overview); setError("");
    } catch (e) { setError(e instanceof Error ? e.message : "تعذّر تحميل مجمّع المفاتيح."); } finally { setBusy(""); }
  }, []);
  useEffect(() => { if (!initial) void load(false); }, [load, initial]);

  const act = async (name: string, payload: Record<string, unknown>): Promise<boolean> => {
    if (busy) return false;
    setBusy(name); setMsg(null);
    try {
      const r = await adminFetch<{ success: boolean; message: string }>("/api/admin/treg-keys", { method: "POST", body: JSON.stringify(payload) });
      setMsg({ ok: true, text: r.message });
      await load(false);
      return true;
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : "تعذر تنفيذ الطلب." });
      return false;
    } finally { setBusy(""); }
  };

  if (error && !ov) return <p role="alert" className="m-0 text-[13px] text-bad">{error}</p>;
  if (!ov) return <div className="h-48 rounded-[18px] bg-sf2 motion-safe:animate-pulse motion-reduce:animate-none" />;

  const ordered = chainOrder(ov.keys);
  const main = ov.keys.find((k) => k.isMain);
  const active = ov.keys.find((k) => k.isActive);
  const poolIds = ordered.filter((k) => k.inChain && !k.isMain).map((k) => k.id);
  const saveChain = (ids: string[]) => act("chain", { action: "set_chain", orderedIds: ids });
  const move = (id: string, dir: -1 | 1) => {
    const i = poolIds.indexOf(id); const j = i + dir;
    if (i < 0 || j < 0 || j >= poolIds.length) return;
    const next = [...poolIds]; [next[i], next[j]] = [next[j], next[i]];
    void saveChain(next);
  };

  return (
    <section className={SECTION} aria-label="مجمّع مفاتيح TREG" data-testid="treg-key-pool">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="m-0 text-[15px] font-semibold text-ink">مجمّع مفاتيح TREG</h3>
        <StatusBadge tone={ov.rolloutOn ? "ok" : "mute"} testId="rollout-state">{ov.rolloutOn ? "المجمّع يعمل" : "المجمّع مغلق"}</StatusBadge>
      </div>

      <div className="flex flex-col gap-3 rounded-2xl border border-ln bg-sf p-3.5">
        <div className="flex flex-wrap items-center gap-2">
          {!ov.rolloutOn && !confirmOn && <button type="button" disabled={!ov.ready || !main || busy !== ""} onClick={() => setConfirmOn(true)} className={BTN} style={{ opacity: ov.ready && main ? 1 : 0.5 }} data-testid="rollout-on">تشغيل المجمّع</button>}
          {!ov.rolloutOn && confirmOn && (
            <>
              <span className="text-xs leading-[1.8] text-ink">تشغيل المجمّع يغيّر المفتاح المستخدم في كل الطلبات لاحقًا. المفتاح النشط يبدأ بالرئيسي. متأكد؟</span>
              <button type="button" disabled={busy !== ""} onClick={async () => { await act("rollout", { action: "set_rollout", on: true }); setConfirmOn(false); }} className={BTN_PRIMARY}>نعم، شغّل</button>
              <button type="button" onClick={() => setConfirmOn(false)} className={BTN}>إلغاء</button>
            </>
          )}
          {ov.rolloutOn && <button type="button" disabled={busy !== ""} onClick={() => void act("rollout", { action: "set_rollout", on: false })} className={BTN} data-testid="rollout-off">إيقاف المجمّع (العودة للوضع الحالي)</button>}
          <button type="button" disabled={busy !== "" || !ov.ready} onClick={() => void load(true)} className={BTN} data-testid="refresh-all">{busy === "refresh" ? "جارٍ الفحص…" : "فحص الآن"}</button>
          {!main && ov.ready && (
            <>
              <button type="button" disabled={busy !== ""} onClick={() => void act("adopt", { action: "adopt_main", label: "الرئيسي" })} className={BTN_PRIMARY} data-testid="adopt-main">اعتماد المفتاح الحالي كمفتاح رئيسي</button>
              <button type="button" onClick={() => setMainPaste((v) => !v)} className={BTN}>أو الصق المفتاح الرئيسي</button>
            </>
          )}
        </div>
        <p className="m-0 text-[13px] leading-[1.8] text-ink" data-testid="active-key-line">
          {ov.rolloutOn
            ? active
              ? <>المفتاح النشط الآن: <b>رقم {toArabicDigits(active.number)}</b>{shownLabel(active) ? ` · ${shownLabel(active)}` : ""}{active.last4 ? <> · <bdi dir="ltr" style={MONO}>••••{active.last4}</bdi></> : null}</>
              : "لا يوجد مفتاح نشط الآن."
            : <>المنصة تعمل الآن بالمفتاح الحالي، لأن المجمّع مغلق.{active ? ` عند التشغيل يبدأ بالمفتاح النشط: رقم ${toArabicDigits(active.number)}.` : ""}</>}
        </p>
      </div>
      {mainPaste && !main && (
        <div className="flex flex-col gap-2">
          <input type="password" dir="ltr" autoComplete="off" spellCheck={false} value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="الصق المفتاح الرئيسي هنا" className={FIELD} style={MONO} />
          <div><button type="button" disabled={secret.length < 12 || busy !== ""} onClick={async () => { const k = secret; setSecret(""); if (await act("adopt", { action: "adopt_main", label: "الرئيسي", key: k })) setMainPaste(false); }} className={BTN_PRIMARY}>فحص وحفظ كمفتاح رئيسي</button></div>
        </div>
      )}
      <details className="text-[12px] leading-[1.8] text-mut">
        <summary className="min-h-9 cursor-pointer py-1.5 font-semibold text-ink">كيف يعمل المجمّع؟</summary>
        <p className="m-0 mt-1">
          {ov.rolloutOn
            ? `المنصة كلها (الموقع والعامل) تستخدم المفتاح النشط${active ? `: رقم ${toArabicDigits(active.number)}${shownLabel(active) ? ` (${shownLabel(active)})` : ""}` : ""}. عند توقف المفتاح النشط (إلغاء أو انتهاء رصيد) تنتقل تلقائيًا إلى المفتاح التالي في السلسلة، والمفتاح الرئيسي دائمًا الأخير، ويصلك بريد.`
            : "مغلق: المنصة تعمل بالمفتاح الحالي تمامًا كما هي اليوم. تشغيله يجعل المنصة كلها تستخدم المفتاح النشط من الجدول، ويمكن إيقافه في أي لحظة فتعود للوضع الحالي خلال ثوانٍ."}
        </p>
      </details>
      {ov.noticesAr.map((n, i) => <p key={i} role="status" className="m-0 text-[12px] leading-[1.8]" style={{ color: "var(--bad)" }}>{n}</p>)}
      {msg && <p role="status" aria-live="polite" className="m-0 text-[13px] leading-[1.8]" style={{ color: msg.ok ? "var(--ok)" : "var(--bad)" }}>{msg.text}</p>}

      {ordered.length > 0 && (
        <div className="flex flex-col gap-2">
          <p className="m-0 text-[11px] leading-[1.7] text-fnt">الترتيب في الجدول هو ترتيب الانتقال عند توقف مفتاح: من الأعلى إلى الأسفل، والمفتاح الرئيسي آخرًا دائمًا.</p>
          <div className="rtable-wrap">
            <table className="rtable w-full table-fixed border-collapse text-[12px]" data-testid="pool-table">
              <thead>
                <tr className="text-mut">
                  {[["المفتاح", "w-[22%]"], ["بريد الحساب", "w-[20%]"], ["آخر ٤", "w-[8%]"], ["الرصيد المتبقي", "w-[11%]"], ["الحالة", "w-[14%]"], ["الاستهلاك", "w-[10%]"], ["إجراءات", "w-[15%]"]].map(([c, w]) => <th key={c} scope="col" className={`${w} border-b border-ln px-2 py-2 text-start font-medium`}>{c}</th>)}
                </tr>
              </thead>
              <tbody>
                {ordered.map((k) => {
                  const name = shownLabel(k);
                  const menuLabel = `إجراءات المفتاح رقم ${toArabicDigits(k.number)}`;
                  return (
                    <Fragment key={k.id}>
                      <tr className="align-top text-ink" data-testid={`pool-row-${k.number}`} style={k.isActive ? { background: "var(--sf)" } : undefined}>
                        <td data-wide className="border-b border-ln px-2 py-3">
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
                            <span aria-label={`مفتاح رقم ${toArabicDigits(k.number)}`} className="inline-flex h-7 min-w-7 items-center justify-center rounded-full bg-sf2 px-1.5 text-[12px] font-semibold text-ink">{toArabicDigits(k.number)}</span>
                            {name && <span className="text-[13px] font-semibold">{name}</span>}
                            {k.isMain && <StatusBadge tone="gold" dot={false}>★ الرئيسي / الافتراضي</StatusBadge>}
                            {k.isActive && <StatusBadge tone="ok">نشط الآن</StatusBadge>}
                            {!k.inChain && !k.isMain && <StatusBadge tone="mute" dot={false}>خارج السلسلة</StatusBadge>}
                          </div>
                          {k.isMain && <div className="mt-1.5 text-[11px] leading-[1.6] text-mut">آخر خطوة في السلسلة دائمًا ولا يُحذف</div>}
                        </td>
                        <td data-label="بريد الحساب" className="border-b border-ln px-2 py-3"><span className="rtable-val block break-all"><bdi dir="ltr" style={MONO}>{k.accountEmail ?? "—"}</bdi></span></td>
                        <td data-label="آخر ٤" className="border-b border-ln px-2 py-3"><span className="rtable-val"><bdi dir="ltr" style={MONO}>{k.last4 ? `••••${k.last4}` : "—"}</bdi></span></td>
                        <td data-label="الرصيد المتبقي" className="border-b border-ln px-2 py-3"><span className="rtable-val" dir="ltr">{k.balanceUsd === null ? "—" : usd(k.balanceUsd)}</span></td>
                        <td data-label="الحالة" className="border-b border-ln px-2 py-3">
                          <div className="rtable-val flex flex-col items-start gap-1.5 @max-[859px]:items-end">
                            <StatusBadge tone={STATUS_TONE[k.status]}>{STATUS_AR[k.status]}</StatusBadge>
                            <span className="text-[11px] text-mut">{k.statusCheckedAt ? `آخر فحص: ${agoAr(k.statusCheckedAt)}` : "لم يُفحص بعد"}</span>
                          </div>
                        </td>
                        <td data-label="الاستهلاك" className="border-b border-ln px-2 py-3">
                          <div className="rtable-val">{k.spend.calls > 0 ? <><div>{formatAr(k.spend.calls)} استدعاء</div><div dir="ltr">{usd(k.spend.usd)}</div><div className="text-[11px] text-mut">اليوم: <bdi dir="ltr">{usd(k.spend.todayUsd)}</bdi></div></> : "—"}</div>
                        </td>
                        <td data-wide className="border-b border-ln px-2 py-3">
                          <div className="flex flex-wrap items-center gap-1.5">
                            {!k.isActive
                              ? <button type="button" disabled={busy !== ""} onClick={() => void act("active", { action: "set_active", keyId: k.id, force: k.status === "revoked" || k.status === "out_of_balance" })} className={BTN_SMALL_PRIMARY}>تفعيل</button>
                              : <button type="button" disabled={busy !== ""} onClick={() => void act("check", { action: "refresh", keyId: k.id })} className={BTN_SMALL}>فحص</button>}
                            <details className="relative">
                              <summary aria-label={menuLabel} className={`${BTN_SMALL} inline-flex list-none items-center [&::-webkit-details-marker]:hidden`}>المزيد</summary>
                              <div role="group" aria-label={menuLabel} className="absolute end-0 z-20 mt-1 flex w-52 flex-col rounded-xl border border-ln bg-bg p-1" style={{ boxShadow: "var(--admin-shadow)" }}>
                                {k.inChain && !k.isMain && (
                                  <>
                                    <button type="button" disabled={busy !== "" || poolIds.indexOf(k.id) === 0} onClick={(e) => { closeMenu(e); move(k.id, -1); }} className={MENU_ITEM}>تحريك لأعلى ↑</button>
                                    <button type="button" disabled={busy !== "" || poolIds.indexOf(k.id) === poolIds.length - 1} onClick={(e) => { closeMenu(e); move(k.id, 1); }} className={MENU_ITEM}>تحريك لأسفل ↓</button>
                                  </>
                                )}
                                {!k.isMain && <button type="button" disabled={busy !== ""} onClick={(e) => { closeMenu(e); void saveChain(k.inChain ? poolIds.filter((id) => id !== k.id) : [...poolIds, k.id]); }} className={MENU_ITEM}>{k.inChain ? "إخراج من السلسلة" : "إدخال في السلسلة"}</button>}
                                {!k.isActive && <button type="button" disabled={busy !== ""} onClick={(e) => { closeMenu(e); void act("check", { action: "refresh", keyId: k.id }); }} className={MENU_ITEM}>فحص</button>}
                                <button type="button" disabled={busy !== ""} onClick={(e) => { closeMenu(e); setReplacing(replacing === k.id ? null : k.id); setSecret(""); }} className={MENU_ITEM}>استبدال</button>
                                {!k.isMain && <button type="button" disabled={busy !== "" || k.isActive} title={k.isActive ? "هذا المفتاح قيد الاستخدام؛ فعّل مفتاحًا آخر أولًا" : undefined} onClick={(e) => { closeMenu(e); if (window.confirm(`حذف المفتاح رقم ${toArabicDigits(k.number)}${name ? ` (${name})` : ""}؟`)) void act("remove", { action: "remove", keyId: k.id }); }} className={`${MENU_ITEM} text-bad`}>حذف</button>}
                              </div>
                            </details>
                          </div>
                        </td>
                      </tr>
                      {replacing === k.id && (
                        <tr>
                          <td colSpan={7} data-wide className="border-b border-ln px-2 py-3">
                            <div className="flex flex-col gap-2">
                              <input type="password" dir="ltr" autoComplete="off" spellCheck={false} value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={`الصق المفتاح الجديد لرقم ${toArabicDigits(k.number)} هنا`} className={FIELD} style={MONO} />
                              <div className="flex gap-2"><button type="button" disabled={secret.length < 12 || busy !== ""} onClick={async () => { const v = secret; setSecret(""); if (await act("replace", { action: "replace", keyId: k.id, key: v })) setReplacing(null); }} className={BTN_PRIMARY}>فحص وحفظ</button><button type="button" onClick={() => { setReplacing(null); setSecret(""); }} className={BTN}>إلغاء</button></div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {ordered.length === 0 && ov.ready && <p className="m-0 text-[13px] text-mut">لا توجد مفاتيح بعد. ابدأ باعتماد المفتاح الرئيسي ثم أضف مفاتيح الاختبار.</p>}

      <div className="flex flex-col gap-2">
        {!adding ? <div><button type="button" disabled={!ov.ready || busy !== ""} onClick={() => { setAdding(true); setSecret(""); setLabel(""); }} className={BTN} data-testid="add-key">أضف مفتاحًا</button></div> : (
          <div className="flex flex-col gap-2 rounded-xl border border-ln bg-sf p-3">
            <input type="text" value={label} maxLength={60} onChange={(e) => setLabel(e.target.value)} placeholder="اسم المفتاح (مثال: اختبار-١)" className={FIELD} style={{ textAlign: "right" }} />
            <input type="password" dir="ltr" autoComplete="off" spellCheck={false} value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="الصق مفتاح TREG هنا" className={FIELD} style={MONO} />
            <p className="m-0 text-[11px] leading-[1.7] text-mut">يُفحص المفتاح أولًا بطلب حقيقي لدى المزود؛ إن رفضه لا يُحفظ. يُحفظ مشفّرًا ولا يُعرض إلا آخر ٤ خانات.</p>
            <div className="flex gap-2">
              <button type="button" disabled={!label.trim() || secret.length < 12 || busy !== ""} onClick={async () => { const k = secret; setSecret(""); if (await act("add", { action: "add", label: label.trim(), key: k })) { setAdding(false); setLabel(""); } }} className={BTN_PRIMARY}>{busy === "add" ? "جارٍ الفحص والحفظ…" : "فحص وحفظ"}</button>
              <button type="button" onClick={() => { setAdding(false); setSecret(""); }} className={BTN}>إلغاء</button>
            </div>
          </div>
        )}
      </div>

      {ov.events.length > 0 && (
        <details className="text-[11px] text-mut">
          <summary className="cursor-pointer">آخر الأحداث</summary>
          <ul className="m-0 mt-2 list-none p-0">
            {ov.events.slice(0, 10).map((e, i) => <li key={i}>{agoAr(e.at)} · {EVENT_AR[e.kind] ?? e.kind}{e.keyNumber ? ` · رقم ${toArabicDigits(e.keyNumber)}` : ""}{e.toKeyNumber ? ` ← رقم ${toArabicDigits(e.toKeyNumber)}` : ""}</li>)}
          </ul>
        </details>
      )}
      <p className="m-0 text-[11px] leading-[1.7] text-fnt">الفحص الدوري كل ١٠ دقائق بطلبات قراءة مجانية فقط. المفتاح لا يُعرض كاملًا أبدًا. الحد الأدنى للرصيد قبل اعتبار المفتاح منتهيًا: {usd(ov.minBalanceUsd)}.</p>
    </section>
  );
}

const EVENT_AR: Record<string, string> = {
  key_added: "إضافة مفتاح", key_removed: "حذف مفتاح", key_replaced: "استبدال مفتاح", active_set: "تفعيل مفتاح", chain_set: "تغيير ترتيب السلسلة",
  rollout_on: "تشغيل المجمّع", rollout_off: "إيقاف المجمّع", failover: "انتقال تلقائي", settings: "تغيير الإعدادات",
};
