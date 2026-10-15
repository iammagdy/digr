import { z } from "zod";
import { isCompanyRowMatchingLocation } from "../planParameters";

export type RelevanceDecision = "match" | "no_match" | "uncertain";

export interface RowRelevanceReview {
  index: number;
  id?: string;
  decision: RelevanceDecision;
  reasonAr: string;
}

export interface RelevanceReviewBatchInput {
  customerRequest: string;
  targetCountry: string;
  targetIndustryAr: string;
  rows: Array<{
    index: number;
    id?: string;
    company_name?: string;
    industry?: string;
    description?: string;
    location?: string;
    website?: string;
  }>;
}

const RowReviewSchema = z.object({
  index: z.number().int().min(0),
  decision: z.enum(["match", "no_match", "uncertain"]),
  reasonAr: z.string().trim().min(1).max(200),
});

const BatchReviewResponseSchema = z.object({
  reviews: z.array(RowReviewSchema),
});

/**
 * Deterministic rule-based fallback when LLM is unavailable, in mock/fake mode, or errors.
 */
export function evaluateDeterministicRelevance(
  row: Record<string, any>,
  targetCountry: string,
  targetIndustryAr: string
): { decision: RelevanceDecision; reasonAr: string } {
  // 1. Strict Geographic Check: Never deliver rows from another country than requested
  if (targetCountry && !isCompanyRowMatchingLocation(row, targetCountry)) {
    return {
      decision: "no_match",
      reasonAr: `خارج النطاق الجغرافي المطلوب (${targetCountry})`,
    };
  }

  const rowInd = String(row.industry || "").toLowerCase().trim();
  const rowDesc = String(row.description || "").toLowerCase().trim();
  const rowName = String(row.company_name || row.name || "").toLowerCase().trim();
  const rowText = `${rowInd} ${rowDesc} ${rowName}`;

  if (!rowInd && !rowDesc) {
    return {
      decision: "uncertain",
      reasonAr: "بيانات النشاط غير متوفرة في المصدر وتتطلب مراجعة يدوية",
    };
  }

  const indAr = targetIndustryAr.toLowerCase();

  // A. Construction / Contracting (مقاولات وتشيد)
  if (indAr.includes("مقاولات") || indAr.includes("تشييد") || indAr.includes("بناء")) {
    const isExcludedUnrelated =
      (rowInd.includes("real estate") && !rowText.includes("general contracting") && !rowText.includes("مقاولات عامة")) ||
      rowInd.includes("interior design") ||
      rowInd.includes("oil & energy") ||
      rowInd.includes("oil and gas") ||
      rowInd.includes("wood") ||
      rowInd.includes("machinery") ||
      rowInd.includes("electronic") ||
      rowInd.includes("furniture");

    if (isExcludedUnrelated) {
      return {
        decision: "no_match",
        reasonAr: `النشاط الفعلي (${row.industry || "غير مطابق"}) ليس شركة مقاولات أو تشييد`,
      };
    }

    const isMatch =
      rowText.includes("construction") ||
      rowText.includes("contracting") ||
      rowText.includes("civil engineering") ||
      rowText.includes("general contracting") ||
      rowText.includes("مقاولات") ||
      rowText.includes("تشييد") ||
      rowText.includes("بناء");

    if (isMatch) {
      return {
        decision: "match",
        reasonAr: "شركة مقاولات وتشييد مطابقة للطلب",
      };
    }

    return {
      decision: "uncertain",
      reasonAr: "نشاط هندسي قد يرتبط بالمقاولات، أُحيل إلى سجل المراجعة",
    };
  }

  // B. IT & Software (تقنية المعلومات والبرمجيات)
  if (indAr.includes("تقنية") || indAr.includes("تكنولوجيا") || indAr.includes("برمجيات") || indAr.includes("معلومات")) {
    const isExcluded =
      rowInd.includes("construction") ||
      rowInd.includes("real estate") ||
      rowInd.includes("food") ||
      rowInd.includes("furniture");

    if (isExcluded) {
      return {
        decision: "no_match",
        reasonAr: `النشاط (${row.industry || "غير مطابق"}) غير مرتبط بتقنية المعلومات`,
      };
    }

    const isMatch =
      rowText.includes("software") ||
      rowText.includes("information technology") ||
      rowText.includes("technology") ||
      rowText.includes("internet") ||
      rowText.includes("computer") ||
      rowText.includes("برمجيات") ||
      rowText.includes("تقنية");

    if (isMatch) {
      return {
        decision: "match",
        reasonAr: "شركة تقنية معلومات وبرمجيات مطابقة",
      };
    }

    return {
      decision: "uncertain",
      reasonAr: "تحتاج مراجعة لتأكيد تخصص البرمجيات",
    };
  }

  // C. Space / Aerospace (صناعة الصواريخ والفضاء)
  if (indAr.includes("صواريخ") || indAr.includes("فضاء") || indAr.includes("صاروخ")) {
    const isMatch =
      rowText.includes("aerospace") ||
      rowText.includes("rocket") ||
      rowText.includes("space") ||
      rowText.includes("missile") ||
      rowText.includes("defense");

    if (isMatch) {
      return {
        decision: "match",
        reasonAr: "مطابقة لمجال صناعات الفضاء والصواريخ",
      };
    }

    return {
      decision: "no_match",
      reasonAr: "غير مطابقة لمجال الصواريخ والفضاء",
    };
  }

  // D. Solar / Renewable Energy (الطاقة الشمسية والمتجددة)
  if (indAr.includes("شمسية") || indAr.includes("طاقة متجددة") || indAr.includes("solar")) {
    const isMatch =
      rowText.includes("solar") ||
      rowText.includes("photovoltaic") ||
      rowText.includes("renewable") ||
      rowText.includes("طاقة شمسية");

    if (isMatch) {
      return {
        decision: "match",
        reasonAr: "شركة طاقة شمسية ومتجددة مطابقة",
      };
    }

    return {
      decision: "no_match",
      reasonAr: "غير مرتبطة بالطاقة الشمسية",
    };
  }

  // Default fallback
  return {
    decision: "match",
    reasonAr: "سجل مطابق للبحث",
  };
}

/**
 * Executes batch review of company records using Claude Haiku or deterministic rules.
 * Enforces strict country matching deterministically on top of any LLM decision.
 */
export async function reviewCompanyBatch(
  input: RelevanceReviewBatchInput
): Promise<RowRelevanceReview[]> {
  const { customerRequest, targetCountry, targetIndustryAr, rows } = input;

  if (!rows || rows.length === 0) return [];

  const apiKey = process.env.ANTHROPIC_API_KEY;
  const isLlmActive =
    Boolean(apiKey) &&
    process.env.LLM_PROVIDER !== "fake" &&
    process.env.LLM_ENABLED !== "false";

  let llmReviews: RowRelevanceReview[] = [];

  if (isLlmActive) {
    try {
      const rowsSummary = rows.map((r) => ({
        index: r.index,
        name: r.company_name,
        industry: r.industry || "N/A",
        location: r.location || "N/A",
        website: r.website || "N/A",
        description: (r.description || "").slice(0, 200),
      }));

      const prompt = `You are the strict Relevance Validation Layer for Diger AI platform.
Customer original request: "${customerRequest}"
Target country: "${targetCountry}"
Target industry: "${targetIndustryAr}"

Review each candidate company against the request.
Rules:
1. "match": The company genuinely operates in the requested industry and in "${targetCountry}".
   NOTE FOR CONTRACTING / CONSTRUCTION ("مقاولات"): Real estate developers who only develop/sell properties, interior designers, oil & gas drilling, and wood traders are NOT contractors/construction companies and must be "no_match".
2. "uncertain": Borderline company or insufficient data to be 100% sure.
3. "no_match": Company is outside "${targetCountry}", operates in a different industry, or has empty industry.

Return ONLY valid JSON matching this schema:
{
  "reviews": [
    { "index": 0, "decision": "match" | "no_match" | "uncertain", "reasonAr": "short Arabic explanation" }
  ]
}

Candidate companies:
${JSON.stringify(rowsSummary, null, 2)}`;

      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey!,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: process.env.ANTHROPIC_MODEL || "claude-haiku-5-5",
          max_tokens: 1500,
          temperature: 0,
          messages: [{ role: "user", content: prompt }],
        }),
      });

      if (res.ok) {
        const data = await res.json();
        const textContent = data.content?.[0]?.text || "";
        const jsonMatch = textContent.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          const validated = BatchReviewResponseSchema.safeParse(parsed);
          if (validated.success) {
            llmReviews = validated.data.reviews;
          }
        }
      }
    } catch (err) {
      console.warn("[relevance:llm_call_fallback]", err);
    }
  }

  // Final merge with deterministic safety guards
  return rows.map((row) => {
    const deterministic = evaluateDeterministicRelevance(row, targetCountry, targetIndustryAr);

    // Geographic boundary is an absolute invariant: if outside target country, ALWAYS no_match
    if (targetCountry && !isCompanyRowMatchingLocation(row, targetCountry)) {
      return {
        index: row.index,
        id: row.id,
        decision: "no_match",
        reasonAr: deterministic.reasonAr,
      };
    }

    const llmReview = llmReviews.find((r) => r.index === row.index);
    if (llmReview) {
      // If LLM said match, but deterministic rules flagged it as excluded unrelated (e.g. real estate in contracting), override
      if (llmReview.decision === "match" && deterministic.decision === "no_match") {
        return {
          index: row.index,
          id: row.id,
          decision: "no_match",
          reasonAr: deterministic.reasonAr,
        };
      }

      return {
        index: row.index,
        id: row.id,
        decision: llmReview.decision,
        reasonAr: llmReview.reasonAr || deterministic.reasonAr,
      };
    }

    return {
      index: row.index,
      id: row.id,
      decision: deterministic.decision,
      reasonAr: deterministic.reasonAr,
    };
  });
}
