import { resolveProviderKey } from "./providerKeys";
import { detectIndustryFromText, isCompanyRowMatchingLocation } from "../planParameters";
import { industryLabelForSentence } from "../industryLabels";

export type RelevanceDecision = "match" | "no_match" | "uncertain";

/**
 * Deterministic rule-based fallback when LLM is unavailable, in mock/fake mode, or errors.
 */
export function evaluateDeterministicRelevance(
  row: Record<string, any>,
  targetCountry: string,
  targetIndustryAr: string
): { decision: RelevanceDecision; reasonAr: string; evidence?: "own_text" } {
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

  // Electricity request: a company whose own text describes air conditioning, heating, refrigeration or plumbing is a
  // different industry even when the source files it under an energy or engineering label. It is shown for review and is
  // neither delivered nor charged; an explicit electrical activity in the same text keeps the normal path.
  if (targetIndustryAr.toLowerCase().includes("الكهرباء")) {
    const unrelatedTrade =
      /\b(hvac|air[- ]?condition\w*|heating|ventilat\w*|refrigerat\w*|chiller\w*|plumbing)\b|تكييف|تبريد|تدفئة|تهوية|سباكة/u.test(rowText);
    // The source label alone ("Electrical/Electronic Manufacturing") is not evidence; the company's own name or description is.
    const explicitElectrical = /\belectric(?:al|ity)?\b|كهربا/u.test(`${rowDesc} ${rowName}`);
    if (unrelatedTrade && !explicitElectrical) {
      return {
        decision: "uncertain",
        reasonAr: "نشاط الشركة يبدو تكييفًا أو تبريدًا أو سباكة لا كهرباء؛ أُحيل السجل للمراجعة ولم يُحتسب",
      };
    }
  }

  // The source taxonomy's broad "Utilities" label also contains unrelated water, fencing, and
  // other service businesses. Require corroborating electrical/power evidence before delivering
  // such a row for an electricity request; otherwise keep it visible for review without charging.
  // Energy-adjacent labels (oil & energy, renewables, engineering, electrical manufacturing...) with the company's OWN text
  // describing electric power work are delivered; the label alone, or other text, is not enough.
  const energyAdjacent = /^(?:utilities|oil & energy|oil and gas|renewables & environment|electrical\/electronic manufacturing|mechanical or industrial engineering|industrial automation|machinery|construction|civil engineering)$/.test(rowInd);
  if (targetIndustryAr.toLowerCase().includes("الكهرباء") && energyAdjacent && rowInd !== "utilities") {
    const strongElectrical = /\b(electric(?:al|ity)?|substations?|transformers?|switchgear|power (?:distribution|transmission|generation|plants?|grid)|high voltage|grid)\b|كهربا|محطات? (?:توليد|محولات)|محولات/u.test(`${rowDesc} ${rowName}`);
    if (strongElectrical) {
      // `evidence: "own_text"`: this match rests on the company's own name or description, not on the source label.
      return { decision: "match", reasonAr: "نص الشركة يصف نشاط الكهرباء، وتصنيف المصدر قريب من القطاع", evidence: "own_text" };
    }
  }
  if (targetIndustryAr.toLowerCase().includes("الكهرباء") && rowInd === "utilities") {
    const clearlyUnrelated =
      /water treatment|chemical supplies|perimeter fencing|fencing|android game|game hacking|تهكير ألعاب|معالجة المياه|الأسوار|سياج/u.test(rowText);
    if (clearlyUnrelated) {
      return {
        decision: "no_match",
        reasonAr: "وصف النشاط يوضح مجالاً مختلفاً عن الكهرباء؛ استُبعد السجل ولم يُحتسب",
      };
    }
    const hasElectricalEvidence =
      /\b(electric(?:al|ity)?|power|grid)\b/.test(rowText) ||
      /كهربا|طاقة كهربائية|شبكة الكهرباء/u.test(rowText);
    if (!hasElectricalEvidence) {
      return {
        decision: "uncertain",
        reasonAr: "تصنيف المصدر واسع ولا يؤكد نشاط الكهرباء؛ أُحيل السجل للمراجعة ولم يُحتسب",
      };
    }
  }

  if (!rowInd) {
    return {
      decision: "uncertain",
      reasonAr: "مجال النشاط غير وارد في المصدر؛ أُحيل السجل للمراجعة ولم يُحتسب ضمن السجلات المسلّمة",
    };
  }

  const indAr = targetIndustryAr.toLowerCase();

  // A. Construction / Contracting (مقاولات وتشيد)
  if (indAr.includes("مقاولات") || indAr.includes("تشييد") || indAr.includes("بناء")) {
    // Sectors that are clearly not contracting stay excluded.
    const isExcludedUnrelated =
      (rowInd.includes("real estate") && !rowText.includes("general contracting") && !rowText.includes("مقاولات عامة")) ||
      rowInd.includes("interior design") ||
      rowInd.includes("wood") ||
      rowInd.includes("furniture") ||
      // The row's own text describes oil and gas operations (not just an energy-sector label).
      /drilling|exploration|petroleum|oil and gas|oil & gas|refiner/.test(rowText);

    if (isExcludedUnrelated) {
      return {
        decision: "no_match",
        reasonAr: `النشاط الفعلي (${industryLabelForSentence(row.industry)}) ليس شركة مقاولات أو تشييد`,
      };
    }

    const hasContractingSignal =
      rowText.includes("construction") ||
      rowText.includes("contracting") ||
      rowText.includes("contractor") ||
      rowText.includes("civil engineering") ||
      rowText.includes("general contracting") ||
      rowText.includes("مقاولات") ||
      rowText.includes("مقاول") ||
      rowText.includes("تشييد") ||
      rowText.includes("بناء");
    const isElectromechanicalRequest = indAr.includes("كهروميكانيك");
    const hasElectromechanicalSignal =
      rowText.includes("electromechanical") ||
      /(?<![a-z0-9])mep(?![a-z0-9])/.test(rowText) ||
      rowText.includes("mechanical and electrical") ||
      rowText.includes("mechanical & electrical") ||
      rowText.includes("كهروميكانيك");

    if (hasContractingSignal || (isElectromechanicalRequest && hasElectromechanicalSignal)) {
      return {
        decision: "match",
        reasonAr: "شركة مقاولات وتشييد مطابقة للطلب",
      };
    }

    // Energy, electronics and machinery firms may be real electromechanical contractors that the
    // source files under those labels, so they are never dropped on the label alone: they go to
    // the review sheet and are neither delivered nor charged until reviewed.
    const isAmbiguousEngineering =
      rowInd.includes("oil & energy") ||
      rowInd.includes("oil and gas") ||
      rowInd.includes("machinery") ||
      rowInd.includes("electronic") ||
      rowInd.includes("electrical") ||
      rowInd.includes("mechanical") ||
      rowInd.includes("utilities");
    if (isAmbiguousEngineering) {
      return {
        decision: "uncertain",
        reasonAr: `النشاط المسجل في المصدر (${industryLabelForSentence(row.industry)}) قد يشمل مقاولات؛ أُحيل السجل للمراجعة ولم يُحتسب`,
      };
    }

    return {
      decision: "uncertain",
      reasonAr: "نشاط هندسي قد يرتبط بالمقاولات، أُحيل إلى سجل المراجعة",
    };
  }

  // B. FinTech (التكنولوجيا المالية والمدفوعات)
  if (indAr.includes("fintech") || indAr.includes("فينتك") || indAr.includes("تكنولوجيا مالية") || indAr.includes("تقنية مالية") || indAr.includes("مدفوعات")) {
    const isExcluded =
      rowInd.includes("construction") ||
      rowInd.includes("real estate") ||
      rowInd.includes("food") ||
      rowInd.includes("furniture");

    if (isExcluded) {
      return {
        decision: "no_match",
        reasonAr: `النشاط (${industryLabelForSentence(row.industry)}) غير مرتبط بالتكنولوجيا المالية`,
      };
    }

    const isMatch =
      rowText.includes("fintech") ||
      rowText.includes("financial technology") ||
      rowText.includes("payment") ||
      rowText.includes("banking") ||
      rowText.includes("مدفوعات") ||
      rowText.includes("تكنولوجيا مالية") ||
      rowText.includes("تمويل");

    if (isMatch) {
      return {
        decision: "match",
        reasonAr: "شركة تكنولوجيا مالية ومدفوعات مطابقة للطلب",
      };
    }

    return {
      decision: "uncertain",
      reasonAr: "تحتاج مراجعة لتأكيد تخصص التكنولوجيا المالية",
    };
  }

  // C. IT & Software (تقنية المعلومات والبرمجيات)
  if (indAr.includes("تقنية") || indAr.includes("تكنولوجيا") || indAr.includes("برمجيات") || indAr.includes("معلومات")) {
    const isExcluded =
      rowInd.includes("construction") ||
      rowInd.includes("real estate") ||
      rowInd.includes("food") ||
      rowInd.includes("furniture");

    if (isExcluded) {
      return {
        decision: "no_match",
        reasonAr: `النشاط (${industryLabelForSentence(row.industry)}) غير مرتبط بتقنية المعلومات`,
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

  // Other recognized sectors: the source's own industry label must name the requested sector.
  // A provider keyword hit alone is never a match; a label outside the sector goes to review.
  const sector = detectIndustryFromText(targetIndustryAr);
  const sectorLabels = (sector.exactTaxonomy || []).map((label) => label.toLowerCase());
  if (sectorLabels.some((label) => rowInd === label || rowInd.includes(label))) {
    return {
      decision: "match",
      reasonAr: `النشاط المسجل في المصدر (${industryLabelForSentence(row.industry)}) يطابق المجال المطلوب`,
    };
  }

  // For custom sectors there is no deterministic criterion, so the record stays reviewable.
  return {
    decision: "uncertain",
    reasonAr: "لا توجد قاعدة تحقق حاسمة لهذا المجال؛ أُحيل السجل للمراجعة",
  };
}
