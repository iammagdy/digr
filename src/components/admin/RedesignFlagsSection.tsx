"use client";

import { REDESIGN_TYPES, type RedesignFlags, type RedesignMode, type RedesignType } from "@/lib/agentMission/redesignFlagTypes";

/**
 * THE TOGGLE OF THE REDESIGN FLAGS on the admin page «الوكيل»: the six request types, each with its current mode (off / test / on) and three buttons. It writes through the EXISTING admin route action `redesign_flag` (the same audit row as before): no new write path.
 * «تشغيل» (on, for every customer) asks for a confirmation first; «إيقاف» and «تجريبي» (test accounts only) do not. Admin only because the route is: the page receives the flags only from the admin route.
 */
export const REDESIGN_TYPE_LABEL_AR: Record<RedesignType, string> = {
  social_posts: "منشورات وتغريدات بحث عن موضوع",
  social_account: "منشورات حساب محدد",
  social_comments: "منشورات مع تعليقاتها وردودها",
  companies: "الشركات",
  people: "الشركات مع صناع القرار",
  places: "الأماكن",
};
export const REDESIGN_MODE_LABEL_AR: Record<RedesignMode, string> = { off: "إيقاف", test: "تجريبي", on: "تشغيل" };
const MODES: ReadonlyArray<RedesignMode> = ["off", "test", "on"];

/** The exact body the existing admin route expects. */
export const flagBody = (type: RedesignType, mode: RedesignMode) => ({ action: "redesign_flag" as const, type, mode });
export type FlagBody = ReturnType<typeof flagBody>;

export type FlagDecision = { kind: "noop" } | { kind: "confirm" } | { kind: "send"; body: FlagBody };
/** What a click on `mode` does for a type that has `current`: nothing (already so), a question (only «on»), or the request. */
export function decideFlagClick(type: RedesignType, mode: RedesignMode, current: RedesignMode): FlagDecision {
  if (mode === current) return { kind: "noop" };
  if (mode === "on") return { kind: "confirm" };
  return { kind: "send", body: flagBody(type, mode) };
}

/** The state machine behind the buttons (kept apart from the screen so it can be tested without a browser). */
export function createFlagController(deps: { send: (body: FlagBody) => Promise<void>; current: () => RedesignFlags }) {
  let confirming: RedesignType | null = null;
  return {
    confirming: (): RedesignType | null => confirming,
    async pick(type: RedesignType, mode: RedesignMode): Promise<void> {
      const d = decideFlagClick(type, mode, deps.current()[type]);
      if (d.kind === "confirm") { confirming = type; return; }
      confirming = null;
      if (d.kind === "send") await deps.send(d.body);
    },
    cancel(): void { confirming = null; },
    async confirm(): Promise<void> {
      if (confirming === null) return;
      const type = confirming;
      confirming = null;
      await deps.send(flagBody(type, "on"));
    },
  };
}

const BTN = "hit min-h-11 cursor-pointer rounded-xl border px-4 text-sm font-semibold disabled:opacity-50";
const BTN_ON = `${BTN} border-ink bg-ink text-bg`;
const BTN_OFF = `${BTN} border-ln2 bg-sf text-ink`;

export interface RedesignFlagsSectionProps {
  flags: RedesignFlags;
  /** The type whose switch to «on» is waiting for the admin's answer. */
  confirming: RedesignType | null;
  busy: boolean;
  onPick: (type: RedesignType, mode: RedesignMode) => void;
  onConfirm: () => void;
  onCancel: () => void;
}

export function RedesignFlagsSection({ flags, confirming, busy, onPick, onConfirm, onCancel }: RedesignFlagsSectionProps) {
  return (
    <section className="flex flex-col gap-3 rounded-[18px] border border-ln bg-bg p-4" aria-label="مفاتيح التصميم الجديد" data-testid="redesign-flags">
      <h3 className="m-0 text-[13px] font-semibold text-ink">مفاتيح التصميم الجديد لكل نوع طلب</h3>
      <p className="m-0 text-[12px] leading-[1.8] text-ink2">«إيقاف» يعني المسار القديم كما هو. «تجريبي» يشغّل المسار الجديد لحسابات الاختبار فقط. «تشغيل» يشغّله لكل العملاء. يُسجَّل كل تغيير في سجل الإدارة، ويسري على المهام التي تبدأ بعده.</p>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {REDESIGN_TYPES.map((type) => (
          <li key={type} className="flex flex-col gap-2 rounded-[12px] bg-sf2 px-3 py-2" data-testid={`redesign-flag-${type}`}>
            <div className="flex flex-wrap items-center justify-between gap-2 text-[13px] text-ink">
              <span className="font-semibold">{REDESIGN_TYPE_LABEL_AR[type]}</span>
              <span className="text-ink2">الوضع الحالي: {REDESIGN_MODE_LABEL_AR[flags[type]]}</span>
            </div>
            <div className="flex flex-wrap gap-2">
              {MODES.map((mode) => (
                <button key={mode} type="button" className={flags[type] === mode ? BTN_ON : BTN_OFF} aria-pressed={flags[type] === mode} disabled={busy} onClick={() => onPick(type, mode)} data-testid={`redesign-flag-${type}-${mode}`}>{REDESIGN_MODE_LABEL_AR[mode]}</button>
              ))}
            </div>
            {confirming === type ? (
              <div className="flex flex-col gap-2 rounded-[12px] border border-ln2 bg-bg px-3 py-2" role="alertdialog" aria-label="تأكيد التشغيل" data-testid="redesign-flag-confirm">
                <p className="m-0 text-[13px] leading-[1.8] text-ink">سيعمل المسار الجديد لـ «{REDESIGN_TYPE_LABEL_AR[type]}» لكل العملاء من المهام القادمة. هل تريد التشغيل لكل العملاء؟</p>
                <div className="flex flex-wrap gap-2">
                  <button type="button" className={BTN_ON} disabled={busy} onClick={onConfirm} data-testid="redesign-flag-confirm-yes">نعم، شغّل لكل العملاء</button>
                  <button type="button" className={BTN_OFF} disabled={busy} onClick={onCancel} data-testid="redesign-flag-confirm-no">إلغاء</button>
                </div>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
