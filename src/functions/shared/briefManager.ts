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
 * Extract and merge research brief facts from the latest user message.
 */
export function extractBriefFromMessage(
  userMessage: string,
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
