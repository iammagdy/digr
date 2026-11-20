import { formatAr } from "../arabicDigits";
import { pointsAr } from "../pointsFormat";
import { customerSafeText } from "./text";
import { AGENT_CLOSE_PAGE_NO_EMAIL_LINE_AR } from "./constants";
import { fitArabicWords, missionTitleAr } from "./fileNames";
import { CONTACT_ITEM_NOUN, countAr, deliveredOfAr, GENERIC_ITEM_NOUN, itemNounOf, knownItemNoun, type ItemNoun } from "./itemNoun";
import { FREE_RERUN_MONEY_LINE_AR, heldPointsOf } from "./moneyText";

/**
 * THE NOTICES OF A MISSION, in plain Arabic (an in-site notification and an e-mail through the existing «job-update» template). Pure builders: nothing here sends anything.
 * A notice never names a provider, an endpoint, a file or an id, and never a dollar amount; the figures are points and rows.
 */
export type MissionNoticeKind = "started" | "completed" | "partial" | "failed" | "unserved";

export interface NoticeStageCount {
  titleAr: string;
  noun?: string;
  delivered: number;
  planned: number;
  parentKey?: string | null;
  isPeople?: boolean;
  isContacts?: boolean;
}

export interface MissionNoticeFacts {
  delivered: number;
  planned: number;
  chargedPoints: number;
  /** What came back of the hold from the settlement RPC (or legacy caller). */
  releasedPoints: number;
  /** The points held at approval: the notice states the hold, the charge and the released hold without computing money in notice code. */
  reservedPoints?: number;
  /** The singular noun of the items («تغريدة»): the counts are said with it, in the right form. */
  noun?: string;
  /** The job the approval reserved under (none for a mission that never reserved anything). */
  hasJob: boolean;
  /** «internal»: nothing was delivered because of OUR failure (the source gave items and our own mapping stored none): the notice says so, never «no source found». */
  cause?: "internal" | "empty";
  /** Why fewer items than requested were delivered, as the run recorded it: a partial notice states it instead of the general sentence. */
  shortfallClauseAr?: string;
  /** Per-stage counts with each stage's real noun so multi-stage deliveries never fall back to «عناصر». */
  stages?: ReadonlyArray<NoticeStageCount>;
  /** A free re-run by the Diger team: the money line says nothing was paid. */
  free?: boolean;
}

export interface MissionNotice {
  kind: MissionNoticeKind;
  title: string;
  body: string;
  /** In-site link (the sender replaces it with the link that opens THIS request's conversation). */
  link: string;
  email: { subject: string; /** The line a mail list shows next to the subject. */ preheader: string; heading: string; lead: string; detail1: string; detail2: string; buttonLabel: string } | null;
}

const REQUESTS = "/dashboard/requests";
const BUTTON_OPEN = "افتح طلبك";
const SUBJECT_MAX = 45;
const PREHEADER_MAX = 60;

/**
 * Notice title (C6, D-0086): uses the plan's own clean title when a plan exists;
 * when planning ended with no plan, returns «مهمتك» with zero hard-coded verb/filler word lists.
 */
export function noticeTitleAr(input: { plan?: { stages?: ReadonlyArray<any> } | null; requestText?: string | null }): string {
  if (input.plan && Array.isArray(input.plan.stages) && input.plan.stages.length > 0) {
    return missionTitleAr({ plan: input.plan as Parameters<typeof missionTitleAr>[0]["plan"], requestText: input.requestText });
  }
  return "مهمتك";
}

function stageNounOf(s: NoticeStageCount, parentNoun?: ItemNoun): ItemNoun {
  if (s.isContacts) return CONTACT_ITEM_NOUN;
  if (s.noun) {
    if (s.noun === CONTACT_ITEM_NOUN.singular) return CONTACT_ITEM_NOUN;
    const byHint = knownItemNoun(s.noun);
    if (byHint) return byHint;
    if (s.noun === GENERIC_ITEM_NOUN.singular) return GENERIC_ITEM_NOUN;
  }
  const n = itemNounOf(s.titleAr);
  if (s.parentKey && !s.isPeople && (n.key === GENERIC_ITEM_NOUN.key || (parentNoun && n.key === parentNoun.key))) {
    return CONTACT_ITEM_NOUN;
  }
  if (s.parentKey && s.isPeople && n.key === GENERIC_ITEM_NOUN.key) {
    return knownItemNoun("شخص") ?? n;
  }
  return n;
}

function resolveStageCounts(f: MissionNoticeFacts, fallbackNoun: ItemNoun): Array<{ noun: ItemNoun; delivered: number; planned: number }> {
  if (!f.stages || f.stages.length === 0) return [];
  const rootStage = f.stages.find((s) => !s.parentKey);
  const parentNoun = rootStage ? stageNounOf(rootStage) : fallbackNoun;
  return f.stages.map((s) => ({
    noun: s.parentKey ? stageNounOf(s, parentNoun) : stageNounOf(s),
    delivered: Math.max(0, Math.floor(Number(s.delivered) || 0)),
    planned: Math.max(0, Math.floor(Number(s.planned) || 0)),
  }));
}

function multiStageDeliveryCopy(stages: ReadonlyArray<{ noun: ItemNoun; delivered: number; planned: number }>, overallPlanned = 0): {
  deliveredSummary: string;
  partialOfPhrase: string;
} {
  const deliveredSummary = stages.map((s) => countAr(s.delivered, s.noun)).join(" و");
  if (stages.length === 1) {
    return {
      deliveredSummary: countAr(stages[0].delivered, stages[0].noun),
      partialOfPhrase: deliveredOfAr(stages[0].delivered, Math.max(stages[0].planned, overallPlanned), stages[0].noun),
    };
  }
  const shortOnly = stages.filter((s) => s.delivered < s.planned);
  const requestedParts = (shortOnly.length > 0 && shortOnly.length < stages.length && stages[0].delivered >= stages[0].planned ? shortOnly : stages)
    .map((s) => countAr(s.planned, s.noun));
  return {
    deliveredSummary,
    partialOfPhrase: `${deliveredSummary} من أصل ${requestedParts.join(" و")}`,
  };
}

function boundedSubject(title: string, suffix: string): string {
  const room = Math.max(4, SUBJECT_MAX - [...suffix].length);
  const short = fitArabicWords(title, room) || "مهمتك";
  return `${short}${suffix}`;
}

function noticeMoneyLineAr(f: MissionNoticeFacts, kind: MissionNoticeKind, deliveredSummary: string): string {
  if (f.free) return FREE_RERUN_MONEY_LINE_AR;
  const charged = Math.max(0, Math.round(f.chargedPoints));
  const held = heldPointsOf(f);
  if (charged > 0 && (kind === "completed" || kind === "partial")) {
    if (kind === "partial") {
      // C3: notice code never computes release; uses explicit releasedPoints only when already provided, else fallback text
      const hasExplicitRelease = f.releasedPoints > 0 && (f.reservedPoints === undefined || f.releasedPoints < held);
      return hasExplicitRelease
        ? `خُصم ${pointsAr(charged)} مقابل ما سُلّم فقط، وعاد ${pointsAr(Math.round(f.releasedPoints))} لرصيدك.`
        : `خُصم ${pointsAr(charged)} مقابل ما سُلّم فقط، وعاد باقي الحجز المؤقت لرصيدك.`;
    }
    return `خُصم ${pointsAr(charged)} مقابل ${deliveredSummary}.`;
  }
  if (held > 0) {
    const hasExplicitHold = (f.reservedPoints ?? 0) > 0 || f.releasedPoints > 0;
    return hasExplicitHold
      ? `لم يُخصم شيء، وعاد الحجز المؤقت (${pointsAr(held)}) كاملًا لرصيدك.`
      : "لم يُخصم شيء، وعاد كامل الحجز المؤقت لرصيدك.";
  }
  return "لم يُحجز أي رصيد ولم يُخصم شيء.";
}

function fitPreheader(preferred: string, fallback: string, subject: string): string {
  const pick = [...preferred].length <= PREHEADER_MAX && preferred !== subject ? preferred : fallback;
  return [...pick].length <= PREHEADER_MAX ? pick : fitArabicWords(pick, PREHEADER_MAX);
}

/**
 * The notice of an ending, specific to THE MISSION: short subject (<= 45), single-topic preheader (<= 60, no money leak/repeat),
 * real per-stage nouns, money stated ONCE in detail1, never «خلل من جانبنا» and never «اكتملت» on partial.
 */
export function buildMissionNotice(kind: MissionNoticeKind, f: MissionNoticeFacts, titleIn?: string | null): MissionNotice {
  if (kind === "started") {
    const title = "بدأ تنفيذ مهمتك";
    return { kind, title, body: AGENT_CLOSE_PAGE_NO_EMAIL_LINE_AR, link: REQUESTS, email: null };
  }
  const t = customerSafeText(String(titleIn ?? "").replace(/[«»]/g, "").trim(), "مهمتك") || "مهمتك";
  const named = t !== "مهمتك";
  const singleNoun = f.noun === CONTACT_ITEM_NOUN.singular
    ? CONTACT_ITEM_NOUN
    : (knownItemNoun(f.noun ?? "") ?? (f.noun === GENERIC_ITEM_NOUN.singular ? GENERIC_ITEM_NOUN : itemNounOf(t)));
  const resolvedStages = resolveStageCounts(f, singleNoun);
  const counts = resolvedStages.length > 0
    ? multiStageDeliveryCopy(resolvedStages, f.planned)
    : {
        deliveredSummary: countAr(f.delivered, singleNoun),
        partialOfPhrase: deliveredOfAr(f.delivered, f.planned, singleNoun),
      };
  const money = noticeMoneyLineAr(f, kind, counts.deliveredSummary);

  if (kind === "completed" || kind === "partial") {
    const partial = kind === "partial";
    const subject = boundedSubject(t, partial ? " — تسليم جزئي" : " — النتائج جاهزة");
    const preheader = partial
      ? fitPreheader(`تم تسليم ${counts.deliveredSummary}، والملفات متاحة للتحميل.`, "تم تسليم جزء من طلبك، والملفات متاحة للتحميل.", subject)
      : fitPreheader(`تم تسليم ${counts.deliveredSummary}، والملفات جاهزة للتحميل.`, "ملفات نتائجك جاهزة الآن للتحميل من المنصة.", subject);
    const heading = partial
      ? (named ? `ملفات «${t}» جاهزة (تسليم جزئي)` : "ملفات مهمتك جاهزة (تسليم جزئي)")
      : (named ? `ملفات «${t}» جاهزة للتحميل` : "ملفات مهمتك جاهزة للتحميل");
    const lead = partial
      ? `تم تسليم ${counts.partialOfPhrase}؛ ${f.shortfallClauseAr ? `${f.shortfallClauseAr}.` : "هذا كل ما وُجد مطابقًا لطلبك في المصادر."} يمكنك تحميل ملف النتائج ومراجعة ما وصلك.`
      : `تم استخراج ${counts.deliveredSummary} بنجاح وفق شروط طلبك. يمكنك الآن تنزيل ملف الإكسل ومراجعة البيانات.`;
    const title = partial ? `«${t}»: تسليم جزئي (${counts.deliveredSummary})` : `«${t}»: النتائج جاهزة`;
    return {
      kind, title, body: `${lead} ${money}`, link: REQUESTS,
      email: { subject, preheader, heading, lead, detail1: money, detail2: "", buttonLabel: "افتح طلبك وحمّل الملفات" },
    };
  }

  const unserved = kind === "unserved";
  const ourFault = f.cause === "internal";
  const wording = ourFault
    ? {
        suffix: " — تعذّر استكمال الطلب",
        preheader: "لم يُخصم شيء، تعذّر استكمال الطلب حاليًا.",
        heading: named ? `تعذّر استكمال مهمة «${t}»` : "تعذّر استكمال مهمتك",
        lead: `تعذّر استكمال تنفيذ مهمتك${named ? ` «${t}»` : ""} في الوقت الحالي دون تسليم نتائج. يمكنك إعادة إرسال الطلب بعد قليل.`,
        title: `«${t}»: تعذّر استكمال الطلب`,
      }
    : unserved && f.cause === "empty"
      ? {
          suffix: " — لا توجد نتائج مطابقة",
          preheader: "لم يُخصم شيء، لم نجد نتائج تطابق شروطك.",
          heading: named ? `لم نجد نتائج مطابقة لطلب «${t}»` : "لم نجد نتائج مطابقة لطلبك",
          lead: `بحثنا في المصادر المتاحة${named ? ` عن «${t}»` : ""} ولم نجد نتائج تطابق طلبك بدقة، فلم نسلّم شيئًا. يمكنك تعديل كلمات البحث أو توسيع النطاق.`,
          title: `«${t}»: لا نتائج مطابقة`,
        }
      : unserved
        ? {
            suffix: " — خارج مصادرنا حاليًا",
            preheader: "لم يُخصم شيء، الطلب خارج مصادرنا حاليًا.",
            heading: named ? `طلب «${t}» غير متاح بمصادرنا الحالية` : "طلبك غير متاح بمصادرنا الحالية",
            lead: `لا يتوفر بين مصادرنا الحالية ما يخدم طلبك${named ? ` «${t}»` : ""} بالدقة المطلوبة، لذلك لم نبدأ تنفيذه. يمكنك تجربة صياغة أخرى أو استهداف منصة مختلفة.`,
            title: `«${t}»: خارج مصادرنا حاليًا`,
          }
        : {
            suffix: " — توقف قبل الاكتمال",
            preheader: "لم يُخصم شيء، توقف التنفيذ قبل الاكتمال.",
            heading: named ? `توقف تنفيذ مهمة «${t}»` : "توقف تنفيذ مهمتك",
            lead: `توقف العمل على مهمتك${named ? ` «${t}»` : ""} قبل أن يكتمل ولم نسلّمك أي ملفات. يمكنك إعادة المحاولة بعد قليل.`,
            title: `«${t}»: توقف قبل الاكتمال`,
          };

  const subject = boundedSubject(t, wording.suffix);
  const preheader = fitPreheader(wording.preheader, "لم يُخصم شيء من رصيدك.", subject);
  return {
    kind, title: wording.title, body: `${wording.lead} ${money}`, link: REQUESTS,
    email: { subject, preheader, heading: wording.heading, lead: wording.lead, detail1: money, detail2: "", buttonLabel: BUTTON_OPEN },
  };
}
