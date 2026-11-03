import type { SocialPlatform } from "../../redesignFlagTypes";
import { TIKTOK_CARDS } from "./tiktok";
import type { CardRole, ToolCard } from "./types";
import { X_CARDS } from "./x";

export type { CardRole, CardStatus, ToolCard } from "./types";
export { cardMapCode, mapPage, COUNTRY_AR, CHILD_COLUMNS } from "./mapCode";

/**
 * OWNER DECISION 7.4 (docs/FOUNDATION-PLAN.md): a `catalog_only` card (a tool no stored real page has verified) may be used by TEST accounts only, and the calls made with such cards cost at most
 * this much per mission (the catalog's price of a successful call; the stage that uses one is given `max_pages` = floor(cap / price)).
 */
export const CATALOG_ONLY_CAP_USD = 0.1;

/** Every tool card (data). PR 2a: TikTok and X. Facebook, Instagram and YouTube cards are PR 3. */
export const TOOL_CARDS: ReadonlyArray<ToolCard> = [...TIKTOK_CARDS, ...X_CARDS];

export const cardOf = (endpointId: string, cards: ReadonlyArray<ToolCard> = TOOL_CARDS): ToolCard | null => cards.find((c) => c.endpointId === endpointId) ?? null;

/** The cards of a platform and role that the compiler may use: verified ones (and `catalog_only` ones only when the caller allows them: test accounts, decision 7.4). Never a broken one. */
export function cardsFor(platform: SocialPlatform, role: CardRole, options: { catalogOnly?: boolean; cards?: ReadonlyArray<ToolCard> } = {}): ToolCard[] {
  return (options.cards ?? TOOL_CARDS).filter((c) => c.platform === platform && c.role === role && (c.status === "verified" || (c.status === "catalog_only" && options.catalogOnly === true)));
}
