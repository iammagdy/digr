import { formatAr, toArabicDigits } from "../arabicDigits";
import { pointsAr } from "../pointsFormat";
import { AGENT_CLOSE_PAGE_NO_EMAIL_LINE_AR } from "./constants";
import { deliveredOfAr, itemNounOf, knownItemNoun } from "./itemNoun";
import { heldPointsOf, moneyLineAr } from "./moneyText";

/**
 * THE NOTICES OF A MISSION, in plain Arabic (an in-site notification and an e-mail through the existing «job-update» template). Pure builders: nothing here sends anything.
 * A notice never names a provider, an endpoint, a file or an id, and never a dollar amount; the figures are points and rows.
 */
export type MissionNoticeKind = "started" | "completed" | "partial" | "failed" | "unserved";

export interface MissionNoticeFacts {
  delivered: number;
  planned: number;
  chargedPoints: number;
  /** What came back of the hold (the older shape: only used, with the charge, to find the hold when `reservedPoints` is absent). */
  releasedPoints: number;
  /** The points held at approval: the notice states the hold, the charge and the released hold exactly as the wallet shows them. */
  reservedPoints?: number;
  /** The singular noun of the items («تغريدة»): the counts are said with it, in the right form. */
  noun?: string;
  /** The job the approval reserved under (none for a mission that never reserved anything). */
  hasJob: boolean;
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
const buttonOpen = "افتح طلبك";

/**
 * The notice of an ending, specific to THE MISSION: its title («تغريدات عن محمد صلاح»), what was delivered of what was requested, the points charged, and a button to that request. The subject, the preview line
 * and the heading of the e-mail are three different sentences (a mail list shows the subject and the preview next to each other); the in-site notice says the same facts. Arabic only, Arabic-Indic digits, no id.
 */
export function buildMissionNotice(kind: MissionNoticeKind, f: MissionNoticeFacts, titleIn?: string | null): MissionNotice {
  if (kind === "started") {
    const title = "بدأ تنفيذ مهمتك";
    // the in-site notice never promises an e-mail (the customer may have switched them off): it says where the result will be
    return { kind, title, body: AGENT_CLOSE_PAGE_NO_EMAIL_LINE_AR, link: REQUESTS, email: null };
  }
  const t = toArabicDigits(String(titleIn ?? "").replace(/[«»]/g, "").trim()) || "مهمتك";
  const noun = knownItemNoun(f.noun ?? "") ?? itemNounOf(t);
  const money = moneyLineAr({ reservedPoints: heldPointsOf(f), chargedPoints: f.chargedPoints });
  const deliveredOf = deliveredOfAr(f.delivered, f.planned, noun);
  if (kind === "completed" || kind === "partial") {
    const partial = kind === "partial";
    const lead = partial
      ? `تم تسليم ${deliveredOf} فقط في مهمتك «${t}»؛ هذا كل ما وُجد مطابقًا لطلبك في المصادر.`
      : `تم تسليم ${deliveredOf} في مهمتك «${t}»، والملفات جاهزة للتحميل.`;
    const title = partial ? `«${t}» بعدد أقل: ${deliveredOf}` : `«${t}»: تم تسليم ${deliveredOf}`;
    return {
      kind, title, body: `${lead} ${money}`, link: REQUESTS,
      email: {
        subject: partial ? `${t} — تم تسليم ${formatAr(f.delivered)} من ${formatAr(f.planned)} فقط` : `${t} — تم تسليم ${deliveredOf}`,
        preheader: partial ? `${f.chargedPoints > 0 ? `خُصم ${pointsAr(Math.round(f.chargedPoints))} فقط مقابل ما سُلّم` : "لم يُخصم شيء"}، والباقي لم يُحسب عليك.` : `خُصم ${pointsAr(Math.round(f.chargedPoints))} مقابل ما سُلّم فقط، وعاد كامل الحجز المؤقت إليك.`,
        heading: partial ? `اكتملت مهمة «${t}» بعدد أقل من المطلوب` : `ملفات «${t}» جاهزة للتحميل`,
        lead, detail1: money, detail2: "", buttonLabel: "افتح طلبك وحمّل الملفات",
      },
    };
  }
  // failed or unserved: nothing was delivered. When a hold was taken it was released whole.
  const unserved = kind === "unserved";
  const lead = unserved ? `لم نجد مصدرًا يخدم طلبك «${t}» بدقة الآن.` : `تعذّر استكمال مهمتك «${t}».`;
  const detail1 = money;
  const title = unserved ? `لا يمكن تنفيذ «${t}» بدقة الآن` : `تعذّر تنفيذ مهمتك: ${t}`;
  return {
    kind, title, body: `${lead} ${detail1}`, link: REQUESTS,
    email: {
      subject: unserved ? `${t} — لا يمكن تنفيذه بدقة الآن` : `${t} — تعذّر التنفيذ ولم يُخصم شيء`,
      preheader: f.hasJob ? "لم يُخصم منك شيء، وعاد الحجز المؤقت كاملًا." : "لم يُحجز أي رصيد منك ولم يُخصم شيء.",
      heading: unserved ? `لا يمكن تنفيذ «${t}» بدقة الآن` : `لم تكتمل مهمة «${t}»`,
      lead, detail1, detail2: "", buttonLabel: buttonOpen,
    },
  };
}
