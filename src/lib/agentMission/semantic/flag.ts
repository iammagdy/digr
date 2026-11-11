import { AGENT_SETTINGS_TABLE } from "../constants";
import { interpretRequest, type SemanticInterpretation } from "./interpret";

/**
 * PR-1.1: THE SWITCH of the semantic layer, and the only door to it. Server-controlled and OFF by default, in the same place and with the same discipline as the redesign flags (`redesignFlagTypes.ts`): one value in the `agent_settings` settings object the
 * worker already reads (`store.readSettings()`), under the key below. This module only READS an object it is handed: it writes no setting, reads no environment variable, touches no database, and nothing in the product calls it today.
 *
 * ON means exactly the boolean `true` or the string `"on"`. Anything else (missing, null, `false`, `"off"`, `"ON "`, a number, an object, an unreadable settings value) is OFF: a broken or mistyped setting can never turn the layer on.
 *
 * INTEGRATION (PR-1.2): `buildRequestContract(request, answer, { semantic })` in `requestContract.ts` is the one place the reading joins the contract, FILL-ONLY (`contractFill.ts`). The caller passes the boolean it read from the trusted settings: the worker's planning run
 * (`runMission.ts`, once per run, handed on to the compiler) and the «فهمنا طلبك» card of the server (`askEditAction.ts`, through `readSemanticFlagFromClient`). The same key and the same reader on both sides, so they cannot disagree. Nobody reads it from the customer.
 * With the flag OFF nothing in the reading runs and the parser behaves exactly as before.
 */
export const SEMANTIC_NORMALIZATION_FLAG_KEY = "semantic_normalization_v1";

export function readSemanticNormalizationFlag(settings: Record<string, unknown> | null | undefined): boolean {
  try {
    const value = settings ? settings[SEMANTIC_NORMALIZATION_FLAG_KEY] : undefined;
    return value === true || value === "on";
  } catch {
    return false;
  }
}

/** The semantic reading when the flag is ON, and null (nothing computed) when it is OFF. */
export function interpretIfEnabled(settings: Record<string, unknown> | null | undefined, text: string): SemanticInterpretation | null {
  return readSemanticNormalizationFlag(settings) ? interpretRequest(text) : null;
}

/** The flag as the SERVER reads it from `agent_settings` (service-role client, the same row the worker reads). Any failure or a missing row is OFF. */
export async function readSemanticNormalizationFlagFromClient(client: any): Promise<boolean> {
  try {
    const { data, error } = await client.from(AGENT_SETTINGS_TABLE).select("value").eq("key", SEMANTIC_NORMALIZATION_FLAG_KEY).maybeSingle();
    if (error || !data) return false;
    return readSemanticNormalizationFlag({ [SEMANTIC_NORMALIZATION_FLAG_KEY]: (data as { value?: unknown }).value });
  } catch {
    return false;
  }
}
