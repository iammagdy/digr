import { detectCountryFromText } from "../../lib/planParameters";
import { detectMentionedPlatforms, type Capability } from "./capabilityRegistry";
import { isSocialCapabilitySlug } from "../../lib/socialSources";

/**
 * «اجمع ١٠ دراسات عن الطاقة الشمسية في ألمانيا»: a topic-gathering request (studies, articles, news, reports).
 * No executable service collects academic material directly, so the customer gets ONE specific question that names
 * their topic and country and offers the sources that do exist, instead of the generic "write the topic" sentence.
 */
const GATHER_NOUN = /(دراسات|دراسة|أبحاث|ابحاث|بحوث|ورقة بحثية|أوراق بحثية|أوراق علمية|ورقة علمية|مواد علمية|مواد أكاديمية|مواد بحثية|مقالات علمية|مقالات أكاديمية|مقالات|أخبار|اخبار|تقارير|مراجع|مصادر)/;
const TOPIC_AFTER = /(?:عن|حول|بخصوص|في موضوع|تخص|تتناول)\s+(.+)$/;
const TIME_TAIL = /\s+(?:خلال|منذ|في آخر|في اخر|آخر|اخر|مع|بحد|لا تزيد)\s.*$/;

export interface TopicGatheringRequest {
  noun: string;
  topic: string;
  countryAr?: string;
}

export const TOPIC_SOURCE_OPTIONS_AR = ["منشورات من منصة إكس", "فيديوهات من يوتيوب", "تعليقات وفيديوهات من تيك توك", "شركات تعمل في هذا المجال"];

export function detectTopicGathering(text: string): TopicGatheringRequest | null {
  const t = (text || "").trim();
  // The customer already chose a source for this request (an answer to the question below): nothing left to ask.
  if (/المصدر المطلوب\s*:/.test(t)) return null;
  const nounMatch = GATHER_NOUN.exec(t);
  const noun = nounMatch?.[1];
  if (!noun || !nounMatch) return null;
  // A named platform, a company or a people search is a different service with its own questions.
  if (detectMentionedPlatforms(t).some((p) => p !== "companies")) return null;
  if (/شركات|شركة|مؤسسات|مدير|مديرين|صناع\s+(?:ال)?قرار|حساب|قناة|رابط|https?:\/\//.test(t)) return null;

  // The topic follows the noun ("دراسات عن ..."), not an earlier "عن" in "ابحث لي عن دراسات حول ...".
  let topic = TOPIC_AFTER.exec(t.slice(nounMatch.index + noun.length))?.[1]?.trim() || "";
  topic = topic.replace(TIME_TAIL, "").replace(/[.،,؟?!]+$/g, "").trim();
  const country = detectCountryFromText(t);
  if (country) {
    const idx = topic.lastIndexOf(" في ");
    if (idx > 0 && detectCountryFromText(topic.slice(idx + 4))) topic = topic.slice(0, idx).trim();
  }
  if (topic.length < 2) return null;
  return { noun, topic, countryAr: country?.arabicLabel };
}

export function hasTopicResearchService(capabilities: Capability[]): boolean {
  // (a social service is never a topic-research service, whatever its slug says: the Facebook topic report's slug names «topic», and it reads posts, not studies)
  return (capabilities || []).some((c) => !isSocialCapabilitySlug(c.slug) && /topic|academic|scholar|serp|web[-_.]search|news/i.test(`${c.slug} ${c.platform || ""} ${c.category || ""}`));
}

export function topicSourceQuestion(request: TopicGatheringRequest) {
  const where = request.countryAr ? ` في ${request.countryAr}` : "";
  const text = `عن «${request.topic}»${where}: من أي مصدر تريد أن أجمع ${request.noun}؟`;
  return { id: "topic_source_required", text, question: text, type: "single" as const, options: TOPIC_SOURCE_OPTIONS_AR, allowOther: true };
}

/**
 * Studies, papers, articles and news from websites are not a service yet. The customer is told so plainly, with what IS
 * available and an example on the same topic. No social platform is ever offered as a source of studies.
 */
export function studiesUnavailableReplyAr(request: TopicGatheringRequest): string {
  const where = request.countryAr ? ` في ${request.countryAr}` : "";
  return [
    `جمع ${request.noun} عن «${request.topic}»${where} غير متاح بعد في ديجر، ولن أخمّن مصدرًا بديلًا لأن منصات التواصل ليست مصدرًا للدراسات.`,
    "المتاح الآن: قوائم الشركات حسب النشاط والدولة، وصناع القرار مع بيانات التواصل، ومنشورات وتعليقات وفيديوهات إكس وتيك توك ويوتيوب وفيسبوك.",
    `إن أردت، اكتب مثلًا: «١٠ تغريدات عن ${request.topic}» أو «٥ شركات في هذا المجال${request.countryAr ? ` في ${request.countryAr}` : ""}» وأجهز لك الخطة والسعر.`,
  ].join("\n");
}
