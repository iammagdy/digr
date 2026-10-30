import type { ResultFormat } from "../producedFormats";

/**
 * THE FILE BUTTONS A CUSTOMER GETS ON A REQUEST OF «طلباتي»: the Excel, alone. The CSV copy is still produced and stored with every delivered request (the worker saves its path as the job's result file, settlement records it and the
 * close-out counts the delivered items from it a second time); only its button is not offered here. A request that has no Excel at all keeps one button of what it has, so nobody loses their file.
 */
export function customerFormatsOf(available: readonly ResultFormat[]): ResultFormat[] {
  if (available.includes("xlsx")) return ["xlsx"];
  return available.slice(0, 1);
}
