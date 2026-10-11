import { describe, expect, it } from "vitest";
import { PENDING_QUESTION_KEY, peekPendingQuestion, savePendingQuestion, takePendingQuestion } from "../src/lib/pendingQuestion";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, String(value)); },
    removeItem: (key) => { values.delete(key); },
    clear: () => values.clear(),
    key: (index) => Array.from(values.keys())[index] ?? null,
    get length() { return values.size; },
  };
}

describe("pending research question handoff", () => {
  it("stores trimmed questions for the auth to chat flow", () => {
    const storage = memoryStorage();
    expect(savePendingQuestion(storage, "  سؤال بحثي  ")).toBe(true);
    expect(storage.getItem(PENDING_QUESTION_KEY)).toBe("سؤال بحثي");
  });

  it("takes the question once and clears it", () => {
    const storage = memoryStorage();
    storage.setItem(PENDING_QUESTION_KEY, "سؤال محفوظ");
    expect(takePendingQuestion(storage)).toBe("سؤال محفوظ");
    expect(takePendingQuestion(storage)).toBe("");
  });

  it("lets the auth screen display the question without consuming it", () => {
    const storage = memoryStorage();
    storage.setItem(PENDING_QUESTION_KEY, "سؤال محفوظ");
    expect(peekPendingQuestion(storage)).toBe("سؤال محفوظ");
    expect(takePendingQuestion(storage)).toBe("سؤال محفوظ");
  });

  it("does not store blank input", () => {
    const storage = memoryStorage();
    expect(savePendingQuestion(storage, "   ")).toBe(false);
    expect(storage.getItem(PENDING_QUESTION_KEY)).toBeNull();
  });
});
