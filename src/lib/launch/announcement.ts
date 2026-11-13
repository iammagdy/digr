
/**
 * The launch announcement's words (Arabic), composed ONLY from features that are live for everyone. The sentences are the approved ones of
 * docs/launch/LAUNCH-EMAIL-AR.md §2. A feature's sentence is included only when its flag(s) say exactly «on» in the given environment:
 * «allowlist», «test», unset or any other word is NOT announced (those customers do not have the feature yet). No price number, no speed claim.
 * Pure: it reads only the environment object it is given. Nothing is sent here.
 */
type Env = Readonly<Record<string, string | undefined>>;

export interface LaunchAnnouncement {
  Name: string;
  Subject: string;
  Heading: string;
  Lead: string;
  Item1: string;
  Item2: string;
  Item3: string;
  Item4: string;
  Item5: string;
  Item6: string;
  ButtonLabel: string;
}

export const ANNOUNCEMENT_MAX_ITEMS = 6;

const SUBJECT_ALL = "جديد في ديجر: جدول حيّ لنتائجك، وتقرير مراجعة، وتعديل ملفك بعد التسليم";
const SUBJECT_LIVE = "تابع بحثك لحظة بلحظة في ديجر";
/** Used when the features that qualify do not fit either approved subject: it names no feature. */
const SUBJECT_GENERIC = "جديد في ديجر: رحلة طلبك صارت أوضح";

const HEADING = "جديد في ديجر";
const LEAD = "أضفنا في ديجر ما يخلّي رحلة طلبك أوضح:";
const BUTTON = "افتح لوحتك";
const FALLBACK_NAME = "عزيزنا العميل";

const LIVE_SHEET = "• جدول حيّ لنتائجك: وإنت منتظر، تشوف النتائج وهي تتجمّع في جدول واحد، وعدّاد واحد واضح «كذا من كذا» على الموبايل.";
const ASK_CARD = "• بطاقة «فهمنا طلبك»: نعرض لك كيف فهمنا طلبك قبل ما نبدأ، وتقدر تعدّل عليه.";
const COMPANIES = "• أبحاث الشركات مع ترتيب الدور: تعرف مكان طلبك في الطابور بوضوح.";
const REVIEW = "• تقرير مراجعة لملفك بعد التسليم: يبيّن لك ما وجدناه في خاناته، والسعر يظهر لك قبل أي حجز، ولا يبدأ إلا بعد اعتمادك.";
const EDITS = "• تعديلات مدعومة على ملفك (مثل إعادة تسمية عمود أو تصحيح خانات محددة): تُسعَّر قبل التنفيذ، وتنفَّذ بعد اعتمادك فقط، وتصلك نسخة جديدة وتبقى نسختك الأصلية كما هي. نعرض لك دائمًا ما يمكن تنفيذه فقط.";
const DOWNLOAD = "• تنزيل النتائج بصيغة إكسل أو CSV، مع ملف «المنهجية» بالعربية الذي يشرح كيف جمعنا بياناتك وحدود التسليم.";
/** True only together with the Stage 4 sentences (release first, charge no more than the hold). */
const MONEY = "لا نحجز نقاطك إلا بعد أن تعتمد السعر الظاهر لك، ولا نخصم إلا ما سُلّم فعلًا.";

/** Which flag-gated features are on for EVERYONE in this environment (exactly «on»). */
export function liveAnnouncementFeatures(env: Env) {
  // Read locally on purpose (the stage isolation guards forbid importing stage modules here): a feature is announced ONLY when its flag is exactly «on» for everyone.
  // Same rule as the flag helpers (case and spaces ignored); «test», «allowlist», unset or any other word does NOT announce.
  const isOn = (n: string) => String(env[n] ?? "").trim().toLowerCase() === "on";
  const on2 = isOn;
  const on3 = isOn;
  const on4 = isOn;
  const approval = on4("DIGER_STAGE4_APPROVAL");
  return {
    liveSheet: on2("DIGER_STAGE2_LIVE_SHEET"),
    askCard: on2("DIGER_STAGE2_ASK_CARD"),
    companies: on3("DIGER_STAGE3_COMPANIES") && on3("DIGER_STAGE3_QUEUE"),
    review: on4("DIGER_STAGE4_REVIEW") && approval,
    edits: on4("DIGER_STAGE4_EDITS") && approval,
  };
}

/**
 * The announcement for this environment, or null when there is nothing to announce: the always-true download sentence alone does not justify
 * a send. Order: the feature sentences, then the money sentence (only with a Stage 4 sentence), then the download sentence only if there is room
 * (at most six paragraphs: the template has six slots). `name` is the greeting's name.
 */
export function composeLaunchAnnouncement(env: Env, name?: string): LaunchAnnouncement | null {
  const f = liveAnnouncementFeatures(env);
  const items: string[] = [];
  if (f.liveSheet) items.push(LIVE_SHEET);
  if (f.askCard) items.push(ASK_CARD);
  if (f.companies) items.push(COMPANIES);
  if (f.review) items.push(REVIEW);
  if (f.edits) items.push(EDITS);
  if (items.length === 0) return null;
  if (f.review || f.edits) items.push(MONEY);
  if (items.length < ANNOUNCEMENT_MAX_ITEMS) items.push(DOWNLOAD);

  const subject = f.liveSheet && f.review && f.edits ? SUBJECT_ALL : f.liveSheet ? SUBJECT_LIVE : SUBJECT_GENERIC;
  const slot = (i: number) => items[i] ?? "";
  return {
    Name: String(name ?? "").trim() || FALLBACK_NAME,
    Subject: subject,
    Heading: HEADING,
    Lead: LEAD,
    Item1: slot(0), Item2: slot(1), Item3: slot(2), Item4: slot(3), Item5: slot(4), Item6: slot(5),
    ButtonLabel: BUTTON,
  };
}
