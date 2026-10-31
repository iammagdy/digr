/** Shapes shared by the invoice screens, the routes and the sheet. Money fields are INTEGERS in the units documented in money.ts. */

/** «statement» = «بيان بيانات»: sectors and counts only, no prices and no totals; it can be sent or voided, never paid. */
export type DocType = "quote" | "invoice" | "statement";
export type DocStatus = "draft" | "sent" | "paid" | "void";
export type Currency = "usd" | "points" | "egp";
export type DiscountKind = "none" | "amount" | "percent";

export interface BatchInput { key: string; title: string; summaryOnly: boolean }

export interface LineInput {
  key: string;
  batchKey: string | null;
  itemTypeId: string | null;
  itemTypeName: string;
  description: string;
  quantity: number;
  /** hundredths of a US cent */
  unitCc: number;
  hidden: boolean;
  /** only on an issued document: the values frozen when it was issued */
  frozenPoints?: number | null;
  frozenEgp?: number | null;
}

/** One amount in the three currencies. points / egp are null when no rate is set. */
export interface Money { usd: number; points: number | null; egp: number | null }

export interface Totals {
  lines: Money[];
  subtotal: Money;
  discount: Money;
  afterDiscount: Money;
  tax: Money;
  total: Money;
}

export interface PricingInput {
  rateE4: number | null;
  creditValueE4: number;
  discountKind: DiscountKind;
  /** USD cents for «amount», basis points for «percent» */
  discountValue: number;
  taxEnabled: boolean;
  taxLabel: string;
  taxBp: number;
}

export interface ClientBlock { id: string | null; company: string; contact: string; email: string; phone: string; address: string }

/** A whole document as the screens and the sheet see it. */
export interface DocView extends PricingInput {
  id: string | null;
  docType: DocType;
  /** «» until the first save: the database assigns it */
  number: string;
  status: DocStatus;
  revision: number;
  client: ClientBlock;
  issueDate: string;
  dueDate: string | null;
  show: { usd: boolean; points: boolean; egp: boolean };
  notes: string;
  paymentInstructions: string;
  instapayAddress: string;
  showInstapayQr: boolean;
  paidAt: string | null;
  paymentReference: string;
  convertedFromId: string | null;
  duplicatedFromId: string | null;
  lockedAt: string | null;
  batches: BatchInput[];
  lines: LineInput[];
  /** the totals frozen at issue (null while a draft) */
  frozen: Totals | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface SellerBlock { name: string; email: string; website: string; taxNumber: string; commercialRegister: string }

export interface StatusEvent { id: number; fromStatus: DocStatus | null; toStatus: DocStatus; adminId: string; note: string; paidAt: string | null; paymentReference: string; createdAt: string }

export interface ListItem {
  id: string; docType: DocType; number: string; status: DocStatus; clientCompany: string;
  issueDate: string; dueDate: string | null; totalUsd: number; totalPoints: number | null; totalEgp: number | null;
  show: { usd: boolean; points: boolean; egp: boolean }; updatedAt: string;
}
