import { toArabicDigits } from "../arabicDigits";

const MONEY = /نقطة|نقاط|نقطه|جنيه|ج\.م|دولار|مجان|رخيص|غالي|سعر|تكلف|ثمن|رصيد|\$|USD|EGP/i;

/**
 * One sentence written by the model for a customer, made safe by code: no markdown, no emoji, no Latin word of three letters or more (so no provider, endpoint or technical name), no
 * address, no money word, Arabic-Indic digits, a length limit. Null when it cannot be made safe (the caller then uses its own plain sentence). Light on purpose: the worker uses it
 * and never loads the catalog.
 */
export function safeArabicSentence(text: unknown, maxLength = 300): string | null {
  const t = String(text ?? "").replace(/```[\s\S]*?```/g, " ").replace(/[*_#`>|]+/g, " ").replace(/\p{Extended_Pictographic}/gu, " ").replace(/\s+/g, " ").trim();
  if (!t || t.length > maxLength || !/[؀-ۿ]/.test(t)) return null;
  if (/\b[a-z0-9-]+\.[a-z0-9_.-]{2,}\b/i.test(t) || /https?:/i.test(t) || MONEY.test(t) || /[A-Za-z]{3,}/.test(t)) return null;
  return toArabicDigits(t);
}

/** The name of a stage for the customer: the model's own short Arabic name when it is safe, else a plain one from what the stage's rows are about. */
export function safeStageTitleAr(title: unknown, index: number, entity: "company" | "person" | null | undefined): string {
  const own = safeArabicSentence(title, 60);
  if (own) return own;
  if (entity === "company") return "جمع الشركات";
  if (entity === "person") return "جمع الأشخاص";
  return `المرحلة ${toArabicDigits(index + 1)}`;
}
