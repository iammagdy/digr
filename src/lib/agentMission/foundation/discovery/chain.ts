import { isSellable, type TregCatalog } from "../../../treg/catalog";
import { blockedEndpointReason } from "../../../treg/blockList";
import { policyVerdict, type AccountAccess } from "../../../treg/dataPolicy";
import type { ToolCard } from "../toolCards/types";

/**
 * ROUND 33, CATALOG DISCOVERY: THE CHAIN VALIDATION. Before a plan is shown, the cards it would run (parents, then comments, then replies) are checked against the catalog and against each other. A chain that fails is REJECTED here (the compiler tries the next candidate or says honestly that
 * no source can serve the request): an identifier one tool gives and the next tool cannot take is never discovered at execution, after the customer's points were reserved. Pure: reads the catalog, calls nothing.
 */
export type ChainIssue =
  | { code: "not_sellable" | "blocked" | "sensitive" | "unknown_endpoint"; endpointId: string }
  | { code: "input_not_declared"; endpointId: string; input: string }
  | { code: "parent_key_missing"; parent: string; child: string; key: string }
  | { code: "other_platform"; endpointId: string };

/** The row keys a parent card's mapping fills (what the next stage may bind to). */
export function rowKeysOf(card: ToolCard): string[] {
  if (card.mapping.kind === "fields") return [...Object.keys(card.mapping.fields), ...(card.mapping.linkTemplate ? ["link"] : [])];
  // a comments or replies card's rows: the code-built mapping fills the comment's id and the tokens the card keeps
  return ["id", "text", "author", "posted_at", "likes", "replies_count", "language", ...((card.mapping.tokens ?? []).map((t) => t.key))];
}

/** The inputs the card sends, by name. */
const inputNamesOf = (card: ToolCard): string[] => [
  ...(card.inputs.query ? [card.inputs.query.field] : []),
  ...(card.inputs.period ? [card.inputs.period.from, card.inputs.period.to] : []),
  ...(card.inputs.source ? [card.inputs.source.param] : []),
  ...(card.inputs.country ? [card.inputs.country.field] : []),
  ...(card.inputs.cursor ? [card.inputs.cursor] : []),
  ...(card.inputs.parent ? [card.inputs.parent.param, ...((card.inputs.parent.also ?? []).map((a) => a.param))] : []),
  ...Object.keys(card.inputs.fixed ?? {}),
];

/**
 * Validates a chain of cards, parents first. `rows` for each stage is what the previous stage's mapping fills; a child's `parent.from` (and every `also.from` that is not the grand-parent's) must be among them, and every input a card sends must be declared by its catalog entry
 * (the gateway drops an undeclared input silently, which would send a call without it).
 */
export function validateChain(cards: ReadonlyArray<ToolCard>, catalog: TregCatalog, access: AccountAccess): ChainIssue[] {
  const issues: ChainIssue[] = [];
  const platform = cards[0]?.platform;
  cards.forEach((card, i) => {
    const e = catalog.byId.get(card.endpointId);
    if (!e) { issues.push({ code: "unknown_endpoint", endpointId: card.endpointId }); return; }
    if (card.platform !== platform) issues.push({ code: "other_platform", endpointId: card.endpointId });
    if (!isSellable(card.endpointId, catalog)) issues.push({ code: "not_sellable", endpointId: card.endpointId });
    if (blockedEndpointReason(card.endpointId, e.scope)) issues.push({ code: "blocked", endpointId: card.endpointId });
    if (!policyVerdict(card.endpointId, access).allowed) issues.push({ code: "sensitive", endpointId: card.endpointId });
    const declared = new Set(e.inputs.map((x) => x.name));
    for (const name of inputNamesOf(card)) if (!declared.has(name)) issues.push({ code: "input_not_declared", endpointId: card.endpointId, input: name });
    const parent = i > 0 ? cards[i - 1] : null;
    if (parent && card.inputs.parent) {
      const keys = new Set(rowKeysOf(parent));
      if (!keys.has(card.inputs.parent.from)) issues.push({ code: "parent_key_missing", parent: parent.endpointId, child: card.endpointId, key: card.inputs.parent.from });
      for (const a of card.inputs.parent.also ?? []) if (a.grand !== true && !keys.has(a.from)) issues.push({ code: "parent_key_missing", parent: parent.endpointId, child: card.endpointId, key: a.from });
    }
  });
  return issues;
}
