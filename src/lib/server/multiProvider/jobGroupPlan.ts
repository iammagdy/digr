import { reserveForUnits } from "../../recordPricing";
import { withTimeout, TIMED_OUT } from "./jobGroupShared";

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

export async function hasJobGroupRpc(admin: any): Promise<boolean> {
  try {
    if (typeof admin?.rpc !== "function") {
      return false;
    }
    const probeId = "__diger_group_probe_" + Math.random().toString(16).slice(2);
    const res: any = await withTimeout(
      admin.rpc("accept_group_quote_atomic", {
        p_quote_id: probeId,
        p_user_id: "00000000-0000-0000-0000-000000000000",
        p_expected_quote_hash: "probe",
        p_points_cap: 1,
        p_start_event_ar: "probe",
      }),
      4_000
    );
    if (res === TIMED_OUT || res?.error) {
      return false;
    }
    const data = res?.data;
    return (
      typeof data === "object" &&
      data !== null &&
      data.success === false &&
      data.error === "quote_not_found"
    );
  } catch {
    return false;
  }
}
