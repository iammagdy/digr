import { AGENT_CAPABILITY_SLUG } from "./agentMission/constants";

export const LEGACY_CHAT_QUOTE_AR = "العرض ده قديم ومبقاش متاح، اكتب طلبك من جديد";

/** The older quote writers also stored wrapped arrays and serialized items. */
export function hasLegacyChatQuoteItem(rawItems: unknown): boolean {
  let items = rawItems;
  if (typeof items === "string") {
    try {
      items = JSON.parse(items);
    } catch {
      return false;
    }
  }
  if (items && typeof items === "object" && "items" in items) items = items.items;
  return Array.isArray(items) && items.some((item) => item?.endpointId !== AGENT_CAPABILITY_SLUG);
}
