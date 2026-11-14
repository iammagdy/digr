import type { Evidence, Severity } from "./types";

/** PHASE 7: the Arabic words of the admin shadow view. Admin-only text: provider names and money figures may appear here (never in anything a customer reads). */
export const SEVERITY_AR: Record<Severity, string> = { regression: "تراجع", review: "يحتاج مراجعة", improvement: "تحسّن", same: "بلا فرق", info: "معلومة" };
export const EVIDENCE_AR: Record<Evidence, string> = {
  stored_real: "طلب أو خطة محفوظة حقيقية",
  code_computed: "محسوب بالكود دون اتصال",
  recorded: "من سجل مكالمات ديجر أو الأسعار المسجلة",
  simulated: "مُحاكى (مدخلات اصطناعية)",
  unverified: "غير مؤكد",
};

const CODES: Record<string, string> = {
  expectation_unmet_both: "لا القراءة الحالية ولا الجديدة تطابق المعنى المُوسَم",
  corrected_to_expected: "القراءة الجديدة تطابق ما قصده العميل (والحالية لا)",
  now_wrong: "القراءة الحالية صحيحة والجديدة تُفسدها",
  both_differ_from_expected: "القراءتان تختلفان عن المعنى المُوسَم وعن بعضهما",
  filled: "قيمة في الكلمات لم تلتقطها القراءة الحالية (بلا وسم يؤكدها)",
  understanding_lost: "قيد التقطته القراءة الحالية ضاع",
  condition_lost: "شرط (منصة/دولة/تاريخ/لغة/عدد) ضاع",
  value_changed: "قيمتان مختلفتان بلا وسم للمقارنة",
  cleared_with_corrected_platform: "حقل مرتبط بمنصة صُحّحت فزال معها",
  topic_tightened: "الموضوع لم يعد يحمل عبارة شرط (تاريخ/دولة/لغة)",
  route_follows_platform: "صارت المنصة معروفة فيسلك الطلب المسار المُجمَّع",
  partial_trade_off: "حالة فجوة معروفة: تحسّن صافٍ مع حقل أسوأ",
  provider_same: "الموجِّه يختار المصدر نفسه",
  provider_changed_validated: "مصدر مختلف لكن الاثنين مؤهلان",
  historical_source_broken_avoided: "المصدر القديم معطّل بالقياس والموجِّه يتجنبه",
  historical_source_below_verification: "المصدر القديم دون قائمة الإنتاج المعتمدة: يفقده العميل حتى ترقيته بالأدلة",
  historical_source_not_routable: "المصدر القديم لا يمرّ بالموجِّه",
  historical_stage_no_proposed_stage: "مرحلة قديمة بلا مقابل في السلسلة المقترحة",
  baseline_not_reproducible: "اختيار المصدر الحالي لا يمكن إعادته دون اتصال",
  routing_as_audited: "التوجيه كما ثبّته التدقيق",
  routing_differs_from_audit: "التوجيه يخالف ما ثبّته التدقيق",
  violation_below_verification: "اختير مصدر دون الحد المسموح لنوع الحساب",
  violation_broken_selected: "اختير مصدر معطّل",
  violation_unreviewed_for_customer: "اختير لحساب عميل مصدر خارج القائمة المعتمدة",
  shadow_engine_error: "خطأ في محرك المقارنة",
  violation_private_capability: "اختير مصدر يعيد بيانات شخصية خاصة",
  violation_policy_category: "اختير مصدر محظور أو حسّاس لحساب عادي",
  customer_text_discloses_internal: "نص العميل يذكر مزوّدًا أو سعرًا",
  privacy_refusal_lost: "رفض الخصوصية الحالي لم يعد قائمًا",
  prefilter_changed: "تغيّر الرد الثابت قبل النموذج",
  privacy_not_carried_into_discovery: "الحارس يرفض والموجِّه لا يمنع",
  privacy_preserved: "الرفض باقٍ والموجِّه لا يخطط شيئًا",
  new_block: "الموجِّه يمنع طلبًا يمرّره الحارس (رفض غير ضروري محتمل)",
  violation_price_unknown: "اختير مصدر بلا سعر معروف",
  cost_not_comparable: "لا مقارنة تكلفة: سعر مجهول",
  estimated_cost_higher: "تكلفة المزوّد التقديرية أعلى",
  estimated_cost_lower: "تكلفة المزوّد التقديرية أقل",
  estimated_cost_same: "تكلفة المزوّد التقديرية نفسها",
  budget_invariant_broken: "قاعدة سلامة الميزانية انكسرت",
  budget_invariants_hold: "قواعد الميزانية سليمة",
  estimated_reserve_higher: "الحجز التقديري أعلى (سعر أعلى للعميل)",
  required_output_missing: "المصدر المختار لا يوثّق حقلًا مطلوبًا",
  served_before_unserved_now: "طلب أُنجز سابقًا صار غير مخدوم",
  unsupported_silent: "غير مدعوم دون جملة للعميل",
  outputs_unproven: "حقول المصدر موثّقة لا مُثبتة على صفحة حقيقية",
  legacy_served_gated_by_router: "قد يخدمه المخطِّط القديم اليوم والموجِّه سيحجبه عن العميل",
  router_verdict_differs_from_compiled_path: "المسار المُجمَّع يخدمه والموجِّه يسجّل حكمًا مختلفًا (لا يمنعه)",
  chain_binding_broken: "سلسلة مراحل بحقل ربط غير موثّق",
  approval_record_invalid: "سجل الموافقة نفسه لا يتحقق",
  approval_scope_enforced: "نطاق الموافقة مُلزَم (التبديل والإضافة والتعديل مرفوضة)",
  approval_scope_not_enforced: "نطاق الموافقة غير مُلزَم",
  stage_lost: "مرحلة من الخطة المعتمدة ضاعت",
  scope_expanded: "السلسلة المقترحة تضيف مراحل (نطاق موافقة مختلف)",
  stage_structure_same: "المراحل نفسها",
  coverage_lost: "تغطية كانت في الخطة المعتمدة ضاعت",
  asked_and_covered: "مطلوب وله مرحلة مختارة",
  asked_not_covered_but_said: "مطلوب بلا مصدر معتمد للعميل، ويُقال له",
  silent_drop: "مطلوب ولم يُخطَّط ولم يُقَل",
  contact_words_not_in_need: "الكلمات تطلب بريدًا والحاجة لا تحمله",
  enrichment_never_applied_as_exclusion: "طلب إكمال بيانات لا يُطبَّق أبدًا كاستبعاد",
  exclusion_file_unusable: "ملف الاستبعاد بلا أسماء صالحة",
  exclusion_off_today: "اليوم: الملف لا يُطبَّق ويُقال للعميل",
  exclusion_matches_expectation: "المطابِق يزيل الشركات المدرجة تمامًا (مُحاكى)",
  exclusion_mismatch: "المطابِق يزيل صفوفًا غير المتوقعة",
  exclusion_applied: "صفوف أُزيلت (مُحاكى)",
  exclusion_possible_delivered: "تشابه كلمة علامة فقط: تُسلَّم وتُعلَّم",
  exclusion_free_rerun_carries_no_file: "إعادة التشغيل المجانية لا تحمل ملف الاستبعاد",
};

/** The Arabic label of a finding code; a dynamic code (`limitation_*`, `stated_*`) gets its family's label. */
export function codeLabelAr(code: string): string {
  if (CODES[code]) return CODES[code];
  if (code.startsWith("limitation_")) return "قيد معروف على المصدر المختار";
  if (code.startsWith("stated_")) return "غير مدعوم أو جزئي ويُقال للعميل";
  return code;
}
export const KNOWN_CODE_LABELS: ReadonlyArray<string> = Object.keys(CODES);
