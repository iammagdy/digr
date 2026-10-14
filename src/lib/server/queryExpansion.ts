import { ResearchIntentSpec } from "./researchIntent";

export interface ExpandedSearchStrategy {
  primaryTopic: string;
  arabicQueries: string[];
  englishQueries: string[];
  industrySynonyms: string[];
  hashtags: string[];
  allQueries: string[];
}

export interface ProviderExecutionQuery {
  queryText: string;
  platform: string;
  mappedParams: Record<string, any>;
}

const DOMAIN_LEXICONS: Record<
  string,
  {
    triggers: RegExp;
    arabic: string[];
    english: string[];
    synonyms: string[];
    hashtags: string[];
  }
> = {
  mep_electromechanical: {
    triggers: /(كهروميكانيكا|كهروميكانيكية|mep|إلكتروميكانيكال|الكتروميكانيكال|تكييف وتبريد|إنذار حريق)/i,
    arabic: [
      "مقاولات كهروميكانيكية مصر",
      "شركات أعمال إلكتروميكانيكال القاهرة",
      "مقاول MEP مصر",
      "أنظمة تكييف ومكافحة حريق مقاولات",
      "هندسة كهروميكانيكية مقاولون مصر",
    ],
    english: [
      "MEP contractors Egypt",
      "electromechanical engineering Cairo",
      "mechanical electrical plumbing companies Egypt",
      "HVAC fire fighting contractors Egypt",
    ],
    synonyms: [
      "مقاولات MEP",
      "أعمال ميكانيكا وكهرباء",
      "شبكات إطفاء وإنذار",
      "محطات قوى كهربائية",
      "أعمال التكييف المركزي",
    ],
    hashtags: ["#كهروميكانيكا", "#MEP", "#مقاولات_مصر", "#هندسة_كهروميكانيكية"],
  },

  egypt_national_football: {
    triggers: /(منتخب مصر|الفراعنة|كأس العالم|مباراة مصر|بلجيكا|أهداف مصر|تشكيل المنتخب)/i,
    arabic: [
      "منتخب مصر",
      "مباراة منتخب مصر",
      "أهداف منتخب مصر ملخص",
      "كأس العالم منتخب مصر",
      "تفاعل الجمهور مع منتخب مصر",
    ],
    english: [
      "Egypt national football team",
      "Egypt World Cup match highlights",
      "Pharaohs Egypt football",
    ],
    synonyms: [
      "الفراعنة",
      "تشكيل منتخب مصر",
      "تصفيات كأس العالم مصر",
      "مباراة مصر الودية",
    ],
    hashtags: ["#منتخب_مصر", "#الفراعنة", "#كأس_العالم_2026", "#مصر"],
  },

  real_estate_egypt: {
    triggers: /(عقارات|تطوير عقاري|العاصمة الإدارية|التجمع|الشيخ زايد|شقق|فيلات)/i,
    arabic: [
      "شركات تطوير عقاري مصر",
      "مشاريع العاصمة الإدارية الجديدة",
      "شركات استثمار عقاري القاهرة",
      "أفضل مطورين عقاريين مصر",
    ],
    english: [
      "real estate developers Egypt",
      "New Capital Egypt property companies",
      "property developers Cairo",
    ],
    synonyms: ["تطوير عمراني", "استثمار عقاري", "مشروعات سكنية وتجارية"],
    hashtags: ["#عقارات_مصر", "#التطوير_العقاري", "#العاصمة_الإدارية"],
  },
};

/**
 * Generates an expanded multi-angle search strategy from user research intent
 */
export function expandResearchStrategy(intent: ResearchIntentSpec): ExpandedSearchStrategy {
  const topic = intent.topic.value;
  const geo = intent.geographicScope.value;
  const geoSuffix = geo && !geo.includes("غير محدد") ? ` ${geo.split(" ")[0]}` : "";

  for (const [, lexicon] of Object.entries(DOMAIN_LEXICONS)) {
    if (lexicon.triggers.test(topic)) {
      const all = Array.from(
        new Set([
          topic,
          ...lexicon.arabic,
          ...lexicon.english,
          ...lexicon.synonyms,
        ])
      );
      return {
        primaryTopic: topic,
        arabicQueries: lexicon.arabic,
        englishQueries: lexicon.english,
        industrySynonyms: lexicon.synonyms,
        hashtags: lexicon.hashtags,
        allQueries: all,
      };
    }
  }

  // General heuristic expansion
  const arabicQueries = [
    topic,
    `أبحاث ودراسات ${topic}${geoSuffix}`,
    `إحصائيات وبيانات ${topic}`,
    `تقرير شامل ${topic}`,
  ];

  const englishQueries = [
    `${topic} research`,
    `${topic} data and statistics`,
  ];

  const cleanTag = `#${topic.replace(/\s+/g, "_")}`;
  const hashtags = [cleanTag];

  const allQueries = Array.from(new Set([...arabicQueries, ...englishQueries]));

  return {
    primaryTopic: topic,
    arabicQueries,
    englishQueries,
    industrySynonyms: [],
    hashtags,
    allQueries,
  };
}

export const expandSearchStrategy = expandResearchStrategy;

/**
 * Maps a search query string to provider execution parameters matching
 * the specific capability schema (separating search strategy from execution payload).
 */
export function buildProviderExecutionQuery(
  queryText: string,
  capability: { slug: string; tregEndpointId: string; paramsSchema?: any },
  intent: ResearchIntentSpec
): ProviderExecutionQuery {
  const params: Record<string, any> = {};
  const schema =
    typeof capability.paramsSchema === "string"
      ? JSON.parse(capability.paramsSchema)
      : capability.paramsSchema || {};

  const propKeys = Object.keys(schema.properties || {});

  if (propKeys.includes("query")) {
    params.query = queryText;
  } else if (propKeys.includes("q")) {
    params.q = queryText;
  } else if (propKeys.includes("keyword")) {
    params.keyword = queryText;
  } else if (propKeys.includes("search_query")) {
    params.search_query = queryText;
  } else if (propKeys.includes("postUrl")) {
    params.postUrl = queryText;
  } else if (propKeys.includes("videoId")) {
    params.videoId = queryText;
  }

  // Handle count / limit if specified in schema
  if (propKeys.includes("max_results")) {
    params.max_results = Math.min(intent.sampleSize.value, 500);
  } else if (propKeys.includes("count")) {
    params.count = Math.min(intent.sampleSize.value, 500);
  }

  return {
    queryText,
    platform: capability.slug.split("-")[0] || "web",
    mappedParams: params,
  };
}
