import { formatAr } from "./arabicDigits";
import { pointsAr } from "./pointsFormat";

/**
 * THE GREETING'S NAME AND BALANCE (round 23). Live: «أهلًا codex test، رصيدك المتاح ١١٦٧٦ نقطة»: a Latin name in an Arabic sentence and a balance without its separator. The name is used only when it is written in Arabic letters; otherwise the greeting says «أهلًا بك».
 * The balance is written with the Arabic thousands separator (١١٬٦٧٦). The chat handler's greeting (src/functions/shared/chatHandler.ts) is the one place that builds that sentence; the change it needs is reported with this round.
 */
export function arabicDisplayName(name: unknown): string | null {
  const text = String(name ?? "").replace(/\s+/g, " ").trim();
  if (text === "") return null;
  return /^[ء-يً-ْ\s]+$/.test(text) && /[ء-ي]/.test(text) ? text : null;
}

/** «رصيدك المتاح ١١٬٦٧٦ نقطة. » (with the trailing space the greeting expects), or «» when the balance is unknown. */
export function balanceLineAr(balance: unknown): string {
  const n = Number(balance);
  return Number.isFinite(n) ? `رصيدك المتاح ${pointsAr(Math.max(0, Math.floor(n)), formatAr)}. ` : "";
}
