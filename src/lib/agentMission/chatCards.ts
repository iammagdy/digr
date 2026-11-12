/**
 * MULTI-OBJECTIVE RESEARCH, THE CHAT PAGE (docs/MULTI-OBJECTIVE-RESEARCH.md section 8): how the cards of a multi-part request become messages, the same way after the answer and after a reload.
 *   - after the answer: the summary message draws no card when the server says so (`agentMission` absent), and each part's card is its own message with the id of its STORED row;
 *   - after a reload: every stored assistant row whose plan names a mission draws that mission's card (the summary row names none);
 *   - a card already on the page (the same stored row: a repeated or concurrent answer) is never appended twice.
 * Pure (no React, no network): the page and the tests use the same functions.
 */
const MISSION_ID = /^msn_[a-z0-9]{8,40}$/;

export interface PartCardMessage { id: string; role: "assistant"; content: string; agentMissionId: string; createdAt: string }

/** The part cards of a chat answer (`agentMissionParts`), as page messages; anything malformed is left out. */
export function partCardMessagesOf(parts: unknown, nowIso: string): PartCardMessage[] {
  if (!Array.isArray(parts)) return [];
  return parts
    .filter((p: any) => typeof p?.id === "string" && MISSION_ID.test(p.id) && typeof p?.messageId === "string" && p.messageId !== "")
    .map((p: any) => ({ id: p.messageId, role: "assistant" as const, content: String(p.contentAr ?? ""), agentMissionId: p.id, createdAt: nowIso }));
}

/** The mission a stored assistant row draws (its card), or null: the summary of a multi-part request draws none. */
export function storedCardMissionOf(plan: unknown): string | null {
  const id = (plan as { agentMissionId?: unknown } | null | undefined)?.agentMissionId;
  return typeof id === "string" && MISSION_ID.test(id) ? id : null;
}

/** `prev` with the messages of `next` whose id is not on the page yet (in order). */
export function appendNewMessages<T extends { id: string }>(prev: T[], next: T[]): T[] {
  const seen = new Set(prev.map((m) => m.id));
  const out = [...prev];
  for (const m of next) if (!seen.has(m.id)) { seen.add(m.id); out.push(m); }
  return out;
}
