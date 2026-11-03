import type { SocialPlatform } from "../../redesignFlagTypes";
import { FACEBOOK_CARDS } from "./facebook";
import { INSTAGRAM_CARDS } from "./instagram";
import { TIKTOK_CARDS } from "./tiktok";
import type { CardRole, ToolCard } from "./types";
import { X_CARDS } from "./x";
import { YOUTUBE_CARDS } from "./youtube";

export type { CardRole, CardStatus, ToolCard } from "./types";
export { cardMapCode, mapPage, COUNTRY_AR, CHILD_COLUMNS } from "./mapCode";

/**
 * OWNER DECISION 7.4 (docs/FOUNDATION-PLAN.md): a `catalog_only` card (a tool no stored real page has verified) may be used by TEST accounts only, and the calls made with such cards cost at most this much per mission.
 * ROUND 8 (owner: at most 0.20 USD a mission): the stage that uses such a card is given `max_pages` = floor(cap / (catalog price x margin)). The margin is 2 because the card now asks for a source that can page (`requireFields`) and the catalog prices that lane no
 * differently from the route's headline price (0.0005 a call; the entry's own note says a backup that bills its native page may cost up to the advertised request price), while the provider's note says it may cost more: sized at twice the catalog's price, 200 pages cost 0.10 USD
 * at the catalog's price and never more than 0.20 USD if a page costs twice that. The provider's daily cap (0.80 USD) stays the outer limit.
 */
export const CATALOG_ONLY_CAP_USD = 0.2;
export const CATALOG_ONLY_PRICE_MARGIN = 2;

/** Every tool card (data). PR 2a: TikTok and X. PR 3: Facebook, Instagram and YouTube (a card is `verified` only on real stored pages; the rest are `catalog_only`, test accounts only). */
export const TOOL_CARDS: ReadonlyArray<ToolCard> = [...TIKTOK_CARDS, ...X_CARDS, ...FACEBOOK_CARDS, ...INSTAGRAM_CARDS, ...YOUTUBE_CARDS];

export const cardOf = (endpointId: string, cards: ReadonlyArray<ToolCard> = TOOL_CARDS): ToolCard | null => cards.find((c) => c.endpointId === endpointId) ?? null;

/** The cards of a platform and role that the compiler may use: verified ones (and `catalog_only` ones only when the caller allows them: test accounts, decision 7.4). Never a broken one. */
export function cardsFor(platform: SocialPlatform, role: CardRole, options: { catalogOnly?: boolean; cards?: ReadonlyArray<ToolCard> } = {}): ToolCard[] {
  return (options.cards ?? TOOL_CARDS).filter((c) => c.platform === platform && c.role === role && (c.status === "verified" || (c.status === "catalog_only" && options.catalogOnly === true)));
}
