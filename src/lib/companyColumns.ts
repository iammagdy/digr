/**
 * THE company columns: one list, read by the workbook («بيانات الشركات») and by the results screen, so the two show the same titles in the same order.
 * Adding, renaming or reordering a column is done here and nowhere else.
 *
 * What this list does NOT claim: that every column is filled. Whether a delivered row carries a field depends on the source; the screen hides a column that
 * is empty in every row (and says which), and the workbook keeps its fixed set so a file always opens with the same shape. Fields the screen can show
 * that are not in this list (a description, a headcount, a founding year) are not added to the workbook until delivered rows are shown to carry them.
 */
export interface CompanyColumn {
  /** The key of the row (the screen reads the row by it; the workbook reads it through `sources`). */
  key: string;
  titleAr: string;
  /** The row fields that can fill it, in priority order. */
  sources: readonly string[];
  /** Workbook column width. */
  width: number;
}

export const COMPANY_COLUMNS: readonly CompanyColumn[] = [
  { key: "id", titleAr: "معرّف السجل", sources: ["company_id", "source_id", "id"], width: 22 },
  { key: "company_name", titleAr: "اسم الشركة", sources: ["company_name", "name", "title"], width: 36 },
  { key: "industry", titleAr: "مجال النشاط", sources: ["industry", "activity", "sector", "category"], width: 32 },
  { key: "website", titleAr: "الموقع الإلكتروني", sources: ["website"], width: 38 },
  { key: "linkedin_url", titleAr: "صفحة لينكد إن", sources: ["linkedin_url", "linkedin"], width: 38 },
  { key: "city", titleAr: "المدينة", sources: ["city"], width: 22 },
  { key: "address", titleAr: "العنوان", sources: ["address", "full_address", "location"], width: 44 },
  { key: "phone", titleAr: "الهاتف التجاري", sources: ["phone", "phone_number", "business_phone"], width: 24 },
  { key: "work_email", titleAr: "البريد المهني", sources: ["work_email", "workEmail", "email"], width: 36 },
  { key: "phone_verification_status", titleAr: "حالة تحقق الهاتف", sources: ["phone_verification_status"], width: 24 },
  { key: "work_email_verification_status", titleAr: "حالة تحقق البريد المهني", sources: ["work_email_verification_status", "email_verification_status"], width: 28 },
];

const BY_KEY = new Map(COMPANY_COLUMNS.map((column) => [column.key, column]));

/** The shared Arabic title of a company column, or undefined for a key the list does not own. */
export function companyColumnTitleAr(key: string): string | undefined {
  return BY_KEY.get(key)?.titleAr;
}

/** The screen's column keys in the shared order (the record id is not shown on screen). */
export const COMPANY_SCREEN_ORDER: readonly string[] = COMPANY_COLUMNS.map((column) => column.key).filter((key) => key !== "id");
