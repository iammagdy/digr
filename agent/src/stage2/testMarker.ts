import { STAGE2_TEST_MARKER, anyStage2TestMode } from "../../../src/lib/agentMission/stage2/flags";
import type { AgentStore } from "../types";

/**
 * STAGE 2: the worker marks a TEST account's mission (create-only `stage2/test_account.json`) when some Stage 2 flag says «test», so the site can show the Stage 2 surfaces to test accounts
 * without importing the test-account rule. Nothing is written when the account is not a test account or no flag says «test». Never throws.
 */
export async function markStage2TestAccount(store: Pick<AgentStore, "putNew">, missionId: string, isTest: boolean, env?: Readonly<Record<string, string | undefined>>): Promise<boolean> {
  if (!isTest || !anyStage2TestMode(env)) return false;
  try { await store.putNew(missionId, STAGE2_TEST_MARKER, JSON.stringify({ test: true }), "application/json"); return true; } catch { return false; }
}
