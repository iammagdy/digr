export function extractDraftFromQuery(searchStr: string): string | null {
  try {
    const s = searchStr.startsWith("?") ? searchStr : `?${searchStr}`;
    const p = new URLSearchParams(s);
    const d = p.get("draft");
    return d && d.trim() !== "" ? d : null;
  } catch {
    return null;
  }
}
