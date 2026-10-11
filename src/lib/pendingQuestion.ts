export const PENDING_QUESTION_KEY = "digr:pendingQuestion";

export interface QuestionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function savePendingQuestion(storage: QuestionStorage | null, question: string): boolean {
  const value = question.trim();
  if (!storage || !value) return false;
  try {
    storage.setItem(PENDING_QUESTION_KEY, value);
    return true;
  } catch {
    return false;
  }
}

export function takePendingQuestion(storage: QuestionStorage | null): string {
  if (!storage) return "";
  try {
    const question = storage.getItem(PENDING_QUESTION_KEY) || "";
    if (question) storage.removeItem(PENDING_QUESTION_KEY);
    return question;
  } catch {
    return "";
  }
}

export function peekPendingQuestion(storage: QuestionStorage | null): string {
  if (!storage) return "";
  try {
    return storage.getItem(PENDING_QUESTION_KEY) || "";
  } catch {
    return "";
  }
}
