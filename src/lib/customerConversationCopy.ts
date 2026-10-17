/** Deterministic Arabic copy for greetings and identity questions. */
export function customerConversationAnswer(isGreeting: boolean): string {
  return isGreeting
    ? "أهلًا بك. أنا مساعدك البحثي في ديجر، وأساعدك في جمع البيانات من المصادر المتاحة. كيف يمكنني مساعدتك اليوم؟"
    : "أنا مساعد ديجر للبحث وجمع البيانات من الإنترنت. أساعدك في تحديد المطلوب، وإعداد خطة قابلة للتعديل، ثم تسليم النتائج في ملفات منظمة بعد موافقتك.";
}
