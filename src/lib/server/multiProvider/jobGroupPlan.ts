import { reserveForUnits } from "../../recordPricing";

export function isGroupQuoteItems(items: unknown): boolean {
  if (!Array.isArray(items) || items.length !== 1) {
    return false;
  }
  const item = items[0];
  return (
    typeof item === "object" &&
    item !== null &&
    (item as any).params?.split?.v === 3
  );
}

export function planSplit(args: {
  X: number;
  V: number;
  unit: number;
  safetyBuffer: number;
}): {
  K: number;
  Y: number;
  partVolumes: number[];
  partReserves: number[];
  hold: number;
} {
  const { X, V, unit, safetyBuffer } = args;
  const Y = Math.min(X, V * 40);
  const K = Math.ceil(Y / V);

  const partVolumes: number[] = [];
  for (let i = 0; i < K - 1; i++) {
    partVolumes.push(V);
  }
  if (K > 0) {
    partVolumes.push(Y - (K - 1) * V);
  }

  const partReserves = partVolumes.map((v) =>
    Math.max(1, reserveForUnits(v, unit, safetyBuffer))
  );
  const hold = partReserves.reduce((a, b) => a + b, 0);

  return { K, Y, partVolumes, partReserves, hold };
}
