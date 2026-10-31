import { fmtInt } from "../format";
import type { DocForm } from "../form";
import { parseScaled } from "../money";
import { countText, quickFields, type ItemTypeLite } from "../sectors";
import type { Action, CountKey, Counts } from "./actions";
import { findSector } from "./apply";
import type { CountResult, SectorCount } from "./types";

/**
 * A PROPOSAL is what the agent shows before anything changes: the code's counts from the owner's files, the actions the model chose, and (on a picture) approximate
 * numbers he can edit. It is turned into one list of actions for the one executor (`applyActions`), so imports, rates, prices and a target total share ONE before/after.
 */
export interface ImageRow { sector: string; itemType: CountKey; quantity: string }

/** the counts of the files as `set_counts` actions (a re-import REPLACES a sector's numbers, it never doubles them); only items with a number */
export function importActions(count: CountResult): Action[] {
  return count.sectors.map((s: SectorCount) => {
    const counts: Counts = {};
    if (s.companies > 0) counts.company = s.companies;
    if (s.managers > 0) counts.manager = s.managers;
    if (s.emails > 0) counts.email = s.emails;
    if (s.phones > 0) counts.phone = s.phones;
    return { type: "set_counts", sector: s.sector, counts } as Action;
  }).filter((a) => a.type === "set_counts" && Object.keys(a.counts).length > 0);
}

const NAME: Record<CountKey, string> = { company: "شركة", manager: "مدير", email: "بريد إلكتروني", phone: "رقم هاتف" };
const WORD: Record<CountKey, string> = { company: "الشركات", manager: "المديرين", email: "الإيميلات", phone: "الأرقام" };

/**
 * Approximate (picture) numbers become actions ONLY for cells that are empty in the draft: a number that came from a file, or that the owner typed, is never
 * overwritten and never mixed with an estimate. The cells that were skipped are listed so the owner sees why.
 */
export function approxActions(rows: ImageRow[], form: DocForm, types: ItemTypeLite[]): { actions: Action[]; skipped: string[] } {
  const quick = quickFields(types);
  const bySector = new Map<string, Counts>();
  const skipped: string[] = [];
  for (const r of rows) {
    const q = parseScaled(r.quantity.trim(), 0);
    if (q === null || q < 1) continue;
    const type = quick.find((x) => x.name === NAME[r.itemType])?.type;
    const sector = findSector(form, r.sector);
    if (type && sector) {
      const existing = parseScaled(countText(form, sector.key, type.id), 0);
      if (existing) { skipped.push(`«${sector.title}» ${WORD[r.itemType]}: فيها رقم ${fmtInt(existing)} بالفعل، لم يتغيّر.`); continue; }
    }
    const key = sector?.title ?? r.sector;
    bySector.set(key, { ...(bySector.get(key) ?? {}), [r.itemType]: q });
  }
  return { actions: [...bySector.entries()].map(([sector, counts]) => ({ type: "set_counts", sector, counts }) as Action), skipped };
}
