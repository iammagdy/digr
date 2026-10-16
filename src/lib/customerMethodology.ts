/** Fixed Arabic methodology copy for customer-facing quote cards.
 * Raw model notes can contain provider keywords, English taxonomy labels, or unsupported claims.
 */
export function getCustomerMethodologyNote(isPeoplePlan: boolean, isCompanyPlan: boolean): string {
  if (isPeoplePlan) {
    return "البحث في المصادر المهنية المتاحة، مع بيان الحقول الموجودة أو غير الموجودة لكل سجل. وجود البريد لا يعني التحقق من صحته.";
  }

  if (isCompanyPlan) {
    return "البحث في المصادر المتاحة وفق الدولة والنشاط المحددين في الخطة. قد يكون عدد السجلات المسلَّمة أقل من المطلوب بحسب ما تتيحه المصادر.";
  }

  return "جمع البيانات من المصادر المتاحة وقت البحث، مع توضيح حدود النتائج وما لم يُتحقق منه بشكل مستقل.";
}
