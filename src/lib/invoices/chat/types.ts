/** Shapes shared by the agent's modules. */
export interface ParsedSheet { name: string; /** every non-empty row, cells as text (the header row is still in here) */ rows: string[][]; truncatedColumns: boolean }
export type ParsedFile =
  | { kind: "sheet"; name: string; sheets: ParsedSheet[] }
  | { kind: "image"; name: string; mediaType: "image/png" | "image/jpeg"; bytes: Uint8Array };
export type ParsedSheetFile = Extract<ParsedFile, { kind: "sheet" }>;

export type Role = "company" | "manager" | "email" | "phone" | "sector";
export const ROLES: readonly Role[] = ["company", "manager", "email", "phone", "sector"];
export const ROLE_AR: Record<Role, string> = { company: "الشركة", manager: "المدير", email: "البريد الإلكتروني", phone: "الهاتف", sector: "القطاع" };

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

export interface SectorCount {
  sector: string;
  companies: number;
  managers: number;
  emails: number;
  phones: number;
  /** e-mail cells with text but no valid address, and phone values with fewer than 7 digits or none: shown to the owner, never counted */
  invalidEmails: number;
  ignoredPhones: number;
}
export interface SheetReport {
  file: string;
  sheet: string;
  dataRows: number;
  headerRow: number;
  /** role -> the RAW header text of the mapped column (the owner's own file: shown to the owner, never sent to the model) */
  used: Partial<Record<Role, { col: string; header: string }>>;
  sector: string | null;
}
export interface CountResult { sectors: SectorCount[]; sheets: SheetReport[]; notes: string[] }
