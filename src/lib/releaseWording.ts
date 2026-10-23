import { pointsAr } from "./pointsFormat";

/**
 * The activity line written when a job settles. The ledger records TWO rows at settlement: the WHOLE hold released, then the charge of
 * what was delivered. The line says exactly that (never «the remainder only»), and the net amount that is back in the balance. Never
 * «استرداد»: a released hold is «حجز مؤقت مُحرَّر».
 */
export function settlementEventAr(input: { reservedPoints: number; chargedPoints: number }, digits: (value: string | number) => string): string {
  const reserved = Math.max(0, Math.round(Number(input.reservedPoints) || 0));
  const charged = Math.max(0, Math.min(reserved, Math.round(Number(input.chargedPoints) || 0)));
  const back = reserved - charged;
  if (charged === 0) return `حُرّر الحجز المؤقت كاملًا (${pointsAr(reserved, digits)}) ولم يُخصم أي رصيد.`;
  return `حُرّر الحجز المؤقت كاملًا (${pointsAr(reserved, digits)})، ثم خُصم ثمن ما سُلّم فقط (${pointsAr(charged, digits)})، فيبقى في رصيدك ${pointsAr(back, digits)} من هذا الحجز.`;
}
