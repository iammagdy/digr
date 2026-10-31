import { formatAr, toArabicDigits } from "../arabicDigits";
import { customerSafeText } from "./text";
import { AGENT_CLOSE_PAGE_NO_EMAIL_LINE_AR } from "./constants";
import { deliveredOfAr, GENERIC_ITEM_NOUN, itemNounOf, knownItemNoun } from "./itemNoun";
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
  /** «internal»: nothing was delivered because of OUR failure (the source gave items and our own mapping stored none): the notice says so, never «no source found». */
  cause?: "internal" | "empty";
  /** Why fewer items than requested were delivered, as the run recorded it («لأن المصدر لم يعد يعطي نتائج أخرى لهذا الطلب»): a partial notice states it instead of the general sentence. */
  shortfallClauseAr?: string;
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
  const t = customerSafeText(String(titleIn ?? "").replace(/[«»]/g, "").trim(), "مهمتك") || "مهمتك";
  // the noun the mission was settled with (a plan whose stages name different things, posts and their comments, says «عنصر»: the panel says the same)
  const noun = knownItemNoun(f.noun ?? "") ?? (f.noun === GENERIC_ITEM_NOUN.singular ? GENERIC_ITEM_NOUN : itemNounOf(t));
  const money = moneyLineAr({ reservedPoints: heldPointsOf(f), chargedPoints: f.chargedPoints, delivered: f.delivered, noun });
  const deliveredOf = deliveredOfAr(f.delivered, f.planned, noun);
  if (kind === "completed" || kind === "partial") {
    const partial = kind === "partial";
    const lead = partial
      ? `تم تسليم ${deliveredOf} فقط في مهمتك «${t}»؛ ${f.shortfallClauseAr ? `لم يكتمل العدد المطلوب ${f.shortfallClauseAr}.` : "هذا كل ما وُجد مطابقًا لطلبك في المصادر."}`
      : `تم تسليم ${deliveredOf} في مهمتك «${t}»، والملفات جاهزة للتحميل.`;
    const title = partial ? `«${t}» بعدد أقل: ${deliveredOf}` : `«${t}»: تم تسليم ${deliveredOf}`;
    return {
      kind, title, body: `${lead} ${money}.`, link: REQUESTS,
      email: {
        subject: partial ? `${t} — تم تسليم ${formatAr(f.delivered)} من ${formatAr(f.planned)} فقط` : `${t} — تم تسليم ${deliveredOf}`,
        preheader: money,
        heading: partial ? `اكتملت مهمة «${t}» بعدد أقل من المطلوب` : `ملفات «${t}» جاهزة للتحميل`,
        lead, detail1: money, detail2: "", buttonLabel: "افتح طلبك وحمّل الملفات",
      },
    };
  }
  // failed or unserved: nothing was delivered. When a hold was taken it was released whole. FOUR WORDINGS, one per truth, and in each the subject, the heading and the lead say DIFFERENT things (the old text said the same sentence in the
  // heading, the lead and the subject, and told the customer «no source serves your request» for our own failures):
  //   ours       a fault of ours stopped the run before anything was delivered (the sources were not the problem);
  //   empty      we searched the sources and nothing matched;
  //   no source  no source serves this kind of request with the accuracy it needs, so nothing was started;
  //   stopped    the run stopped before it finished, for a reason we do not name.
  const unserved = kind === "unserved";
  const ourFault = f.cause === "internal";
  const wording = ourFault
    ? { subject: `${t}: خلل من جانبنا ولم يُخصم شيء`, heading: `توقفت مهمة «${t}» قبل أن تُسلَّم`, lead: `تعذّر تنفيذ مهمتك «${t}» بسبب خلل من جانبنا، وليس لأن المصادر خالية من النتائج؛ لم نسلّمك شيئًا وأبلغنا فريقنا ليصلحه. يمكنك إعادة إرسال الطلب بعد قليل.`, title: `«${t}»: خلل من جانبنا` }
    : unserved && f.cause === "empty"
      ? { subject: `${t}: لا نتائج مطابقة`, heading: `لم نجد ما يطابق «${t}»`, lead: `بحثنا في المصادر المتاحة عن «${t}» ولم نجد نتائج تطابق طلبك بالدقة المطلوبة، فلم نسلّم شيئًا. جرّب تغيير الصياغة أو توسيع الطلب.`, title: `«${t}»: لا نتائج مطابقة` }
      : unserved
        ? { subject: `${t}: لا يوجد مصدر يخدمه`, heading: `«${t}» خارج مصادرنا الآن`, lead: `لا يوجد بين مصادرنا ما يخدم طلبك «${t}» بالدقة التي يحتاجها، لذلك لم نبدأ تنفيذه. يمكنك تعديل الطلب أو كتابته بصيغة أخرى.`, title: `«${t}»: خارج مصادرنا الآن` }
        : { subject: `${t}: توقفت قبل نهايتها ولم يُخصم شيء`, heading: `لم نصل إلى نتيجة في «${t}»`, lead: `توقف تنفيذ مهمتك «${t}» قبل أن يكتمل ولم نسلّمك شيئًا. يمكنك إعادة المحاولة بعد قليل.`, title: `«${t}»: لم تكتمل المهمة` };
  const detail1 = money;
  return {
    kind, title: wording.title, body: `${wording.lead} ${detail1}.`, link: REQUESTS,
    email: {
      subject: wording.subject,
      preheader: f.hasJob ? "لم يُخصم منك شيء، وعاد الحجز المؤقت كاملًا." : "لم يُحجز أي رصيد منك ولم يُخصم شيء.",
      heading: wording.heading,
      lead: wording.lead, detail1, detail2: "", buttonLabel: buttonOpen,
    },
  };
}
