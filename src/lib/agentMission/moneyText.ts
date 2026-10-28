import { pointsAr } from "../pointsFormat";

/**
 * THE MONEY OF A MISSION IN WORDS, the same three facts the wallet shows, with the same numbers: the hold taken at approval («حجز مؤقت»), what was charged for what was delivered («خصم التسليم»), and the hold released at the end
 * («حجز مؤقت مُحرَّر»). The settlement releases the WHOLE hold and then charges the delivered part, so the released number is the hold itself (the ledger of the live mission of 2026-10-28: reserve -279, charge -202, release +279).
 * A net «what came back» number appears in no text, because it appears in no wallet row. Used by the card, the panel, the notification and the e-mail.
 */
export interface MoneyFacts {
  /** The points held at approval. 0 or absent: nothing was ever held. */
  reservedPoints: number;
  chargedPoints: number;
}

/** The held points of a notice: the explicit hold, else what was charged plus what came back (the older shape of the facts). */
export const heldPointsOf = (f: { reservedPoints?: number; chargedPoints: number; releasedPoints?: number }): number => Math.max(0, Math.round(f.reservedPoints ?? f.chargedPoints + (f.releasedPoints ?? 0)));

/** «حُجز مؤقتًا ٢٧٩ نقطة، وخُصم ٢٠٢ نقطة مقابل ما سُلّم، وحجز مؤقت مُحرَّر ٢٧٩ نقطة.»; with nothing charged: «… ولم يُخصم شيء …»; with nothing held: «لم يُحجز أي رصيد ولم يُخصم شيء.» */
export function moneyLineAr(f: MoneyFacts): string {
  const held = Math.max(0, Math.round(f.reservedPoints));
  const charged = Math.max(0, Math.round(f.chargedPoints));
  if (held <= 0) return "لم يُحجز أي رصيد ولم يُخصم شيء.";
  const middle = charged > 0 ? `وخُصم ${pointsAr(charged)} مقابل ما سُلّم` : "ولم يُخصم شيء";
  return `حُجز مؤقتًا ${pointsAr(held)}، ${middle}، وحجز مؤقت مُحرَّر ${pointsAr(held)}.`;
}
