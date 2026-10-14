import { ResearchIntentSpec } from "./researchIntent";

export interface ClarificationQuestionItem {
  id: string;
  field: string;
  questionAr: string;
  suggestedAnswersAr?: string[];
  priority: number;
}

export interface DiscoveryDecision {
  action: "PROCEED_TO_PLAN" | "CLARIFY";
  questions: ClarificationQuestionItem[];
  rationaleAr: string;
  isCompleteWithoutQuestions: boolean;
  missingCrucialFields: string[];
}

/**
 * Evaluates whether an incoming research intent is ready for immediate catalog planning
 * or genuinely requires clarification questions.
 * 
 * Non-negotiable principle: Zero unnecessary discovery questions!
 * - If platform is known or reasonably inferred: DO NOT ASK.
 * - If topic is known: DO NOT ASK.
 * - If volume is known or can adopt a sensible default: DO NOT ASK.
 * - If date range is known or defaultable: DO NOT ASK.
 * - If output format is specified or defaultable: DO NOT ASK.
 * 
 * Ask ONLY when a strictly missing dependency blocks creating a valid plan:
 * 1. Topic is completely absent / unknown.
 * 2. User explicitly mentions an exclusion spreadsheet, but hasn't uploaded it.
 * 3. Irreconcilable contradiction in instructions.
 */
export function evaluateDiscoveryDecision(intent: ResearchIntentSpec): DiscoveryDecision {
  const missingCrucialFields: string[] = [];
  const questions: ClarificationQuestionItem[] = [];

  // 1. Missing Exclusion File referenced by user
  if (
    intent.userExclusions.value.hasExclusionReference &&
    intent.userExclusions.value.fileReferences.length === 0
  ) {
    missingCrucialFields.push("exclusion_file");
    questions.push({
      id: "missing_exclusion_file",
      field: "userExclusions",
      questionAr: "ذكرت استبعاد شركات من ملف مرفق، يرجى رفع ملف الاستبعاد (Excel أو CSV) للمتابعة وتدقيق الأسماء والنطاقات.",
      suggestedAnswersAr: ["رفع الملف الآن", "متابعة البحث بدون استبعاد"],
      priority: 1,
    });
  }

  // 2. Missing Core Topic / Objective
  if (intent.topic.provenance === "UNKNOWN" || !intent.topic.value.trim() || intent.topic.value === "بحث عام") {
    missingCrucialFields.push("topic");
    questions.push({
      id: "missing_topic",
      field: "topic",
      questionAr: "ما هو الموضوع أو المجال الدقيق الذي ترغب في استخراج بياناته وتحليله؟",
      suggestedAnswersAr: [
        "شركات ومقاولات كهروميكانيكية",
        "تفاعل الجمهور مع مباريات منتخب مصر",
        "تحليل وسوم ومنشورات محددة",
      ],
      priority: 1,
    });
  }

  if (questions.length > 0) {
    return {
      action: "CLARIFY",
      questions,
      rationaleAr: `يتطلب إنشاء الخطة توضيح ${missingCrucialFields.join("، ")} لتجنب استخراج بيانات غير مطابقة لرغبتك.`,
      isCompleteWithoutQuestions: false,
      missingCrucialFields,
    };
  }

  // Request is complete! Proceed directly to plan generation with ZERO questions.
  return {
    action: "PROCEED_TO_PLAN",
    questions: [],
    rationaleAr: "الطلب مكتمل ومحدد بوضوح (الموضوع والمنصة والهدف وحجم العينة). جاري إعداد الخطة المسعرة فوراً بدون أسئلة متكررة.",
    isCompleteWithoutQuestions: true,
    missingCrucialFields: [],
  };
}
