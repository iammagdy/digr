import { customerFacingConversationTitle } from "./customerFacingConversationTitle";
import { isChatControlMessage } from "./retryMessage";

export const NEW_CONVERSATION_TITLE_AR = "محادثة جديدة";

/** True for a title that says nothing: empty, or the placeholder every conversation starts with. */
export function isUntitledConversation(title: string | null | undefined): boolean {
  const clean = customerFacingConversationTitle(String(title || ""));
  return !clean || clean === NEW_CONVERSATION_TITLE_AR;
}

/**
 * The title of an old conversation that never got one (its first message was a greeting, a card answer or a button), taken from its FIRST REAL request:
 * the first customer message that is not empty, not a button or approval word, not a stored card payload and not a greeting. Null when there is none.
 */
export function titleFromFirstRequest(messages: ReadonlyArray<{ role: string; content: string; hidden?: boolean }>): string | null {
  for (const message of messages) {
    if (message.role !== "user" || message.hidden) continue;
    const text = String(message.content || "").trim();
    if (!text || text.startsWith("{") || isChatControlMessage(text)) continue;
    const title = customerFacingConversationTitle(text);
    if (title === NEW_CONVERSATION_TITLE_AR || title.split(/\s+/).filter(Boolean).length < 2) continue;
    return title;
  }
  return null;
}
