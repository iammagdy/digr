/** The accept endpoint is reserved for the explicit approval action in the plan card. */
export function hasExplicitQuoteApproval(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && (value as { explicitApproval?: unknown }).explicitApproval === true);
}
