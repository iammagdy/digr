"use client";

import { REDESIGN_TYPES, SOCIAL_PLATFORMS, isSocialPlatform, type PlatformFlags, type RedesignFlags, type RedesignMode, type RedesignType, type SocialPlatform } from "@/lib/agentMission/redesignFlagTypes";

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
/** The five social platforms: each can be switched alone; no value means it follows its request type. */
export const PLATFORM_LABEL_AR: Record<SocialPlatform, string> = { tiktok: "تيك توك", x: "إكس", instagram: "إنستجرام", facebook: "فيسبوك", youtube: "يوتيوب" };
export type FlagKey = RedesignType | SocialPlatform;
export type FlagMode = RedesignMode | "inherit";
export const REDESIGN_MODE_LABEL_AR: Record<FlagMode, string> = { off: "إيقاف", test: "تجريبي", on: "تشغيل", inherit: "يتبع النوع" };
const MODES: ReadonlyArray<RedesignMode> = ["off", "test", "on"];
const PLATFORM_MODES: ReadonlyArray<FlagMode> = ["off", "test", "on", "inherit"];
const labelOf = (key: FlagKey): string => (isSocialPlatform(key) ? PLATFORM_LABEL_AR[key] : REDESIGN_TYPE_LABEL_AR[key]);

/** The exact body the existing admin route expects. */
export const flagBody = (type: FlagKey, mode: FlagMode) => ({ action: "redesign_flag" as const, type, mode });
export type FlagBody = ReturnType<typeof flagBody>;

export type FlagDecision = { kind: "noop" } | { kind: "confirm" } | { kind: "send"; body: FlagBody };
/** What a click on `mode` does for a type that has `current`: nothing (already so), a question (only «on»), or the request. */
export function decideFlagClick(type: FlagKey, mode: FlagMode, current: FlagMode): FlagDecision {
  if (mode === current) return { kind: "noop" };
  if (mode === "on") return { kind: "confirm" };
  return { kind: "send", body: flagBody(type, mode) };
}

/** The state machine behind the buttons (kept apart from the screen so it can be tested without a browser). */
export function createFlagController(deps: { send: (body: FlagBody) => Promise<void>; current: () => RedesignFlags; /** The platform overrides as stored (none: every platform follows its type). */ platformCurrent?: () => PlatformFlags }) {
  let confirming: FlagKey | null = null;
  return {
    confirming: (): FlagKey | null => confirming,
    async pick(type: FlagKey, mode: FlagMode): Promise<void> {
      const current: FlagMode = isSocialPlatform(type) ? deps.platformCurrent?.()[type] ?? "inherit" : deps.current()[type];
      const d = decideFlagClick(type, mode, current);
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
  /** The platform overrides as stored (absent key = follows its type). */
  platformFlags?: PlatformFlags;
  /** The type or platform whose switch to «on» is waiting for the admin's answer. */
  confirming: FlagKey | null;
  busy: boolean;
  onPick: (type: FlagKey, mode: FlagMode) => void;
  onConfirm: () => void;
  onCancel: () => void;
}

export function RedesignFlagsSection({ flags, platformFlags = {}, confirming, busy, onPick, onConfirm, onCancel }: RedesignFlagsSectionProps) {
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
                <p className="m-0 text-[13px] leading-[1.8] text-ink">سيعمل المسار الجديد لـ «{labelOf(type)}» لكل العملاء من المهام القادمة. هل تريد التشغيل لكل العملاء؟</p>
                <div className="flex flex-wrap gap-2">
                  <button type="button" className={BTN_ON} disabled={busy} onClick={onConfirm} data-testid="redesign-flag-confirm-yes">نعم، شغّل لكل العملاء</button>
                  <button type="button" className={BTN_OFF} disabled={busy} onClick={onCancel} data-testid="redesign-flag-confirm-no">إلغاء</button>
                </div>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      <h4 className="m-0 mt-2 text-[13px] font-semibold text-ink">مفتاح لكل منصة</h4>
      <p className="m-0 text-[12px] leading-[1.8] text-ink2">«يتبع النوع» هو الوضع الافتراضي: تعمل المنصة بمفتاح نوع طلبها. أي وضع آخر يغلب مفتاح النوع لهذه المنصة وحدها، ويُسجَّل في سجل الإدارة نفسه.</p>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {SOCIAL_PLATFORMS.map((platform) => {
          const current: FlagMode = platformFlags[platform] ?? "inherit";
          return (
            <li key={platform} className="flex flex-col gap-2 rounded-[12px] bg-sf2 px-3 py-2" data-testid={`redesign-flag-platform-${platform}`}>
              <div className="flex flex-wrap items-center justify-between gap-2 text-[13px] text-ink">
                <span className="font-semibold">{PLATFORM_LABEL_AR[platform]}</span>
                <span className="text-ink2">الوضع الحالي: {REDESIGN_MODE_LABEL_AR[current]}</span>
              </div>
              <div className="flex flex-wrap gap-2">
                {PLATFORM_MODES.map((mode) => (
                  <button key={mode} type="button" className={current === mode ? BTN_ON : BTN_OFF} aria-pressed={current === mode} disabled={busy} onClick={() => onPick(platform, mode)} data-testid={`redesign-flag-platform-${platform}-${mode}`}>{REDESIGN_MODE_LABEL_AR[mode]}</button>
                ))}
              </div>
              {confirming === platform ? (
                <div className="flex flex-col gap-2 rounded-[12px] border border-ln2 bg-bg px-3 py-2" role="alertdialog" aria-label="تأكيد التشغيل" data-testid="redesign-flag-confirm">
                  <p className="m-0 text-[13px] leading-[1.8] text-ink">سيعمل المسار الجديد لـ «{PLATFORM_LABEL_AR[platform]}» لكل العملاء من المهام القادمة. هل تريد التشغيل لكل العملاء؟</p>
                  <div className="flex flex-wrap gap-2">
                    <button type="button" className={BTN_ON} disabled={busy} onClick={onConfirm} data-testid="redesign-flag-confirm-yes">نعم، شغّل لكل العملاء</button>
                    <button type="button" className={BTN_OFF} disabled={busy} onClick={onCancel} data-testid="redesign-flag-confirm-no">إلغاء</button>
                  </div>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
