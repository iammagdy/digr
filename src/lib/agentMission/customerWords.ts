/**
 * P0 (15 Nov 2026): THE CUSTOMER'S OWN WORDS TRAVEL WITH THE MISSION. The mission row stores only the chat model's one-line summary (`request_text`), and production showed the summary changing the request («… أو … أو …» written
 * «… و … و …»). The chat server therefore stores, with the mission's card (`messages.plan`), the customer's own messages exactly as typed, in two parts:
 *   - `customerWords`: the messages of THIS request (typed after the conversation's previous mission card, this one last);
 *   - `earlierWords`: the customer's messages before that card (context only: a follow-up such as «نفس الموضوع» refers to them; an earlier request on another subject is not part of this one).
 * The worker's research spec and every relevance judgment read them. Written by code only (never by a model, never by the customer's browser); bounded in count and length.
 */
export const CUSTOMER_WORDS_MAX_TURNS = 8;
export const EARLIER_WORDS_MAX_TURNS = 6;
export const CUSTOMER_WORD_MAX_CHARS = 900;

export interface StoredCustomerWords { current: string[]; earlier: string[] }

const clean = (messages: ReadonlyArray<unknown>): string[] =>
  messages.map((m) => String(m ?? "").replace(/\s+/g, " ").trim()).filter((m) => m !== "").map((m) => (m.length > CUSTOMER_WORD_MAX_CHARS ? m.slice(0, CUSTOMER_WORD_MAX_CHARS) : m));

/** The customer's messages to store: the newest `max`, oldest first, each one line and clipped; empty ones dropped. */
export function customerWordsToStore(messages: ReadonlyArray<unknown>, max = CUSTOMER_WORDS_MAX_TURNS): string[] {
  return clean(messages).slice(-max);
}

/**
 * Splits the conversation's recent messages (oldest first, this request's message last) at the previous MISSION card: the customer's messages after it are this request's, the ones before it are earlier context.
 * `messages` are the stored rows (role, content, and the assistant card's plan); the current message is appended by the caller.
 */
export function splitCustomerWords(messages: ReadonlyArray<{ role: string; content: unknown; missionCard?: boolean }>): StoredCustomerWords {
  let boundary = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) if (messages[i].role === "assistant" && messages[i].missionCard) { boundary = i; break; }
  const users = (from: number, to: number) => messages.slice(from, to).filter((m) => m.role === "user").map((m) => m.content);
  return { current: customerWordsToStore(users(boundary + 1, messages.length)), earlier: customerWordsToStore(users(0, Math.max(0, boundary)), EARLIER_WORDS_MAX_TURNS) };
}

/** The stored words read back from a card's plan: null when the card has none (an older card, an admin mission, an answer card). */
export function customerWordsFromPlan(plan: unknown): StoredCustomerWords | null {
  const o = plan && typeof plan === "object" ? (plan as Record<string, unknown>) : null;
  if (!o || !Array.isArray(o.customerWords)) return null;
  const current = customerWordsToStore(o.customerWords.filter((x) => typeof x === "string"));
  if (current.length === 0) return null;
  const earlier = Array.isArray(o.earlierWords) ? customerWordsToStore(o.earlierWords.filter((x) => typeof x === "string"), EARLIER_WORDS_MAX_TURNS) : [];
  return { current, earlier };
}

/** The words of a mission from its cards, newest first: the newest card that HOLDS them (an answer typed in the chat writes a later card of the same mission with no words). */
export function newestCustomerWords(cards: ReadonlyArray<{ plan?: unknown } | null | undefined>): StoredCustomerWords | null {
  for (const c of cards) { const w = customerWordsFromPlan(c?.plan); if (w) return w; }
  return null;
}
