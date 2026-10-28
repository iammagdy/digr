import { formatAr } from "../arabicDigits";
import { pointsAr } from "../pointsFormat";
import { AGENT_CLOSE_PAGE_LINE_AR } from "./constants";

/**
 * THE NOTICES OF A MISSION, in plain Arabic (an in-site notification and an e-mail through the existing «job-update» template). Pure builders: nothing here sends anything.
 * A notice never names a provider, an endpoint, a file or an id, and never a dollar amount; the figures are points and rows.
 */
export type MissionNoticeKind = "started" | "completed" | "partial" | "failed" | "unserved";

export interface MissionNoticeFacts {
  delivered: number;
  planned: number;
  chargedPoints: number;
  releasedPoints: number;
  /** The job the approval reserved under (none for a mission that never reserved anything). */
  hasJob: boolean;
}

export interface MissionNotice {
  kind: MissionNoticeKind;
  title: string;
  body: string;
  /** In-site link. */
  link: string;
  email: { subject: string; heading: string; lead: string; detail1: string; detail2: string; buttonLabel: string } | null;
}

const rowsAr = (n: number) => (n === 1 ? "صف واحد" : n === 2 ? "صفان" : n >= 3 && n <= 10 ? `${formatAr(n)} صفوف` : `${formatAr(n)} صفًا`);
const REQUESTS = "/dashboard/requests";
const buttonOpen = "افتح طلباتي";

export function buildMissionNotice(kind: MissionNoticeKind, f: MissionNoticeFacts): MissionNotice {
  if (kind === "started") {
    const title = "بدأ تنفيذ مهمتك";
    return { kind, title, body: AGENT_CLOSE_PAGE_LINE_AR, link: REQUESTS, email: null };
  }
  const released = f.releasedPoints > 0 ? `حجز مؤقت مُحرَّر ${pointsAr(Math.round(f.releasedPoints))}.` : "";
  if (kind === "completed" || kind === "partial") {
    const partial = kind === "partial";
    const title = partial ? "اكتملت مهمتك جزئيًا" : "اكتملت مهمتك";
    const lead = partial ? `تم تسليم ${formatAr(f.delivered)} من ${rowsAr(f.planned)} متوقعة، لأن المصادر لم يتوفر فيها عدد أكبر يطابق طلبك.` : `تم تسليم ${rowsAr(f.delivered)} والملفات جاهزة للتحميل.`;
    const detail1 = `خُصم ${pointsAr(Math.round(f.chargedPoints))} مقابل ما سُلّم فقط.`;
    return { kind, title, body: `${lead} ${detail1}${released ? ` ${released}` : ""}`, link: REQUESTS, email: { subject: title, heading: title, lead, detail1, detail2: released, buttonLabel: "تحميل الملفات" } };
  }
  // failed or unserved: nothing was delivered. When a reserve was taken it came back whole.
  const title = kind === "unserved" ? "لا يمكن تنفيذ طلبك بدقة" : "تعذّر تنفيذ مهمتك";
  const lead = kind === "unserved" ? "لم نجد مصدرًا يخدم طلبك بدقة الآن." : "تعذّر استكمال مهمتك.";
  const detail1 = f.hasJob ? (f.releasedPoints > 0 ? `حجز مؤقت مُحرَّر ${pointsAr(Math.round(f.releasedPoints))} كاملًا دون أي خصم.` : "حجز مؤقت مُحرَّر كاملًا دون أي خصم.") : "لم يُحجز أي رصيد ولم يُخصم شيء.";
  return { kind, title, body: `${lead} ${detail1}`, link: REQUESTS, email: { subject: title, heading: title, lead, detail1, detail2: "", buttonLabel: buttonOpen } };
}
