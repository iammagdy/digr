export const FREEZE_BUDGET_MS = 30_000;
export const FREEZE_IO_TIMEOUT_MS = 5_000;
export const FREEZE_RPC_TIMEOUT_MS = 4_000;

export function freezeCandidates(userId: string, jobId: string): Array<{ bucket: "partials"; path: string }> {
  return [
    { bucket: "partials", path: `${userId}/${jobId}/data.json` },
    { bucket: "partials", path: `${jobId}/data.json` },
  ];
}

export type FreezeOutcome = "frozen" | "retry" | "unfreezable";

export async function freezeGroupPart(
  _admin: any,
  _args: {
    groupId: string;
    partIndex: number;
    job: { id: string; user_id: string; delivered_units: number };
    now?: () => number;
    budgetMs?: number;
  }
): Promise<FreezeOutcome> {
  return "retry";
}
