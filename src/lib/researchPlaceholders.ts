/** Detect unresolved slots from starter examples before they become a research request. */
const PLACEHOLDER_WORDS = /(?:اسم\s*الحساب|اسم_الحساب|اسم المستخدم|اسم_المستخدم|الوسم|الهاشتاج|الهاشتاغ|الموضوع|موضوع البحث|المجال|القطاع|رابط\s*(?:ال)?(?:فيديو|صفحة|منشور|قناة|حساب)|الدولة|المدينة|الفترة|عدد|اكتب|أدخل|حدد|(?:[٠-٩0-9]+)\s*(?:شهر|شهور|أشهر|سنة|سنوات|أسبوع|أسابيع|يوم|أيام)|your[_ ]?(?:username|handle|topic|country|industry|count|date)|account[_ ]?name|username|handle|hashtag|keyword|topic|industry|country|city|time[_ ]?range|count)/iu;

export function findUnresolvedResearchPlaceholder(text: string): string | null {
  if (typeof text !== "string") return null;
  const bracketed = text.match(/[\[【〈<]([^\]】〉>]{1,80})[\]】〉>]/gu) || [];
  for (const token of bracketed) {
    const value = token.slice(1, -1).trim();
    if (!value) continue;
    if (/^[@#]/u.test(value) || value.includes("_") || PLACEHOLDER_WORDS.test(value)) return token;
  }
  return null;
}

export function unresolvedResearchPlaceholderMessageAr(): string {
  return "استبدل النص الموجود بين الأقواس بالمعلومة المطلوبة، مثل اسم الحساب، ثم أرسل طلبك.";
}
