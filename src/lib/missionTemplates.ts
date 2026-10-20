/**
 * Templates for the big, long-running missions. A template only FILLS the editable input (the customer edits the bracketed
 * parts and sends it); it never sends anything and never carries a price: the price comes from the plan the server quotes.
 * Used by the empty chat and the landing page.
 */
export interface MissionTemplate {
  id: "channels_top_videos_comments" | "event_monitoring_x" | "facebook_topic_dates" | "companies_decision_makers";
  titleAr: string;
  /** The flow in plain words, shown under the title. */
  flowAr: string;
  /** What the customer receives. */
  outputAr: string;
  /** The text placed in the input; the bracketed parts are the customer's to edit. */
  promptAr: string;
  iconPath: string;
}

export const MISSION_TEMPLATES: readonly MissionTemplate[] = [
  {
    id: "channels_top_videos_comments",
    titleAr: "قنوات ← أعلى الفيديوهات مشاهدة ← التعليقات",
    flowAr: "نختار القنوات، ثم أعلى فيديوهات كل قناة بالمشاهدات، ثم نجمع تعليقاتها.",
    outputAr: "ملف إكسل بتعليقات كل فيديو مع رابط الفيديو.",
    promptAr: "أريد أعلى [١٠] فيديوهات مشاهدة من كل قناة من القنوات [@القناة_الأولى و@القناة_الثانية] على يوتيوب، مع كل التعليقات ورابط كل فيديو.",
    iconPath: "M4 5h16v11H9l-5 4z",
  },
  {
    id: "event_monitoring_x",
    titleAr: "متابعة حدث أو موضوع على إكس",
    flowAr: "نجمع المنشورات وردودها عن الحدث ضمن فترة تحددها.",
    outputAr: "ملف إكسل بالمنشورات والردود مع رابط كل منشور.",
    promptAr: "أريد [١٠٠٠] منشور وردودها على إكس عن [اسم الحدث أو الموضوع] خلال [الفترة: من تاريخ إلى تاريخ].",
    iconPath: "M9 3L7 21M17 3l-2 18M4 8.5h16M3 15.5h16",
  },
  {
    id: "facebook_topic_dates",
    titleAr: "موضوع على فيسبوك بين تاريخين",
    flowAr: "نبحث عن المنشورات والفيديوهات العامة عن الموضوع بين التاريخين.",
    outputAr: "ملف إكسل بالمنشورات والفيديوهات مع روابطها وتواريخها.",
    promptAr: "أريد منشورات وفيديوهات فيسبوك عن [الموضوع] في [الدولة] من [١ يناير ٢٠٢٦] إلى [٣٠ سبتمبر ٢٠٢٦].",
    iconPath: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z",
  },
  {
    id: "companies_decision_makers",
    titleAr: "شركات ← صناع القرار ← البريد والهاتف",
    flowAr: "نحدد الشركات، ثم صناع القرار فيها، مع البريد المهني والهاتف عند توفرهما.",
    outputAr: "ملف إكسل بالشركات وصناع القرار وبيانات التواصل المتاحة.",
    promptAr: "أريد [٥٠] شركة [نوع النشاط] في [الدولة] مع صناع القرار والبريد المهني والهاتف.",
    iconPath: "M3 21h18M3 7v14M21 7v14M6 11h4M6 15h4M14 11h4M14 15h4M9 3h6v4H9z",
  },
];
