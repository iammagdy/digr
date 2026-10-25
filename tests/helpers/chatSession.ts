import { vi } from "vitest";
import { ChatHandler } from "../../src/functions/shared/chatHandler";

/**
 * An in-memory Appwrite-style table store that honours the equal / orderDesc / limit queries the chat handler uses,
 * so several messages in one conversation behave like production (history is replayed newest-first and reversed).
 */
export function createChatDb() {
  const store = new Map<string, any[]>();
  let seq = 0;
  const parse = (queries: string[] = []) => queries.map((q) => { try { return JSON.parse(q); } catch { return null; } }).filter(Boolean);
  const db = {
    store,
    listRows: vi.fn(async ({ tableId, queries }: any) => {
      let rows = [...(store.get(tableId) || [])];
      let limit = 100;
      let desc: string | null = null;
      for (const q of parse(queries)) {
        if (q.method === "equal") rows = rows.filter((r) => q.values.includes(r[q.attribute]));
        if (q.method === "orderDesc") desc = q.attribute;
        if (q.method === "limit") limit = q.values[0];
      }
      if (desc) rows.sort((a, b) => (b._seq ?? 0) - (a._seq ?? 0));
      return { rows: rows.slice(0, limit), total: rows.length };
    }),
    createRow: vi.fn(async ({ tableId, rowId, data }: any) => {
      const rows = store.get(tableId) || [];
      const record = { $id: rowId, id: rowId, ...data, createdAt: data.createdAt || new Date().toISOString(), _seq: ++seq };
      rows.push(record);
      store.set(tableId, rows);
      return record;
    }),
    updateRow: vi.fn(async ({ tableId, rowId, data }: any) => {
      const rows = store.get(tableId) || [];
      const idx = rows.findIndex((r) => r.$id === rowId || r.id === rowId);
      if (idx >= 0) { rows[idx] = { ...rows[idx], ...data }; return rows[idx]; }
      const record = { $id: rowId, id: rowId, ...data, _seq: ++seq };
      rows.push(record);
      store.set(tableId, rows);
      return record;
    }),
    getRow: vi.fn(async ({ tableId, rowId }: any) => {
      const row = (store.get(tableId) || []).find((r) => r.$id === rowId || r.id === rowId);
      if (!row) throw Object.assign(new Error("not found"), { code: 404 });
      return row;
    }),
  };
  return db;
}

/**
 * Makes the fake database answer the decision-makers settlement probe the way the installed SQL function does («Job … not found»), so a
 * decision-makers quote is built by the real people branch offline. Every other function stays «not found», as it is without `rpc`.
 */
export function withPeopleSettlement<T extends object>(db: T): T {
  (db as any).rpc = async (name: string, args: any) => name === "settle_people_job_atomic"
    ? { data: null, error: { code: "P0001", message: `Job ${args.p_job_id} not found` } }
    : { data: null, error: { code: "PGRST202", message: `function ${name} not found` } };
  return db;
}

/** Sends several messages in order in one conversation and returns every response. */
export async function runConversation(messages: string[], options: { userId?: string; balance?: number } = {}) {
  const db = createChatDb();
  const handler = new ChatHandler(db as any);
  const conversationId = "conv_scope_test";
  await db.createRow({ tableId: "conversations", rowId: conversationId, data: { userId: options.userId ?? "user_scope_test", title: "محادثة جديدة", status: "active", totalTokens: 0 } });
  const responses: any[] = [];
  for (const message of messages) {
    try {
      responses.push(await handler.handleUserMessage({
        userId: options.userId ?? "user_scope_test",
        conversationId,
        message,
        userBalance: options.balance ?? 5000,
      }));
    } catch (error) {
      // A turn that cannot finish offline (for example a people quote that needs a database function) still
      // leaves its message and brief in the conversation, which is what the next turn must not be polluted by.
      responses.push({ outputType: "error", contentAr: String((error as Error)?.message || ""), error });
    }
  }
  return { db, responses };
}
