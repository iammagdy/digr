/**
 * THE company columns: one list, read by the workbook («بيانات الشركات») and by the results screen, so the two show the same titles in the same order.
 * Adding, renaming or reordering a column is done here and nowhere else.
 *
 * What this list does NOT claim: that every column is filled. Whether a delivered row carries a field depends on where it came from:
 *  - rows from the company search service can carry a description, a headcount and a founding year, each only when the source had it;
 *  - rows from the multi-source search carry a description (the snippet of the page) but never a headcount or a founding year.
 * So the three OPTIONAL columns appear (on the screen and in the workbook, by the same rule) only when at least one delivered row has a value, and a
 * column that is empty in every row is never written. The record id and the two verification-status columns are not in the customer workbook:
 * the screen shows the statuses (`screenOnly`) only when a row has one.
 */
export interface CompanyColumn {
  /** The key of the row (the screen reads the row by it; the workbook reads it through `sources`). */
  key: string;
  titleAr: string;
  /** The row fields that can fill it, in priority order. */
  sources: readonly string[];
  /** Workbook column width. */
  width: number;
  /** Shown only when at least one delivered row has a value (screen and workbook alike). */
  optional?: true;
  /** On the screen only: the workbook leaves it out. */
  screenOnly?: true;
}

export const COMPANY_COLUMNS: readonly CompanyColumn[] = [
  { key: "company_name", titleAr: "اسم الشركة", sources: ["company_name", "name", "title"], width: 36 },
  { key: "industry", titleAr: "مجال النشاط", sources: ["industry", "activity", "sector", "category"], width: 32 },
  { key: "website", titleAr: "الموقع الإلكتروني", sources: ["website"], width: 38 },
  { key: "linkedin_url", titleAr: "صفحة لينكد إن", sources: ["linkedin_url", "linkedin"], width: 38 },
  { key: "city", titleAr: "المدينة", sources: ["city"], width: 22 },
  { key: "address", titleAr: "العنوان", sources: ["address", "full_address", "location"], width: 44 },
  { key: "phone", titleAr: "الهاتف التجاري", sources: ["phone", "phone_number", "business_phone"], width: 24 },
  { key: "work_email", titleAr: "البريد المهني", sources: ["work_email", "workEmail", "email"], width: 36 },
  { key: "description", titleAr: "الوصف التعريفي", sources: ["description", "about", "headline", "slogan"], width: 52, optional: true },
  { key: "headcount", titleAr: "حجم العمالة", sources: ["headcount", "numberOfEmployees", "employee_count"], width: 18, optional: true },
  { key: "founded_year", titleAr: "سنة التأسيس", sources: ["founded_year", "foundedYear", "year_founded"], width: 16, optional: true },
  { key: "phone_verification_status", titleAr: "حالة تحقق الهاتف", sources: ["phone_verification_status"], width: 24, screenOnly: true },
  { key: "work_email_verification_status", titleAr: "حالة تحقق البريد المهني", sources: ["work_email_verification_status", "email_verification_status"], width: 28, screenOnly: true },
];

const BY_KEY = new Map(COMPANY_COLUMNS.map((column) => [column.key, column]));

/** The shared Arabic title of a company column, or undefined for a key the list does not own. */
export function companyColumnTitleAr(key: string): string | undefined {
  return BY_KEY.get(key)?.titleAr;
}

/** The screen's column keys in the shared order. */
export const COMPANY_SCREEN_ORDER: readonly string[] = COMPANY_COLUMNS.map((column) => column.key);

const hasValue = (value: unknown): boolean => {
  if (value === undefined || value === null) return false;
  const text = String(value).replace(/^'/, "").trim();
  return text !== "" && text !== "0" && text !== "غير متاح";
};

/** True when at least one row has a value in one of the column's source fields. */
export function companyColumnHasValue(column: CompanyColumn, rows: ReadonlyArray<Record<string, unknown>>): boolean {
  return rows.some((row) => column.sources.some((source) => hasValue(row[source])));
}

/** The columns of the customer workbook for these rows: the shared list without the screen-only columns, and an optional column only when a row has it. */
export function workbookCompanyColumns(rows: ReadonlyArray<Record<string, unknown>>): CompanyColumn[] {
  return COMPANY_COLUMNS.filter((column) => !column.screenOnly && (!column.optional || companyColumnHasValue(column, rows)));
}
