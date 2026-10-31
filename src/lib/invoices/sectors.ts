import { emptyLine, newKey, type DocForm, type LineForm } from "./form";
import { MAX_BATCHES, MAX_LINES, formatScaled, parseScaled } from "./money";

/**
 * The simple builder's «القطاع» (sector) groups. A sector IS a batch: no new storage, no new table. Each sector row has quick number fields
 * (companies, managers, e-mails, phones); a field with a number is one line of that batch, an empty field is no line at all.
 * Prices are never typed here: a new line takes the item type's default sale price, and the total always comes from the one money library.
 */
export const QUICK_TYPE_NAMES = ["شركة", "مدير", "بريد إلكتروني", "رقم هاتف"] as const;
/** The quick fields' labels as the owner says them: «عدد الشركات»… */
export const QUICK_LABELS: Record<string, string> = { "شركة": "الشركات", "مدير": "المديرين", "بريد إلكتروني": "الإيميلات", "رقم هاتف": "أرقام الهاتف" };
/** Suggestions for the sector name box; the owner can type anything. */
export const SECTOR_SUGGESTIONS = ["كهروميكانيكا", "بترول", "مقاولات", "تجارة", "صناعة", "عقارات"];

export interface ItemTypeLite { id: string; nameAr: string; unitCc: number }
export interface QuickField { name: string; label: string; type: ItemTypeLite }

/** The quick fields that exist: the owner's item types with the four known names, in the fixed order. A renamed or archived type simply has no quick field. */
export function quickFields(types: ItemTypeLite[]): QuickField[] {
  const out: QuickField[] = [];
  for (const name of QUICK_TYPE_NAMES) {
    const type = types.find((t) => t.nameAr.trim() === name);
    if (type) out.push({ name, label: QUICK_LABELS[name], type });
  }
  return out;
}

const inGroup = (l: LineForm, batchKey: string | null) => l.batchKey === batchKey;

/** The number typed for this type in this sector (the first line of that type), or «». */
export function countText(form: DocForm, batchKey: string | null, typeId: string): string {
  return form.lines.find((l) => inGroup(l, batchKey) && l.itemTypeId === typeId)?.qty ?? "";
}

/** Sets the number of one type in one sector: a number makes or updates its line (price = the type's default), empty or 0 removes it. Everything else is untouched. */
export function setCount(form: DocForm, batchKey: string | null, type: ItemTypeLite, text: string): DocForm {
  const trimmed = text.trim();
  const at = form.lines.findIndex((l) => inGroup(l, batchKey) && l.itemTypeId === type.id);
  if (trimmed === "" || parseScaled(trimmed, 0) === 0) {
    return at < 0 ? form : { ...form, lines: form.lines.filter((_, i) => i !== at) };
  }
  if (at >= 0) return { ...form, lines: form.lines.map((l, i) => (i === at ? { ...l, qty: trimmed } : l)) };
  if (form.lines.length >= MAX_LINES) return form;
  const line: LineForm = { ...emptyLine(batchKey), itemTypeId: type.id, itemTypeName: type.nameAr, qty: trimmed, unit: formatScaled(type.unitCc, 2) };
  return { ...form, lines: [...form.lines, line] };
}

/** Lines of a sector that the four quick fields cannot show (another item type, a second line of a type, a described line): they stay editable in the sector, never lost. */
export function otherLines(form: DocForm, batchKey: string | null, quick: QuickField[]): LineForm[] {
  const shown = new Set<string>();
  const out: LineForm[] = [];
  for (const l of form.lines) {
    if (!inGroup(l, batchKey)) continue;
    const q = quick.find((f) => f.type.id === l.itemTypeId);
    if (q && !shown.has(q.type.id) && !l.description && !l.hidden) { shown.add(q.type.id); continue; }
    out.push(l);
  }
  return out;
}

export function addSector(form: DocForm, title = ""): DocForm {
  if (form.batches.length >= MAX_BATCHES) return form;
  return { ...form, batches: [...form.batches, { key: newKey("b"), title, summaryOnly: false }] };
}

/** Removes a sector AND its lines (the simple builder has no «lines without a sector» to leave behind). */
export function removeSector(form: DocForm, key: string): DocForm {
  return { ...form, batches: form.batches.filter((b) => b.key !== key), lines: form.lines.filter((l) => l.batchKey !== key) };
}

export function renameSector(form: DocForm, key: string, title: string): DocForm {
  return { ...form, batches: form.batches.map((b) => (b.key === key ? { ...b, title } : b)) };
}

/** Names of the item types a document uses (a number typed) while their price is still 0: their lines add nothing to the total. */
export function zeroPriceNames(form: DocForm): string[] {
  const names: string[] = [];
  for (const l of form.lines) {
    const qty = parseScaled(l.qty, 0);
    if (qty === null || qty < 1) continue;
    const unit = parseScaled(l.unit, 2);
    if (unit === 0) {
      const name = l.itemTypeName.trim() || "بند";
      if (!names.includes(name)) names.push(name);
    }
  }
  return names;
}

/** What the Claude helper may return: sector name, a KNOWN item type, a whole number. Never a price, a total or a currency. */
export interface AssistSector { sector: string; counts: Array<{ itemTypeId: string; itemTypeName: string; quantity: number }> }

/** Adds the helper's result to the form as an editable DRAFT: a new sector per name (or the existing sector of that name), the counts in the quick lines, prices from the item types. Nothing is saved. */
export function applyAssist(form: DocForm, sectors: AssistSector[], types: ItemTypeLite[]): DocForm {
  let next = form;
  for (const s of sectors) {
    let batch = next.batches.find((b) => b.title.trim() === s.sector.trim());
    if (!batch) {
      next = addSector(next, s.sector);
      batch = next.batches[next.batches.length - 1];
    }
    for (const c of s.counts) {
      const type = types.find((t) => t.id === c.itemTypeId);
      if (!type) continue;
      const already = parseScaled(countText(next, batch.key, type.id), 0) ?? 0;
      next = setCount(next, batch.key, type, String(already + c.quantity));
    }
  }
  return next;
}
