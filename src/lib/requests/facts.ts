/**
 * THE BASIC FACTS of a request, handed from the list to its details page so the page can show them at once (no wait for the database): the title, the state, the date, what was delivered of what was
 * asked, and the points. They are only a head start: the details page reads the request again and replaces them with what it reads. Kept in the browser's session storage; a missing or unreadable entry
 * simply means the page shows a skeleton until its own read arrives.
 */
export interface RequestFacts {
  id: string;
  title: string;
  /** The state chip's words («مكتمل», «قيد التنفيذ», …). */
  stateAr: string;
  createdAt: string;
  /** The noun of the items («تغريدات») and what was delivered / asked; null when unknown. */
  nounPlural: string | null;
  delivered: number | null;
  requested: number | null;
  /** The points line of the row («محجوز» or the charge in words). */
  pointsAr: string | null;
}

const key = (id: string) => `diger_request_facts_${id}`;

export function saveRequestFacts(facts: RequestFacts): void {
  try { sessionStorage.setItem(key(facts.id), JSON.stringify(facts)); } catch { /* the page then shows a skeleton */ }
}

export function readRequestFacts(id: string): RequestFacts | null {
  try {
    const raw = sessionStorage.getItem(key(id));
    if (!raw) return null;
    const v = JSON.parse(raw);
    return v && typeof v === "object" && v.id === id && typeof v.title === "string" ? (v as RequestFacts) : null;
  } catch { return null; }
}

/** An id that may be put in a database filter: letters, digits, dash and underscore, of a sane length. */
export const isSafeRequestId = (id: string): boolean => /^[A-Za-z0-9_-]{6,100}$/.test(id);
