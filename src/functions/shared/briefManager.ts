import { TablesDB, Query } from "node-appwrite";
import { detectMentionedPlatforms, getPlatformLabelAr } from "./capabilityRegistry";
import { extractDateHint, extractTopicChips } from "./chatHandler";

export interface ResearchBrief {
  platforms: string[];
  topics: string[];
  targetVolume?: number;
  commentsPerPost?: number;
  dateRange?: string;
  language?: string;
  formats?: string[];
  notes?: string;
}

const briefCache = new Map<string, ResearchBrief>();

export function clearBriefCacheForTesting(): void {
  briefCache.clear();
}

/**
 * Check if the user is greeting the assistant or asking a general identity question.
 */
export function isGreetingOrGeneralQuestion(text: string): {
  isGreeting: boolean;
  isGeneralQuestion: boolean;
} {
  const trimmed = text.trim();
  const greetingPattern =
    /^(هاي|ازيك|ازيك؟|مرحبا|مرحباً|أهلاً|اهلا|صباح الخير|مساء الخير|سلام عليكم|السلام عليكم|هلا|hello|hi)[\s!.؟?]*$/i;
  const generalQuestionPattern =
    /(انت بتعمل ايه|بتعمل ايه|بتساعد في ايه|ازاي بتشتغل|ما وظيفتك|ما هي خدماتك|كيف تعمل|ماذا تقدم|من انت|عرفني بنفسك)/i;

  return {
    isGreeting: greetingPattern.test(trimmed),
    isGeneralQuestion: generalQuestionPattern.test(trimmed),
  };
}

/**
 * Detect if the user wants to trigger pricing, a cost calculation, or execution immediately.
 */
export function isPriceOrProceedIntent(text: string): boolean {
  const pattern =
    /(هيكلفني كام|احسبلي|احسب لي|السعر|بكام|كم نقطة|كم يكلف|تكلف كام|التكلفة|كم التكلفة|السعر كام|ابدأ|توكل على الله|نفذ|تمام جهز الخطة|اعمل الخطة|موافق|استمر|جاهز|اعتمد)/i;
  return pattern.test(text);
}

/**
 * Extract target volume count from user request text.
 */
export function extractTargetVolume(text: string): number | undefined {
  if (!text) return undefined;

  // Pattern 1: e.g. "3000 comment" or "3000 تعليق" or "500 منشور"
  const m1 = text.match(/(\d+)\s*(comment|comments|تعليق|تعليقات|بوست|منشور|منشورات|تغريدة|تغريدات|فيديو|مقاطع|سجل|سجلات|عينة|نتيجة)/i);
  if (m1) {
    const val = parseInt(m1[1], 10);
    if (val > 0) return val;
  }

  // Pattern 2: e.g. "اسحب 3000" or "جمع 500" or "حتى 1000"
  const m2 = text.match(/(اسحب|سحب|جمع|هات|عايز|عاوز|محتاج|حتى)\s*(\d+)/i);
  if (m2) {
    const val = parseInt(m2[2], 10);
    if (val > 0) return val;
  }

  // Pattern 3: any bare number > 10 that isn't a year (like 2026)
  const nums = text.match(/\b(\d+)\b/g);
  if (nums) {
    for (const n of nums) {
      const v = parseInt(n, 10);
      if (v > 10 && v !== 2024 && v !== 2025 && v !== 2026 && v !== 2027) {
        return v;
      }
    }
  }

  return undefined;
}

/**
 * Extract comments-per-post cap if explicitly mentioned.
 */
export function extractCommentsPerPost(text: string): number | undefined {
  if (!text) return undefined;
  const m = text.match(/(\d+)\s*(تعليق لكل منشور|تعليقات لكل بوست|تعليق للبوست|تعليقات لكل منشور|comments? per post)/i);
  if (m) {
    const v = parseInt(m[1], 10);
    if (v > 0) return v;
  }
  return undefined;
}

/**
 * Detect if the user is complaining about having already answered ("منا قولتلك").
 */
export function isRepetitionComplaint(text: string): boolean {
  if (!text) return false;
  return /(منا قولتلك|قولتلك|قلتلك|سبق وقلت|أنا قولت|انا قولت|أخبرتك|ما أنا قولت|ما انا قولت|قولت لك|قلت لك|ما انا لسه قايل|ما قولتلك)/i.test(text);
}

export interface CardAnswerItem {
  questionId: string;
  question: string;
  value?: string | string[];
  skipped?: boolean;
}

/**
 * Deterministically extract facts from submitted discovery card answers into the brief.
 */
export function extractBriefFromCardAnswers(
  answers: CardAnswerItem[],
  currentBrief: ResearchBrief = { platforms: [], topics: [] },
): ResearchBrief {
  const brief: ResearchBrief = {
    platforms: [...currentBrief.platforms],
    topics: [...currentBrief.topics],
    targetVolume: currentBrief.targetVolume,
    commentsPerPost: currentBrief.commentsPerPost,
    dateRange: currentBrief.dateRange,
    language: currentBrief.language,
    formats: currentBrief.formats ? [...currentBrief.formats] : ["xlsx", "csv", "pdf"],
    notes: currentBrief.notes,
  };

  for (const ans of answers) {
    if (!ans) continue;
    const qText = (ans.question || "").toLowerCase();
    const qId = (ans.questionId || "").toLowerCase();
    const rawVal = Array.isArray(ans.value) ? ans.value.join(" ") : ans.value || "";
    if (!rawVal.trim() && !ans.skipped) continue;

    const valToUse = rawVal.trim();

    // 1. Platform
    if (qId.includes("platform") || qText.includes("منصة")) {
      const plats = detectMentionedPlatforms(valToUse);
      for (const p of plats) {
        if (!brief.platforms.includes(p)) brief.platforms.push(p);
      }
    }
    // 2. Topic / Keywords
    else if (qId.includes("topic") || qText.includes("موضوع") || qText.includes("كلمات") || qText.includes("محاور")) {
      if (valToUse && !brief.topics.includes(valToUse)) {
        brief.topics.push(valToUse);
      }
    }
    // 3. Volume
    else if (qId.includes("volume") || qId.includes("count") || qText.includes("عدد") || qText.includes("حجم") || qText.includes("سجل")) {
      const vol = extractTargetVolume(valToUse);
      if (vol) brief.targetVolume = vol;
    }
    // 4. Comments per post / Source
    else if (qId.includes("comments") || qText.includes("تعليق لكل منشور") || qText.includes("مصدر التعليقات") || qText.includes("مصدر")) {
      const cpp = extractCommentsPerPost(valToUse) || extractTargetVolume(valToUse);
      if (cpp) brief.commentsPerPost = cpp;
      if (valToUse) {
        brief.notes = (brief.notes ? brief.notes + " | " : "") + `المصدر: ${valToUse}`;
      }
    }
    // 5. Date range
    else if (qId.includes("date") || qId.includes("time") || qText.includes("فترة") || qText.includes("تاريخ") || qText.includes("زمن")) {
      if (valToUse) brief.dateRange = valToUse;
    }
    // 6. Language
    else if (qId.includes("lang") || qText.includes("لغة")) {
      if (valToUse) brief.language = valToUse;
    }
    // 7. Output Format
    else if (qId.includes("format") || qText.includes("صيغة") || qText.includes("تنسيق")) {
      const lower = valToUse.toLowerCase();
      const detectedFmts: string[] = [];
      if (lower.includes("excel") || lower.includes("xlsx")) detectedFmts.push("xlsx");
      if (lower.includes("csv")) detectedFmts.push("csv");
      if (lower.includes("pdf")) detectedFmts.push("pdf");
      if (detectedFmts.length > 0) brief.formats = detectedFmts;
    } else if (valToUse) {
      brief.notes = (brief.notes ? brief.notes + " | " : "") + `${ans.question}: ${valToUse}`;
    }
  }

  return brief;
}

/**
 * Extract and merge research brief facts from the latest user message.
 */
export function extractBriefFromMessage(
  userMessage: string,
  currentBrief: ResearchBrief = { platforms: [], topics: [] },
): ResearchBrief {
  if (userMessage.includes("clarification_answers") || userMessage.trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(userMessage);
      if (parsed && Array.isArray(parsed.answers)) {
        return extractBriefFromCardAnswers(parsed.answers, currentBrief);
      }
    } catch {}
  }

  const brief: ResearchBrief = {
    platforms: [...currentBrief.platforms],
    topics: [...currentBrief.topics],
    targetVolume: currentBrief.targetVolume,
    commentsPerPost: currentBrief.commentsPerPost,
    dateRange: currentBrief.dateRange,
    language: currentBrief.language,
    formats: currentBrief.formats ? [...currentBrief.formats] : ["xlsx", "csv", "pdf"],
    notes: currentBrief.notes,
  };

  // 1. Platform
  const detectedPlatforms = detectMentionedPlatforms(userMessage);
  for (const p of detectedPlatforms) {
    if (!brief.platforms.includes(p)) {
      brief.platforms.push(p);
    }
  }

  // 2. Volume
  const vol = extractTargetVolume(userMessage);
  if (vol !== undefined) {
    brief.targetVolume = vol;
  }

  // 3. Comments per post
  const cpp = extractCommentsPerPost(userMessage);
  if (cpp !== undefined) {
    brief.commentsPerPost = cpp;
  }

  // 4. Date range
  const date = extractDateHint(userMessage);
  if (date) {
    brief.dateRange = date;
  }

  // 5. Topics
  const topicMatch = userMessage.match(/(?:عن|حول|بخصوص|في موضوع)\s+([^.،,؛\n!؟?]+)/i);
  if (topicMatch) {
    const rawMatch = topicMatch[1].trim();
    const cleaned = rawMatch
      .replace(/\b(فيسبوك|تويتر|تيك توك|انستغرام|إنستغرام|يوتيوب|ريديت|منصة|آخر شهر|آخر أسبوع|آخر ٣ شهور)\b/gi, "")
      .trim();
    if (cleaned.length > 1 && !brief.topics.includes(cleaned)) {
      brief.topics.push(cleaned);
    }
  }

  const chips = extractTopicChips(userMessage);
  for (const c of chips) {
    if (!brief.topics.includes(c)) {
      brief.topics.push(c);
    }
  }

  return brief;
}

/**
 * Deterministic check: whether the brief has the required core fields for pricing.
 */
export function isBriefComplete(brief: ResearchBrief): boolean {
  const hasPlatform = brief.platforms.length > 0;
  const hasTopic = brief.topics.length > 0;
  const hasVolume = typeof brief.targetVolume === "number" && brief.targetVolume > 0;
  return hasPlatform && hasTopic && hasVolume;
}

/**
 * Format the brief compactly for the model context without replaying raw history.
 */
export function formatBriefForSystemPrompt(brief: ResearchBrief): string {
  const lines: string[] = ["[ملخص متطلبات البحث الحالية (Brief)]:"];

  if (brief.platforms.length > 0) {
    const pNames = brief.platforms.map(getPlatformLabelAr).join("، ");
    lines.push(`- المنصة المستهدفة: ${pNames}`);
  } else {
    lines.push("- المنصة المستهدفة: غير محددة بعد");
  }

  if (brief.topics.length > 0) {
    lines.push(`- موضوع البحث/الكلمات المفتاحية: ${brief.topics.join("، ")}`);
  } else {
    lines.push("- موضوع البحث: غير محدد بعد");
  }

  if (brief.targetVolume !== undefined) {
    lines.push(`- حجم البيانات المستهدف: حتى ${brief.targetVolume} سجل`);
  } else {
    lines.push("- حجم البيانات: غير محدد بعد");
  }

  if (brief.commentsPerPost !== undefined) {
    lines.push(`- سقف التعليقات لكل منشور: حتى ${brief.commentsPerPost} تعليق`);
  }

  if (brief.dateRange) {
    lines.push(`- النطاق الزمني: ${brief.dateRange}`);
  }

  if (brief.language) {
    lines.push(`- اللغة/اللهجة: ${brief.language}`);
  }

  if (brief.notes) {
    lines.push(`- ملاحظات إضافية: ${brief.notes}`);
  }

  return lines.join("\n");
}

/**
 * Retrieve the persistent brief for a conversation.
 */
export async function getConversationBrief(
  tables: TablesDB | null | undefined,
  conversationId: string,
): Promise<ResearchBrief> {
  const cached = briefCache.get(conversationId);
  if (cached) return { ...cached };

  if (!tables) {
    return { platforms: [], topics: [] };
  }

  try {
    const notesRes = await tables.listRows({
      databaseId: "digr",
      tableId: "notes",
      queries: [Query.equal("conversationId", conversationId), Query.limit(1)],
    });

    const note = notesRes.rows?.[0] as any;
    if (note && note.contentMarkdown) {
      const parsed = JSON.parse(note.contentMarkdown);
      if (parsed && typeof parsed === "object") {
        briefCache.set(conversationId, parsed);
        return parsed;
      }
    }
  } catch {
    // Database read fallback
  }

  return { platforms: [], topics: [] };
}

/**
 * Persist the brief for a conversation in memory and database.
 */
export async function saveConversationBrief(
  tables: TablesDB | null | undefined,
  conversationId: string,
  userId: string,
  brief: ResearchBrief,
): Promise<void> {
  briefCache.set(conversationId, { ...brief });

  if (!tables) return;

  try {
    const serialized = JSON.stringify(brief);
    const notesRes = await tables.listRows({
      databaseId: "digr",
      tableId: "notes",
      queries: [Query.equal("conversationId", conversationId), Query.limit(1)],
    });

    const note = notesRes.rows?.[0] as any;
    if (note) {
      await tables.updateRow({
        databaseId: "digr",
        tableId: "notes",
        rowId: note.$id,
        data: {
          contentMarkdown: serialized,
          updatedAt: new Date().toISOString(),
        },
      });
    } else {
      await tables.createRow({
        databaseId: "digr",
        tableId: "notes",
        rowId: `brief_${conversationId}`.slice(0, 36),
        data: {
          conversationId,
          userId,
          contentMarkdown: serialized,
          updatedAt: new Date().toISOString(),
        },
      });
    }
  } catch {
    // DB write failure is non-fatal: memory cache still holds the state
  }
}
