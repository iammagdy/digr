import { FileSpecSchema, type FileSpec } from "./fileSpec";

/** A custom file offered in a chat message: the spec the download link carries, and what it does, in Arabic. */
export interface MessageFileShape {
  spec: FileSpec;
  descriptionAr: string;
}

/**
 * The custom file kept with an assistant message (in its `plan` column, next to nothing else: a message that offers a custom file
 * has no priced plan). Returns undefined for anything that is not a well-formed custom file, so a stored value can never
 * show a download action the route would refuse; the route still validates the spec against the real columns.
 */
export function persistedFileShape(plan: unknown): MessageFileShape | undefined {
  const stored = (plan as { fileShape?: { spec?: unknown; descriptionAr?: unknown } } | null | undefined)?.fileShape;
  if (!stored || typeof stored.descriptionAr !== "string" || !stored.descriptionAr.trim()) return undefined;
  const parsed = FileSpecSchema.safeParse(stored.spec);
  return parsed.success ? { spec: parsed.data, descriptionAr: stored.descriptionAr } : undefined;
}
