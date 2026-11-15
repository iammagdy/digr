/**
 * P0 (15 Nov 2026): THE CUSTOMER'S OWN WORDS TRAVEL WITH THE MISSION. The mission row stores only the chat model's one-line summary (`request_text`), and production showed the summary changing the request («… أو … أو …» written
 * «… و … و …»). The chat server therefore stores, with the mission's card (`messages.plan.customerWords`), the customer's own messages of the conversation, oldest first, exactly as typed; the worker's research spec and every relevance
 * judgment read them as the authoritative statement of what was asked. Written by code only (never by a model, never by the customer's browser); bounded in count and length.
 */
export const CUSTOMER_WORDS_MAX_TURNS = 8;
export const CUSTOMER_WORD_MAX_CHARS = 900;

/** The customer's messages to store: the newest `CUSTOMER_WORDS_MAX_TURNS`, oldest first, each one line and clipped; empty ones dropped. */
export function customerWordsToStore(messages: ReadonlyArray<unknown>): string[] {
  const out = messages.map((m) => String(m ?? "").replace(/\s+/g, " ").trim()).filter((m) => m !== "").map((m) => (m.length > CUSTOMER_WORD_MAX_CHARS ? m.slice(0, CUSTOMER_WORD_MAX_CHARS) : m));
  return out.slice(-CUSTOMER_WORDS_MAX_TURNS);
}

/** The stored words read back from a card's plan: null when the card has none (an older card, an admin mission). */
export function customerWordsFromPlan(plan: unknown): string[] | null {
  const raw = plan && typeof plan === "object" ? (plan as Record<string, unknown>).customerWords : undefined;
  if (!Array.isArray(raw)) return null;
  const words = customerWordsToStore(raw.filter((x) => typeof x === "string"));
  return words.length > 0 ? words : null;
}
