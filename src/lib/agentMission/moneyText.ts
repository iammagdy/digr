import { pointsAr } from "../pointsFormat";
import { countAr, type ItemNoun } from "./itemNoun";

/**
 * THE MONEY OF A MISSION IN ONE LINE, the same line on every screen that mentions it (the completion panel, «طلباتي», the notification, the e-mail, the wallet): «خُصم ١٢٨ نقطة مقابل ١٩٢ تغريدة». It says what was charged and for
 * what, with the count of items IN THE FILE the customer received and the noun of the request. The hold and its release are in the wallet's own rows (grouped under this line, with details) and are not repeated in the text:
 * the old three-part sentence made a customer read three numbers to find the one that mattered. With nothing delivered the line says so and that the hold was released («حجز مؤقت مُحرَّر»), the only wording for a release.
 * No full stop: a sentence that holds it adds its own.
 */
export interface MoneyFacts {
  /** The points held at approval. 0 or absent: nothing was ever held. */
  reservedPoints: number;
  chargedPoints: number;
  /** The items in the delivered file (the count the charge was made on). */
  delivered: number;
  noun: ItemNoun;
  /** A free re-run by the Diger team (freeRerun.ts): whatever the settlement charged is given back, so the line says nothing was paid. */
  free?: boolean;
}

/** The money line of a free re-run: the same on the panel, the notification and the e-mail. */
export const FREE_RERUN_MONEY_LINE_AR = "هذه المهمة مجانية من فريق ديجر، ولم يُخصم منك شيء";

/** The held points of a notice: the explicit hold, else what was charged plus what came back (the older shape of the facts). */
export const heldPointsOf = (f: { reservedPoints?: number; chargedPoints: number; releasedPoints?: number }): number => Math.max(0, Math.round(f.reservedPoints ?? f.chargedPoints + (f.releasedPoints ?? 0)));

export function moneyLineAr(f: MoneyFacts): string {
  if (f.free) return FREE_RERUN_MONEY_LINE_AR;
  const held = Math.max(0, Math.round(f.reservedPoints));
  const charged = Math.max(0, Math.round(f.chargedPoints));
  if (charged > 0) return `خُصم ${pointsAr(charged)} مقابل ${countAr(f.delivered, f.noun)}`;
  if (held <= 0) return "لم يُحجز أي رصيد ولم يُخصم شيء";
  return `لم يُخصم شيء؛ حجز مؤقت مُحرَّر ${pointsAr(held)}`;
}
