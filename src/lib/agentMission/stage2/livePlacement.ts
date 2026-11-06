/**
 * LAUNCH ROUND: WHERE THE LIVE SHEET IS DRAWN IN A CONVERSATION. A mission can be drawn by more than one message of the same conversation (the request, then the answer to its question);
 * the live sheet goes under the LAST card of that mission only, so the conversation shows ONE sheet and asks the live route through ONE loop per mission. Pure.
 */
const computed = new WeakMap<object, ReadonlySet<string>>();
/** Computed once per message list (the chat asks it for every mission card of a render). */
export function lastMissionMessageIds(messages: ReadonlyArray<{ id: string; agentMissionId?: string }>): ReadonlySet<string> {
  const known = computed.get(messages);
  if (known) return known;
  const last = new Map<string, string>();
  for (const m of messages) if (typeof m.agentMissionId === "string" && m.agentMissionId) last.set(m.agentMissionId, m.id);
  const ids: ReadonlySet<string> = new Set(last.values());
  computed.set(messages, ids);
  return ids;
}
