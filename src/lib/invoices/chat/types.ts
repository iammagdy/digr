/** Shapes shared by the agent's modules. */
export interface ParsedSheet { name: string; /** every non-empty row, cells as text (the header row is still in here) */ rows: string[][]; truncatedColumns: boolean }
export type ParsedFile =
  | { kind: "sheet"; name: string; sheets: ParsedSheet[] }
  | { kind: "image"; name: string; mediaType: "image/png" | "image/jpeg"; bytes: Uint8Array };
export type ParsedSheetFile = Extract<ParsedFile, { kind: "sheet" }>;

export type Role = "company" | "company_en" | "manager" | "email" | "phone" | "sector";
export const ROLES: readonly Role[] = ["company", "company_en", "manager", "email", "phone", "sector"];
export const ROLE_AR: Record<Role, string> = { company: "الشركة", company_en: "اسم الشركة بالإنجليزية", manager: "المدير / جهة الاتصال", email: "البريد الإلكتروني", phone: "الهاتف", sector: "القطاع" };

/** which column (by letter, A, B, …) holds what, for one sheet. `sectorName` is used when the sheet has no sector column. */
export interface SheetMapping { file: string; sheet: string; sectorName: string | null; columns: Partial<Record<Role, string>> }

export interface ColumnProfile {
  col: string;
  /** masked when it looks like data */
  header: string;
  filled: number;
  distinct: number;
  email_share: number;
  phone_share: number;
  number_share: number;
  avg_words: number;
  /** at most 5, masked */
  samples: string[];
}
export interface SheetProfile { sheet: string; rows: number; header_row: number; columns: ColumnProfile[] }
export interface FileProfile { file: string; sheets: SheetProfile[] }

/** One contact row of a company (a person, or a department such as «إدارة المشتريات والعقود»), deduplicated; the owner can move it between the two lists. */
export interface ContactRow { id: string; name: string; company: string; kind: "person" | "department" }

export interface SectorCount {
  sector: string;
  /** distinct companies (an Arabic name or an English name that matches counts once) */
  companies: number;
  /** people: distinct (company, name) contact rows that are not departments */
  managers: number;
  /** departments: contact rows whose name starts with إدارة / قطاع / قسم / Department / Procurement… */
  departments: number;
  /** information only (the owner bills companies and managers): distinct valid e-mails and phone numbers found */
  emails: number;
  phones: number;
  /** company rows that repeated a company already counted (across sheets, files, or inside one sheet) */
  duplicateCompanies: number;
  /** contact rows that repeated the same person of the same company */
  duplicateContacts: number;
  /** e-mail cells with text but no valid address, and phone values with fewer than 7 digits: shown to the owner, never counted */
  invalidEmails: number;
  ignoredPhones: number;
  contacts: ContactRow[];
}
export interface SheetReport {
  file: string;
  sheet: string;
  dataRows: number;
  headerRow: number;
  /** company rows read (a company that has several manager rows is ONE row) */
  companyRows: number;
  /** «overall»: its companies contain those of the other sheets of the file; «detail»: its companies are inside the overall sheet; otherwise «normal» */
  role: "overall" | "detail" | "normal";
  /** the mapping was taken from a sibling sheet with the same headers, not from the model */
  inferred: boolean;
  /** role -> the RAW header text of the mapped column (the owner's own file: shown to the owner, never sent to the model) */
  used: Partial<Record<Role, { col: string; header: string }>>;
  sector: string | null;
}
export interface CountResult { sectors: SectorCount[]; sheets: SheetReport[]; notes: string[]; /** company rows that repeated a company, over all sectors */ duplicateCompanies: number }

/** a sheet nobody mapped: the code never skips it silently */
export interface UnmappedSheet { file: string; sheet: string; rows: number; columns: number; /** «ask»: has real data, the owner decides; «ignored»: too small to hold a list (a cover page, a note) */ status: "ask" | "ignored" }
