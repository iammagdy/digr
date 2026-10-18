import { TablesDB, Query } from "./dbCompat";
import { detectMentionedPlatforms, getPlatformLabelAr } from "./capabilityRegistry";
import { extractDateHint, extractTopicChips } from "./chatHandler";
import { isStandaloneResearchRequest } from "./requestScope";

export interface ResearchBrief {
  platforms: string[];
  topics: string[];
  keywords?: string[];
  targetVolume?: number;
  postCount?: number;
  commentsPerPost?: number;
  dateRange?: string;
  language?: string;
  formats?: string[];
  notes?: string;
  exclusionFile?: {
    name: string;
    baselineRowCount: number;
    companyNames?: string[];
    corporateDomains?: string[];
    normalizedEntities?: Array<{ name: string; domain?: string; crNumber?: string }>;
  };
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
    /^(هاي|ازيك|ازيك يا فندم|مرحبا|مرحباً|أهلاً|أهلا|اهلا|صباح الخير|مساء الخير|سلام عليكم|السلام عليكم|هلا|hello|hi)[\s!.؟?]*$/i;
  const generalQuestionPattern =
    /(انت بتعمل ايه|أنت بتعمل ايه|بتعمل ايه|بتساعد في ايه|ازاي بتشتغل|ما وظيفتك|ما هي خدماتك|كيف تعمل|كيف تعمل المنصة|ماذا تفعل|ماذا تقدم|من انت|من أنت|إنت مين|انت مين|عرفني بنفسك|هل يمكنك مساعدتي)/i;

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
    /(خطة|هيكلفني كام|احسبلي|احسب لي|السعر|بكام|كم نقطة|كم يكلف|تكلف كام|التكلفة|كم التكلفة|السعر كام|ابدأ|توكل على الله|نفذ|تمام جهز الخطة|اعمل الخطة|موافق|استمر|جاهز|اعتمد)/i;
  return pattern.test(text);
}

/**
 * Extract post/item count if explicitly mentioned (e.g. "10 منشورات", "10 بوستات").
 */
export function extractPostCount(text: string): number | undefined {
  if (!text) return undefined;
  const m = text.match(/(\d+|[٠-٩]+)\s*(بوست|بوستات|منشور|منشورات|posts?|فيديو|مقاطع)/i);
  if (m) {
    const raw = m[1].replace(/[٠-٩]/g, (d) => "0123456789"["٠١٢٣٤٥٦٧٨٩".indexOf(d)]);
    const val = parseInt(raw, 10);
    if (val > 0) return val;
  }
  return undefined;
}

/**
 * Extract comments-per-post cap if explicitly mentioned.
 */
export function extractCommentsPerPost(text: string): number | undefined {
  if (!text) return undefined;
  const m = text.match(/(\d+|[٠-٩]+)\s*(تعليق[^\s]*\s*(لكل|في|على)\s*(منشور|بوست)|comments?\s*per\s*post)/i);
  if (m) {
    const raw = m[1].replace(/[٠-٩]/g, (d) => "0123456789"["٠١٢٣٤٥٦٧٨٩".indexOf(d)]);
    const v = parseInt(raw, 10);
    if (v > 0) return v;
  }
  return undefined;
}

/**
 * Infer 5 to 10 relevant Arabic search keywords covering angles of the topic.
 */
export function inferRelatedKeywords(topic: string, message: string = ""): string[] {
  const combined = `${topic} ${message}`.toLowerCase();
  if (
    combined.includes("منقولات") ||
    combined.includes("زواج") ||
    combined.includes("مهر") ||
    combined.includes("عروس") ||
    combined.includes("شبكة")
  ) {
    return [
      "قائمة المنقولات",
      "المهر",
      "الشبكة",
      "تجهيز منزل الزوجية",
      "حقوق الزوجين",
      "تكاليف الزواج",
      "مؤخر الصداق",
      "شوار العروسة",
    ];
  }
  if (
    combined.includes("دهب") ||
    combined.includes("ذهب") ||
    combined.includes("صاغة") ||
    combined.includes("عيار")
  ) {
    return [
      "أسعار الذهب",
      "سعر الذهب عيار 21",
      "سوق الصاغة",
      "الجنيه الذهب",
      "تداولات الذهب",
      "المصنعية والدمغة",
      "توقعات أسعار الذهب",
    ];
  }
  if (
    combined.includes("عقارات") ||
    combined.includes("شقق") ||
    combined.includes("إيجار") ||
    combined.includes("ايجار")
  ) {
    return [
      "أسعار العقارات",
      "شقق للبيع",
      "الإيجار القديم والجديد",
      "التمويل العقاري",
      "سوق العقارات في مصر",
      "المطورين العقاريين",
    ];
  }

  // General extraction of meaningful terms
  const chips = extractTopicChips(message || topic, 8);
  if (chips.length >= 2) return chips;
  return [topic];
}

import { extractNumberFromText } from "../../lib/arabicNumbers";

/**
 * Extract target volume count from user request text.
 * If user explicitly provided postCount and commentsPerPost, volume is calculated as postCount * commentsPerPost.
 * Supports digits, Eastern Arabic digits, and Arabic/English word numbers (خمس، عشرة، خمسين، مية...).
 */
export function extractTargetVolume(text: string): number | undefined {
  if (!text) return undefined;

  const postCount = extractPostCount(text);
  const cpp = extractCommentsPerPost(text);
  if (postCount && cpp) {
    return postCount * cpp;
  }

  return extractNumberFromText(text);
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
    formats: currentBrief.formats ? [...currentBrief.formats] : ["xlsx"],
    notes: currentBrief.notes,
  };

  for (const ans of answers) {
    if (!ans) continue;
    const qText = (ans.question || "").toLowerCase();
    const qId = (ans.questionId || "").toLowerCase();
    const rawVal = Array.isArray(ans.value) ? ans.value.join(" ") : ans.value || "";
    if (!rawVal.trim() && !ans.skipped) continue;

    const valToUse = rawVal.trim();

    // Company-search clarification chips are part of the requirements brief,
    // not generic conversation notes. Preserve answers so the server's final
    // quote guard can verify country, industry and outreach scope on the next turn.
    if (qId === "company_country_required") {
      if (valToUse) brief.notes = (brief.notes ? brief.notes + " | " : "") + `الدولة المطلوبة: ${valToUse}`;
    } else if (qId === "company_industry_required") {
      if (valToUse) brief.notes = (brief.notes ? brief.notes + " | " : "") + `المجال المطلوب: ${valToUse}`;
    } else if (qId === "company_outreach_required") {
      if (valToUse) brief.notes = (brief.notes ? brief.notes + " | " : "") + `إجابة هدف التواصل: ${valToUse}`;
    } else if (qId === "company_count_required") {
      const count = extractTargetVolume(valToUse);
      if (count) brief.targetVolume = count;
      if (valToUse) brief.notes = (brief.notes ? brief.notes + " | " : "") + `عدد الشركات المطلوب: ${valToUse}`;
    } else if (qId === "people_scope_required") {
      if (valToUse) brief.notes = (brief.notes ? brief.notes + " | " : "") + `نطاق صناع القرار: ${valToUse}`;
    } else if (qId === "people_roles_required") {
      if (valToUse) brief.notes = (brief.notes ? brief.notes + " | " : "") + `المسميات المطلوبة: ${valToUse}`;
    } else if (qId === "people_count_required") {
      const count = extractTargetVolume(valToUse);
      if (count) brief.targetVolume = count;
      if (valToUse) brief.notes = (brief.notes ? brief.notes + " | " : "") + `عدد صناع القرار المطلوب: ${valToUse}`;
    } else if (qId === "social_account_required") {
      if (valToUse) brief.notes = (brief.notes ? brief.notes + " | " : "") + `اسم الحساب المطلوب: ${valToUse}`;
    } else if (qId === "social_topic_required") {
      if (valToUse) brief.notes = (brief.notes ? brief.notes + " | " : "") + `موضوع البحث المطلوب: ${valToUse}`;
    } else if (qId === "social_platform_required") {
      if (valToUse) brief.notes = (brief.notes ? brief.notes + " | " : "") + `منصة البحث المطلوبة: ${valToUse}`;
    } else if (qId === "social_time_required") {
      if (valToUse) brief.notes = (brief.notes ? brief.notes + " | " : "") + `الفترة المطلوبة: ${valToUse}`;
    }
    if (["company_country_required", "company_industry_required", "company_outreach_required", "company_count_required", "people_scope_required", "people_roles_required", "people_count_required", "social_account_required", "social_topic_required", "social_platform_required", "social_time_required"].includes(qId)) continue;

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
    else if (qId.includes("volume") || qId.includes("count") || qId.includes("sample") || qId.includes("size") || qText.includes("عدد") || qText.includes("حجم") || qText.includes("سجل") || qText.includes("عينة")) {
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
    // 4b. Post count
    else if (qId.includes("post") || qText.includes("منشورات") || qText.includes("منشور")) {
      const pc = extractPostCount(valToUse) || extractTargetVolume(valToUse);
      if (pc) brief.postCount = pc;
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

  if (brief.postCount && brief.commentsPerPost && (!brief.targetVolume || brief.targetVolume <= 0)) {
    brief.targetVolume = brief.postCount * brief.commentsPerPost;
  }
  if (brief.topics.length > 0 && (!brief.keywords || brief.keywords.length === 0)) {
    brief.keywords = inferRelatedKeywords(brief.topics.join(" "));
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

  // A self-contained research request starts a clean brief: it never inherits the platform, topic, country wording or
  // notes of an older request. Only follow-ups (answers, "ابدأ", short fragments) merge into the brief.
  const startsNewRequest = isStandaloneResearchRequest(userMessage);
  const brief: ResearchBrief = startsNewRequest
    ? {
        platforms: [],
        topics: [],
        formats: currentBrief.formats ? [...currentBrief.formats] : ["xlsx"],
        language: currentBrief.language,
        exclusionFile: currentBrief.exclusionFile,
      }
    : {
        platforms: [...currentBrief.platforms],
        topics: [...currentBrief.topics],
        keywords: currentBrief.keywords ? [...currentBrief.keywords] : undefined,
        targetVolume: currentBrief.targetVolume,
        postCount: currentBrief.postCount,
        commentsPerPost: currentBrief.commentsPerPost,
        dateRange: currentBrief.dateRange,
        language: currentBrief.language,
        formats: currentBrief.formats ? [...currentBrief.formats] : ["xlsx"],
        notes: currentBrief.notes,
        exclusionFile: currentBrief.exclusionFile,
      };

  // 1. Platform
  const detectedPlatforms = detectMentionedPlatforms(userMessage);
  for (const p of detectedPlatforms) {
    if (!brief.platforms.includes(p)) {
      brief.platforms.push(p);
    }
  }

  // 2. Post count & Comments per post
  const postCount = extractPostCount(userMessage);
  if (postCount !== undefined) {
    brief.postCount = postCount;
  }
  const cpp = extractCommentsPerPost(userMessage);
  if (cpp !== undefined) {
    brief.commentsPerPost = cpp;
  }

  // 3. Volume
  const vol = extractTargetVolume(userMessage);
  if (vol !== undefined) {
    brief.targetVolume = vol;
  } else if (brief.postCount && brief.commentsPerPost) {
    brief.targetVolume = brief.postCount * brief.commentsPerPost;
  }

  // 4. Date range
  const date = extractDateHint(userMessage);
  if (date) {
    brief.dateRange = date;
  }

  // 5. Topics
  const isGreetingWord = (w: string) => {
    const trimmed = (w || "").trim();
    if (!trimmed) return true;
    return isGreetingOrGeneralQuestion(trimmed).isGreeting || /^(ازيك|ازيكوا|ازيكم|مرحبا|مرحباً|أهلاً|أهلا|اهلا|صباح الخير|مساء الخير|سلام عليكم|السلام عليكم|هلا|hello|hi|شكرا|تمام)$/i.test(trimmed);
  };

  // Strip any old greetings that might have been stored in brief.topics
  brief.topics = (brief.topics || []).filter((t) => !isGreetingWord(t));

  // Greetings and identity questions ("إنت مين؟") never enter a research topic.
  const greetingOrGeneral = isGreetingOrGeneralQuestion(userMessage);
  const msgIsGreeting = greetingOrGeneral.isGreeting || greetingOrGeneral.isGeneralQuestion;

  if (!msgIsGreeting) {
    const topicMatch = userMessage.match(/(?:عن|حول|بخصوص|في موضوع)\s+([^.،,؛\n!؟?]+)/i);
    if (topicMatch) {
      let rawMatch = topicMatch[1].trim();
      rawMatch = rawMatch
        .replace(/(?:خلال الفترة|خلال|من الفترة|بحد أقصى|بحد اقصى|عدد|آخر شهر|آخر أسبوع).*$/i, "")
        .replace(/\b(فيسبوك|تويتر|تيك توك|انستغرام|إنستغرام|يوتيوب|ريديت|منصة|شركات|شركة|مؤسسات|مؤسسة)\b/gi, "")
        .trim();
      if (rawMatch.length > 1 && !isGreetingWord(rawMatch) && !brief.topics.includes(rawMatch)) {
        brief.topics.push(rawMatch);
      }
    }

    const chips = extractTopicChips(userMessage).filter((c) => !isGreetingWord(c));
    for (const c of chips) {
      if (!brief.topics.includes(c)) {
        brief.topics.push(c);
      }
    }
  }

  // 6. Infer 5 to 10 relevant Arabic keywords
  const primaryTopic = (brief.topics && brief.topics.length > 0)
    ? brief.topics[0]
    : (!msgIsGreeting ? userMessage : "البيانات المطلوبة");
  const inferred = inferRelatedKeywords(primaryTopic, userMessage);
  if (!brief.keywords || brief.keywords.length === 0) {
    brief.keywords = inferred;
  } else {
    for (const kw of inferred) {
      if (!brief.keywords.includes(kw)) brief.keywords.push(kw);
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
  const hasVolume = Boolean(
    (typeof brief.targetVolume === "number" && brief.targetVolume > 0) ||
    (typeof brief.postCount === "number" && brief.postCount > 0 && typeof brief.commentsPerPost === "number" && brief.commentsPerPost > 0)
  );
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

  if (brief.keywords && brief.keywords.length > 0) {
    lines.push(`- الكلمات المفتاحية المقترحة: ${brief.keywords.join("، ")}`);
  }

  if (brief.postCount !== undefined) {
    lines.push(`- عدد المنشورات المستهدف: حتى ${brief.postCount} منشور`);
  }

  if (brief.commentsPerPost !== undefined) {
    lines.push(`- سقف التعليقات لكل منشور: حتى ${brief.commentsPerPost} تعليق`);
  }

  if (brief.targetVolume !== undefined) {
    lines.push(`- حجم البيانات الإجمالي المستهدف: حتى ${brief.targetVolume} سجل`);
  } else if (brief.postCount && brief.commentsPerPost) {
    lines.push(`- حجم البيانات الإجمالي المستهدف: حتى ${brief.postCount * brief.commentsPerPost} سجل`);
  } else {
    lines.push("- حجم البيانات: غير محدد بعد");
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
  userId?: string,
): Promise<ResearchBrief> {
  const cached = briefCache.get(conversationId);
  if (cached) return { ...cached };

  if (!tables) {
    return { platforms: [], topics: [] };
  }

  if (tables && typeof (tables as any).from === "function") {
    try {
      const { data } = await (tables as any)
        .from("conversations")
        .select("brief, user_id")
        .eq("id", conversationId)
        .maybeSingle();

      if (data && userId && data.user_id && data.user_id !== userId) {
        return { platforms: [], topics: [] };
      }

      if (data?.brief && typeof data.brief === "object") {
        briefCache.set(conversationId, data.brief);
        return data.brief;
      }
    } catch {
      // Supabase read fallback
    }
    return { platforms: [], topics: [] };
  }

  try {
    const notesRes = await (tables as any).listRows({
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
  tables: any,
  conversationId: string,
  userId: string,
  brief: ResearchBrief,
): Promise<void> {
  briefCache.set(conversationId, { ...brief });

  if (!tables) return;

  if (typeof tables.from === "function") {
    try {
      const q = tables
        .from("conversations")
        .update({ brief, updated_at: new Date().toISOString() })
        .eq("id", conversationId);
      if (userId) {
        q.eq("user_id", userId);
      }
      await q;
    } catch {
      // Non-fatal
    }
    return;
  }

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
