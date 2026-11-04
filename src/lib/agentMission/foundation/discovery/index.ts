import type { TregCatalog } from "../../../treg/catalog";
import type { AccountAccess } from "../../../treg/dataPolicy";
import { SOCIAL_DISCOVERY_SETTING_KEY } from "../../constants";
import { TOOL_CARDS } from "../toolCards";
import type { ToolCard } from "../toolCards/types";
import { discoverCards, type Rejection } from "./deriveCards";
import { validateChain, type ChainIssue } from "./chain";
import { candidateViewOf, parseSelection, selectPrompt, SELECT_SYSTEM, type SelectCapability } from "./plan";

export { discoverCards, deriveCard, type Rejection, type RejectReason } from "./deriveCards";
export { validateChain, rowKeysOf, type ChainIssue } from "./chain";
export { ROLE_RULES, ruleOfCapability } from "./roleGrammar";
export * from "./plan";

/**
 * ROUND 33, CATALOG DISCOVERY: THE SWITCH. One value in `agent_settings` under `social_discovery`, read by the worker once per run. Only the exact value `test` switches it on, and only for a TEST account (owner decision 7.4: a tool no stored real page has verified is for test accounts, inside the
 * 0.20 USD cap). `on`, an unknown or an unreadable value is OFF: no setting can give a tool derived from the catalog to a customer. Promoting such a tool to every account is a DATA change (a hand-written card verified on stored real pages), never this switch.
 */
export const SOCIAL_DISCOVERY_KEY = SOCIAL_DISCOVERY_SETTING_KEY;
export const discoveryActive = (settings: Record<string, unknown> | null | undefined, isTest: boolean): boolean => {
  try { return isTest === true && settings?.[SOCIAL_DISCOVERY_KEY] === "test"; } catch { return false; }
};

/** The cards a mission on `platform` may be built from: the hand-written ones, then the ones derived from the catalog (the hand-written ones always rank first on a tie). */
export function cardsWithDiscovery(catalog: TregCatalog, platform: string, access: AccountAccess): { cards: ToolCard[]; rejected: Rejection[] } {
  const d = discoverCards(catalog, platform, access);
  return { cards: [...TOOL_CARDS, ...d.cards], rejected: d.rejected };
}

/** The catalog check of a chain of cards for this account (the compiler calls it for every derived candidate, before any read). */
export const chainCheckerFor = (catalog: TregCatalog, access: AccountAccess) => (cards: ReadonlyArray<ToolCard>): ChainIssue[] => validateChain(cards, catalog, access);

/** The model's choice among validated candidates: ONE small structured request (a call the worker already has for its other small steps); the answer is accepted only if it names a candidate it was shown. */
export function modelSelector(call: (input: { system: string; user: string; maxTokens: number }) => Promise<{ text: string; costUsd: number } | null>): SelectCapability {
  return async ({ request, topic, candidates }) => {
    const got = await call({ system: SELECT_SYSTEM, user: selectPrompt(request, topic, candidates), maxTokens: 200 });
    if (!got) return null;
    const picked = parseSelection(got.text, candidates);
    return picked ? { ...picked, costUsd: got.costUsd } : { endpointId: "", reason: "", costUsd: got.costUsd };
  };
}
export { candidateViewOf };
