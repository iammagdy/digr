/**
 * THE decision-makers columns: one list, read by the workbook («بيانات المهنيين») and by the results screen, so a person is described by the same
 * titles in the same order in both. Adding, renaming or reordering a column is done here and nowhere else.
 *
 * A row of a decision-makers file is a PERSON: the company columns (name, website, industry, description) describe the person's EMPLOYER. The
 * description is the company's, never the person's own profile text.
 */
export interface PeopleColumn {
  key: string;
  titleAr: string;
  /** Workbook column width. */
  width: number;
}

export const PEOPLE_COLUMNS: readonly PeopleColumn[] = [
  { key: "contact_name", titleAr: "اسم جهة الاتصال", width: 28 },
  { key: "job_title", titleAr: "المسمى الوظيفي", width: 27 },
  { key: "company_name", titleAr: "الشركة", width: 30 },
  { key: "country", titleAr: "الدولة", width: 18 },
  { key: "city", titleAr: "المدينة", width: 20 },
  { key: "work_email", titleAr: "البريد المهني", width: 34 },
  { key: "work_email_verification_status", titleAr: "حالة تحقق البريد المهني", width: 22 },
  { key: "phone", titleAr: "رقم الهاتف", width: 22 },
  { key: "phone_verification_status", titleAr: "حالة تحقق الهاتف", width: 20 },
  { key: "linkedin_url", titleAr: "لينكد إن", width: 34 },
  { key: "website", titleAr: "موقع الشركة", width: 32 },
  { key: "industry", titleAr: "مجال النشاط", width: 28 },
  { key: "description", titleAr: "وصف الشركة", width: 52 },
];

const BY_KEY = new Map(PEOPLE_COLUMNS.map((column) => [column.key, column]));

/** The shared Arabic title of a people column, or undefined for a key the list does not own. */
export function peopleColumnTitleAr(key: string): string | undefined {
  return BY_KEY.get(key)?.titleAr;
}

export const PEOPLE_SCREEN_ORDER: readonly string[] = PEOPLE_COLUMNS.map((column) => column.key);

/** The capability whose rows are people: only a request of this service is shown and written in the people columns (a company row with a contact is not a person row). */
export const PEOPLE_CAPABILITY_SLUG = "professional-people-search";

/** The people columns first, in the shared order; any other column keeps its own order after them. */
export function orderPeopleColumns(columns: readonly string[]): string[] {
  const rank = (key: string) => { const at = PEOPLE_SCREEN_ORDER.indexOf(key); return at >= 0 ? at : 1000; };
  return columns.map((key, index) => ({ key, index })).sort((a, b) => rank(a.key) - rank(b.key) || a.index - b.index).map((entry) => entry.key);
}

const present = (value: unknown): boolean => {
  const text = String(value ?? "").replace(/^'/, "").trim();
  return text !== "" && text !== "غير متاح";
};

/** How many delivered people carry a work email, and how many an office phone (a value the source marked invalid is not one). */
export function peopleContactCounts(
  rows: ReadonlyArray<Record<string, unknown>>,
  delivered: (row: Record<string, unknown>, field: "work_email" | "phone") => boolean = (row, field) => present(row[field]),
): { people: number; withEmail: number; withPhone: number } {
  let withEmail = 0;
  let withPhone = 0;
  for (const row of rows) {
    if (delivered(row, "work_email")) withEmail += 1;
    if (delivered(row, "phone")) withPhone += 1;
  }
  return { people: rows.length, withEmail, withPhone };
}

const AR_DIGITS = "٠١٢٣٤٥٦٧٨٩";
const digitsAr = (value: number): string => String(Math.max(0, Math.floor(value))).replace(/\d/g, (digit) => AR_DIGITS[Number(digit)]);

const peopleAr = (count: number): string => (count === 1 ? "شخص واحد" : count === 2 ? "شخصان" : count >= 3 && count <= 10 ? `${digitsAr(count)} أشخاص` : `${digitsAr(count)} شخصًا`);
/** «واحد منهم له», «اثنان منهم لهم», «٣ منهم لهم». */
const someOfThem = (count: number): string => (count === 1 ? "واحد منهم له" : count === 2 ? "اثنان منهم لهم" : `${digitsAr(count)} منهم لهم`);

/**
 * What a delivered people file holds, said from the counts: how many people, and how many of them carry each contact value. Every delivered
 * person carries at least one of the requested values (a person with none is shown for review and is not delivered), and the fields a person
 * lacks are not charged.
 */
export function peopleDeliverySentenceAr(counts: { people: number; withEmail: number; withPhone: number }, requested?: number): string {
  const { people, withEmail, withPhone } = counts;
  if (people === 0) return "لم يُسلَّم أي شخص";
  const asked = requested && requested > 0 ? ` (المطلوب ${digitsAr(requested)})` : "";
  if (people === 1) {
    return `سُلّم شخص واحد${asked}، ${withEmail > 0 ? "له بريد مهني" : "بلا بريد مهني"} ${withPhone > 0 ? "وله هاتف مكتبي" : "وبلا هاتف مكتبي"}`;
  }
  const email = withEmail === people ? "لكل منهم بريد مهني" : withEmail === 0 ? "بلا بريد مهني لأي منهم" : `${someOfThem(withEmail)} بريد مهني`;
  const phone = withPhone === people ? "ولكل منهم هاتف مكتبي" : withPhone === 0 ? "وبلا هاتف مكتبي لأي منهم" : `و${someOfThem(withPhone)} هاتف مكتبي`;
  return `سُلّم ${peopleAr(people)}${asked}، ${email} ${phone}`;
}

/**
 * Why a decision-makers request delivered fewer people than asked, from what was set aside for review: people with neither contact value, a
 * company outside the requested country, a company with nothing in its name or description about the requested activity. Nothing set aside is charged.
 */
export function peopleShortfallReasonAr(review: { noContact: number; outside: number; noEvidence: number }): string {
  const parts: string[] = [];
  if (review.noContact > 0) parts.push(`${peopleAr(review.noContact)} بلا بريد مهني ولا هاتف مهني`);
  if (review.outside > 0) parts.push(`${peopleAr(review.outside)} ${review.outside === 1 ? "في شركة" : "في شركات"} خارج الدولة المطلوبة`);
  if (review.noEvidence > 0) parts.push(`${peopleAr(review.noEvidence)} ${review.noEvidence === 1 ? "لا يؤكد اسم شركته أو وصفها النشاط المطلوب" : "لا يؤكد اسم شركاتهم أو وصفها النشاط المطلوب"}`);
  if (parts.length === 0) return "لم يتوفر في المصدر عدد أكبر يطابق طلبك.";
  return `وُضع في ورقة المراجعة: ${parts.join("، ")}؛ ولا يُحتسب عليك منهم أحد.`;
}
