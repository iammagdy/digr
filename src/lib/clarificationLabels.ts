/**
 * The words that label a stored card answer in the text a routing decision reads. An answer never starts a new request, and its label
 * is a noise word of the subject (see TOPIC_NOISE), so a label can never become the topic.
 * Kept in a lib file so the understanding of a mission (shared with the public pages) can read the same labels.
 */
export const CLARIFICATION_ANSWER_LABELS: Record<string, string> = {
  company_country_required: "الدولة المطلوبة",
  company_industry_required: "المجال المطلوب",
  company_count_required: "عدد الشركات المطلوب",
  people_country_required: "دولة صناع القرار المطلوبة",
  people_scope_required: "نطاق صناع القرار",
  people_roles_required: "المسميات الوظيفية المطلوبة",
  people_count_required: "عدد صناع القرار المطلوب",
  social_account_required: "اسم الحساب المطلوب",
  social_topic_required: "موضوع البحث المطلوب",
  social_platform_required: "منصة البحث المطلوبة",
  social_time_required: "الفترة المطلوبة",
  social_comment_target_required: "مصدر الفيديوهات المطلوب",
  social_channel_required: "القنوات المطلوبة",
  social_x_topic_required: "موضوع البحث المطلوب",
  social_x_account_required: "اسم الحساب المطلوب",
  volume_cap_required: "الحد الأقصى المطلوب",
  topic_source_required: "المصدر المطلوب",
};
