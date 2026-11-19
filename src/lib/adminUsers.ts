/**
 * THE USERS LIST'S CHIPS AND SORT (DT-20261118-06 phase 1B, spec §5.1): one definition, read by the route and the page. No import: safe in the browser.
 */

export type UserSegment = "all" | "active" | "new" | "zero" | "low" | "inactive" | "suspended";
/** «نشط» = signed in during the last 30 days (the tile says «نشطون (٣٠ يومًا)»); «خاملون ٣٠ يومًا» is the rest; «رصيد منخفض» is below the minimum charge of a mission. */
export const USER_SEGMENTS: Array<[UserSegment, string]> = [
  ["all", "الكل"], ["active", "نشط"], ["new", "جديد"], ["zero", "بلا شحن"], ["low", "رصيد منخفض"], ["inactive", "خاملون ٣٠ يومًا"], ["suspended", "موقوفون"],
];

export type UserSort = "access" | "balance" | "topups" | "registered";
export const USER_SORTS: Array<[UserSort, string]> = [["access", "آخر دخول"], ["balance", "الرصيد"], ["topups", "إجمالي الشحن"], ["registered", "تاريخ التسجيل"]];

export const USERS_PAGE_SIZE = 25;
export const USERS_PAGE_SIZE_PHONE = 20;
/** The list reads at most this many accounts (newest first) to sort and segment them; more sets `scanLimited`. */
export const USERS_SCAN_CAP = 2000;
export const USERS_SCAN_LIMITED_AR = "النتائج من أحدث ٢٠٠٠ حساب";
export const ACTIVE_DAYS = 30;
export const NEW_DAYS = 7;

export const parseUserSegment = (raw: string | null | undefined): UserSegment => USER_SEGMENTS.find(([id]) => id === raw)?.[0] ?? "all";
export const parseUserSort = (raw: string | null | undefined): UserSort => USER_SORTS.find(([id]) => id === raw)?.[0] ?? "access";
/** 25 rows; a phone may ask for 20. */
export const parseUsersPageSize = (raw: string | null | undefined): number => (raw === String(USERS_PAGE_SIZE_PHONE) ? USERS_PAGE_SIZE_PHONE : USERS_PAGE_SIZE);
