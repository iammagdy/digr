import { interpretRequest, type SemanticInterpretation } from "./interpret";

/**
 * PR-1.1: THE SWITCH of the semantic layer, and the only door to it. Server-controlled and OFF by default, in the same place and with the same discipline as the redesign flags (`redesignFlagTypes.ts`): one value in the `agent_settings` settings object the
 * worker already reads (`store.readSettings()`), under the key below. This module only READS an object it is handed: it writes no setting, reads no environment variable, touches no database, and nothing in the product calls it today.
 *
 * ON means exactly the boolean `true` or the string `"on"`. Anything else (missing, null, `false`, `"off"`, `"ON "`, a number, an object, an unreadable settings value) is OFF: a broken or mistyped setting can never turn the layer on.
 *
 * INTEGRATION POINT (a later PR, not this one): `buildRequestContract` in `requestContract.ts`, which would receive `interpretIfEnabled(settings, text)` and, only when it is not null, use the reading to fill a field the existing regexes left empty, never to override one
 * they filled and never to overrule the privacy rules. With the flag OFF that function returns null and the parser behaves exactly as before.
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
