/** Detect unresolved slots from starter examples before they become a research request. */
const PLACEHOLDER_WORDS = /(?:اسم\s*الحساب|اسم_الحساب|اسم المستخدم|اسم_المستخدم|الوسم|الهاشتاج|الهاشتاغ|الموضوع|موضوع البحث|المجال|القطاع|رابط\s*(?:ال)?(?:فيديو|صفحة|منشور|قناة|حساب)|الدولة|المدينة|الفترة|عدد|اكتب|أدخل|حدد|(?:[٠-٩0-9]+)\s*(?:شهر|شهور|أشهر|سنة|سنوات|أسبوع|أسابيع|يوم|أيام)|your[_ ]?(?:username|handle|topic|country|industry|count|date)|account[_ ]?name|username|handle|hashtag|keyword|topic|industry|country|city|time[_ ]?range|count)/iu;

/** The words a starter template puts inside the brackets of an account or tag slot («[@اسم_الحساب]», «[#الوسم]», «[@username]», «[@brand_name]»). */
const GENERIC_SLOT_WORD = /^(?:the|your|my|account|accounts|user|username|handle|name|page|brand|channel|hashtag|tag|keyword|topic|here|id|first|second|third|and|or|xx+|و|اسم|الحساب|الحسابات|المستخدم|الوسم|الصفحه|الصفحة|القناه|القناة|البراند|العلامه|العلامة|(?:ال)?(?:أول|اول|ثان|ثالث|رابع|خامس)\S{0,3})$/iu;

/** «[آخر ٣ شهور]»: a period the customer WROTE («last / past N units»). The starter's own slot is the bare quantity («[٣ أشهر]»), which stays a slot. */
const CONCRETE_PERIOD = /^(?:خلال\s+)?(?:آخر|اخر|أخر|last|past)\s*[٠-٩0-9]+\s*(?:شهر|شهور|أشهر|اشهر|سنة|سنه|سنوات|أسبوع|اسبوع|أسابيع|اسابيع|يوم|أيام|ايام|months?|weeks?|days?|years?)$/iu;

/**
 * An account or tag written in brackets is a slot only when what follows the «@» / «#» is a template word. «[@brand_eg]» is a real handle; «[@اسم_الحساب]», «[#الوسم]», «[@username]», «[@your_handle]», «[@brand_name]» and the templates' «[@القناة_الأولى و@القناة_الثانية …]» are slots.
 */
function isUnresolvedHandle(rest: string): boolean {
  const body = rest.trim();
  if (!body) return true;
  if (PLACEHOLDER_WORDS.test(body)) return true;
  const parts = body.split(/[_\s@#،,]+/u).filter(Boolean);
  return parts.length > 0 && parts.every((part) => GENERIC_SLOT_WORD.test(part));
}

export function findUnresolvedResearchPlaceholder(text: string): string | null {
  if (typeof text !== "string") return null;
  const bracketed = text.match(/[\[【〈<]([^\]】〉>]{1,80})[\]】〉>]/gu) || [];
  for (const token of bracketed) {
    const value = token.slice(1, -1).trim();
    if (!value) continue;
    // PR-1.4: a real handle or a written period inside brackets is part of the request, not an empty template slot
    if (/^[@#]/u.test(value)) {
      if (isUnresolvedHandle(value.slice(1))) return token;
      continue;
    }
    if (CONCRETE_PERIOD.test(value)) continue;
    if (value.includes("_") || PLACEHOLDER_WORDS.test(value)) return token;
  }
  return null;
}

export function unresolvedResearchPlaceholderMessageAr(): string {
  return "استبدل النص الموجود بين الأقواس بالمعلومة المطلوبة، مثل اسم الحساب، ثم أرسل طلبك.";
}
