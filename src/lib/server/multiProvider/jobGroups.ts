export const TICK_BUDGET_MS = 45_000;
export const MIN_LEFT_FOR_CLAIM_MS = 35_000;
export const MAX_CLAIMS_PER_TICK = 10;
export const QUIET_SECONDS = 180;
export const FREEZE_GIVE_UP_MS = 20 * 60_000;
export const OVERDUE_AFTER_MS = (2 * 60 + 15) * 60_000;
export const STOP_AFTER_EMPTY_PARTS = 0;

export type { GroupCloseReason } from "../../multiProvider/copy";

export function buildPartItem(firstItem: any, partIndex: number, groupId: string): any {
  const clone = JSON.parse(JSON.stringify(firstItem));
  const V = firstItem.params?.split?.partVolumes?.[partIndex - 1];
  clone.targetVolumeMax = V;
  clone.targetVolumeMin = Math.min(firstItem.targetVolumeMin ?? 1, V);
  clone.params = {
    ...clone.params,
    split: {
      ...firstItem.params?.split,
      part: partIndex,
      groupId,
    },
  };
  delete clone.params.excludeRowKeys;
  return clone;
}
