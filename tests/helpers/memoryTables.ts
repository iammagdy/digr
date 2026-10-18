import { vi } from "vitest";

/** In-memory tables that honour the equal / orderDesc / limit queries the handler uses for history. */
export function makeTables() {
  const store = new Map<string, Map<string, any>>();
  const table = (name: string) => {
    if (!store.has(name)) store.set(name, new Map());
    return store.get(name)!;
  };
  return {
    async createRow({ tableId, rowId, data }: any) {
      const id = rowId || `row_${Math.random().toString(36).slice(2)}`;
      const doc = { $id: id, ...data };
      table(tableId).set(id, doc);
      return doc;
    },
    async getRow({ tableId, rowId }: any) {
      const doc = table(tableId).get(rowId);
      if (!doc) throw new Error("row not found");
      return doc;
    },
    async listRows({ tableId, queries = [] }: any) {
      let rows = [...table(tableId).values()];
      let limit: number | null = null;
      let desc: string | null = null;
      for (const q of queries as string[]) {
        const eq = /^equal\("([^"]+)",\s*(.*)\)$/.exec(q.trim());
        if (eq) {
          const parsed = JSON.parse(eq[2]);
          const values = (Array.isArray(parsed) ? parsed : [parsed]).map(String);
          rows = rows.filter((row) => values.includes(String(row[eq[1]])));
          continue;
        }
        const ord = /^orderDesc\("([^"]+)"\)$/.exec(q.trim());
        if (ord) desc = ord[1];
        const lim = /^limit\((\d+)\)$/.exec(q.trim());
        if (lim) limit = Number(lim[1]);
      }
      if (desc) rows.sort((a, b) => String(b[desc!]).localeCompare(String(a[desc!])));
      if (limit !== null) rows = rows.slice(0, limit);
      return { total: rows.length, rows };
    },
    async updateRow({ tableId, rowId, data }: any) {
      const prev = table(tableId).get(rowId);
      if (!prev) throw new Error("row not found");
      const doc = { ...prev, ...data };
      table(tableId).set(rowId, doc);
      return doc;
    },
    __rows: (name: string) => [...table(name).values()],
  };
}

