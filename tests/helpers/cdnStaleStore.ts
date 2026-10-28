import { createMemoryStore, type MemoryStore } from "../../agent/src/memoryStore";

/**
 * A STORE WITH THE REAL STORAGE'S READ SEMANTICS. Supabase Storage serves an OVERWRITTEN object from its CDN edge nodes with the OLD content for up to 60 seconds (documented: «we advise against overwriting files ... the CDN will
 * take some time to propagate the changes to all the edge nodes leading to stale content»). The in-memory store of the other tests reads back what was just written, which is why a design that reads, extends and overwrites one object looked
 * correct in every test and lost 115 items in production. This store keeps the previous content of every overwritten path and serves it for the next `staleReads` reads of that path (the window of the CDN, counted in reads); an object that
 * was created and never overwritten (a create-only `putNew`, a new path) is always read back exactly. The listing is the database's and is always exact.
 */
export interface CdnStaleStore extends MemoryStore {
  /** Paths that were overwritten (upserted over an existing object), in order. */
  overwrites: string[];
  /** Reads that were answered with an older version. */
  staleServed: string[];
}

export function createCdnStaleStore(options: { staleReads?: number } = {}): CdnStaleStore {
  const base = createMemoryStore() as CdnStaleStore;
  const previous = new Map<string, string | Buffer>();
  const staleLeft = new Map<string, number>();
  base.overwrites = [];
  base.staleServed = [];
  const putFile = base.putFile.bind(base);
  base.putFile = async (missionId, rel, content, contentType) => {
    const key = `${missionId}/${rel}`;
    if (base.files.has(key)) { previous.set(key, base.files.get(key)!); staleLeft.set(key, options.staleReads ?? 4); base.overwrites.push(key); }
    await putFile(missionId, rel, content, contentType);
  };
  const stale = (missionId: string, rel: string): string | Buffer | null => {
    const key = `${missionId}/${rel}`;
    const left = staleLeft.get(key) ?? 0;
    if (left > 0 && previous.has(key)) { staleLeft.set(key, left - 1); base.staleServed.push(key); return previous.get(key)!; }
    return null;
  };
  const getFile = base.getFile.bind(base);
  const getFileBytes = base.getFileBytes.bind(base);
  base.getFile = async (missionId, rel) => { const v = stale(missionId, rel); return v === null ? getFile(missionId, rel) : typeof v === "string" ? v : v.toString("utf8"); };
  base.getFileBytes = async (missionId, rel) => { const v = stale(missionId, rel); return v === null ? getFileBytes(missionId, rel) : Buffer.isBuffer(v) ? v : Buffer.from(v); };
  return base;
}
