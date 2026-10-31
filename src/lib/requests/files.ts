import type { ResultFormat } from "../producedFormats";
import { customerResultFormats } from "../customerFiles";

/**
 * THE FILE BUTTONS A CUSTOMER GETS ON A REQUEST OF «طلباتي»: the Excel, alone. The CSV copy is still produced and stored with every delivered request (the worker saves its path as the job's result file, settlement records it and the
 * close-out counts the delivered items from it a second time); only its button is not offered here. A request that has a CSV and no Excel is offered an Excel built from that CSV; one with neither keeps one button of what it has, so nobody loses their file.
 */
export function customerFormatsOf(available: readonly ResultFormat[]): ResultFormat[] {
  // never the CSV: a request that has a CSV is offered the Excel (stored, or built from the CSV when it is asked for), so nobody loses their file
  const offered = customerResultFormats(available);
  if (offered.includes("xlsx")) return ["xlsx"];
  return offered.slice(0, 1);
}
