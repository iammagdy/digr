/**
 * THE SYNTHETIC PROVIDER ROWS of the live-intelligence evaluation (moved out of run.eval.ts in round 52 so they are tested without the paid harness). Fictional, never fetched, never real data: they only let the REAL planner be
 * measured on rows it can reason about. Nothing in production imports this file.
 */
/**
 * REALISTIC SYNTHETIC provider rows (never real data, nothing is fetched): plausible FICTIONAL names, Arabic text on the topic the planner searched, recent dates, shaped by what the endpoint serves. Round 1 used obvious placeholders
 * («نتيجة تجريبية», example.org) and the real planner rightly refused to plan from them ("any company I delivered would be invented"): the planner is now measured on rows it can reason about. The names are invented for this evaluation.
 */
export const NAMES = ["النخبة", "الريادة", "الأفق", "المرجان", "الواحة", "لؤلؤة البحر", "النجمة الذهبية", "الصفوة", "البيان", "المدار", "الشروق", "الياسمين"];
export const LATIN = ["alnokhba", "alreyada", "alofok", "almorgan", "alwaha", "loloat-albahr", "golden-star", "alsafwa", "albayan", "almadar", "alshorouk", "alyasmin"];
/** Twelve different review texts (round 52: four or five repeated texts with authors «مستخدم ١…٢٠» were rightly read by the planner as placeholder reviews, Z35). */
export const REVIEW_TEXTS = ["الخدمة ممتازة والموظفين محترمين", "المكان نظيف بس الأسعار عالية شوية", "تجربة متوسطة والانتظار كان طويل", "أنصح بيه جدًا للعائلات", "التطبيق سهل وسريع في التحويلات", "بيعلق وقت الضغط ومحتاج تحديث", "الرسائل بتتأخر ساعات أحيانًا", "التحديث الأخير حلّ مشكلة الدخول", "خدمة العملاء ردّت بسرعة وحلّت المشكلة", "التوصيل اتأخر بس الأكل وصل سخن", "الأسعار مناسبة والعروض كويسة", "واجهة الاستخدام محتاجة تبقى أوضح"];
export function syntheticTreg(endpointId: string, params: Record<string, unknown>): unknown {
  // (round 52: the inputs are read at ANY depth. Structured filters ({filters: {industry: {include: [...]}, location_country: {include: ["AE"]}}}, {job_title: [...]}) were ignored, so a Dubai marketing search returned generic Cairo rows
  // «السوق المحلي» and the real planner rightly gave up (J3, G2, Z16 of round 51): a real source answers the filters it was given)
  const texts: Array<[string, string]> = [];
  const walk = (k: string, v: unknown, depth: number): void => {
    if (depth > 5) return;
    if (typeof v === "string") texts.push([k, v]);
    else if (Array.isArray(v)) for (const x of v) walk(k, x, depth + 1);
    else if (v && typeof v === "object") for (const [k2, x] of Object.entries(v)) walk(/^(?:include|any|all|values?|in|eq)$/i.test(k2) ? k : k2, x, depth + 1);
  };
  walk("", params ?? {}, 0);
  const NOT_TOPIC = /^(?:url|link|domain|website|country|country_code|gl|hl|lang|language|location|location_?code|location_country|region|city|geo|cursor|next|page|sort|order|engine|type|format|exclude)$/i;
  const anyText = texts.filter(([k, v]) => v.trim().length >= 3 && !NOT_TOPIC.test(k) && !/^https?:/i.test(v)).map(([, v]) => v);
  const q = String(params?.query ?? params?.q ?? params?.keyword ?? params?.keywords ?? params?.search ?? params?.term ?? params?.company ?? (anyText.join(" ") || "")).replace(/\s+/g, " ").trim().slice(0, 60) || "السوق المحلي";
  // the SECTOR words of the search (no «companies», «in», the place): a real company is «النخبة للطاقة الشمسية», never «النخبة شركات الطاقة الشمسية في مصر» (the planner rightly read names that repeat the whole query as placeholders)
  const GENERIC = new Set(["companies", "company", "firms", "firm", "agency", "agencies", "in", "the", "of", "and", "at", "for", "egypt", "egyptian", "uae", "dubai", "cairo", "saudi", "arabia", "riyadh", "managers", "manager", "شركات", "شركة", "في", "مصر", "الإمارات", "الامارات", "دبي", "القاهرة", "السعودية", "مديري", "مدير"]);
  const topicOf = (t: string): string => t.split(/\s+/).filter((w) => w && !GENERIC.has(w.toLowerCase())).slice(0, 3).join(" ") || t;
  const companyTexts = texts.filter(([k, v]) => /compan|industry|sector|keyword/i.test(k) && v.trim().length >= 3 && !/^https?:/i.test(v)).map(([, v]) => v);
  const sector = topicOf(companyTexts.length > 0 ? companyTexts.join(" ").slice(0, 60) : q);
  const latin = /^[\x00-\x7F]+$/.test(sector);
  const cap = (w: string) => w.split(/[-\s]+/).map((x) => x.charAt(0).toUpperCase() + x.slice(1)).join(" ");
  const companyName = (i: number): string => (latin ? `${cap(LATIN[i])} ${cap(sector)}` : `${NAMES[i]} ${sector.startsWith("ال") ? `لل${sector.slice(2)}` : `ل${sector}`}`);
  const id = endpointId.toLowerCase();
  const n = 10;
  // (round 51: the place and the country of the synthetic rows follow the planner's own query, for every city of the corpus: rows from «القاهرة» for a Sharm El-Sheikh or Dubai search were rightly refused by the planner as not matching)
  const allText = `${q} ${texts.map(([, v]) => v).join(" ")}`;
  const PLACES: Array<[RegExp, string, string]> = [[/شرم|sharm/i, "شرم الشيخ", "EG"], [/غردق|hurghada/i, "الغردقة", "EG"], [/اقصر|أقصر|luxor/i, "الأقصر", "EG"], [/اسكندري|إسكندري|alexandria/i, "الإسكندرية", "EG"], [/معادي|maadi/i, "المعادي، القاهرة", "EG"], [/زمالك|zamalek/i, "الزمالك، القاهرة", "EG"], [/مهندسين|mohandes/i, "المهندسين، الجيزة", "EG"], [/دبي|dubai/i, "دبي", "AE"], [/رياض|riyadh/i, "الرياض", "SA"], [/جدة|jeddah/i, "جدة", "SA"]];
  const place = PLACES.find(([re]) => re.test(allText));
  const countryOf = place ? place[2] : /امارات|الإمارات|uae|emirates|(?:^|[^A-Za-z])AE(?![A-Za-z])/i.test(allText) ? "AE" : /سعودي|saudi|(?:^|[^A-Za-z])SA(?![A-Za-z])/.test(allText) ? "SA" : "EG";
  const cityOf = place ? place[1] : countryOf === "AE" ? "دبي" : countryOf === "SA" ? "الرياض" : "القاهرة";
  const day = (i: number) => `2026-11-${String(10 - (i % 9)).padStart(2, "0")}T0${i % 9}:15:00Z`;
  const AUTHORS = ["أحمد سمير", "منى خالد", "كريم فؤاد", "سارة عادل", "محمود نبيل", "ريم حسن", "عمرو صلاح", "نهى إبراهيم", "طارق عزت", "دينا مصطفى", "يوسف رأفت", "هبة علي"];
  let rows: Array<Record<string, unknown>>;
  // round 51: app stores (a search of apps; the reviews of one app). Round 52: an App Store search answers App Store ids and links (it answered Google Play ones, and the planner rightly could not find the App Store page, Z35),
  // and only the FIRST app carries the searched name (six apps «إنستاباي …» made the planner ask which one)
  if (/search\.apps|search_apps/.test(id)) {
    const apple = /app[-_.]?store|apple|itunes/.test(id);
    const appName = (i: number) => (i === 0 ? q : `${NAMES[i]} ${["", "Pay", "Wallet", "Plus", "Lite", "Pro"][i]}`.trim());
    rows = Array.from({ length: 6 }, (_, i) => apple
      ? { id: `${1400000000 + i * 7919}`, app_id: `${1400000000 + i * 7919}`, bundle_id: `com.${LATIN[i].replace(/-/g, "")}.ios`, title: appName(i), name: appName(i), developer: `${NAMES[i]} للتقنية`, rating: 3.8 + (i % 3) / 5, reviews_count: 12000 - i * 900, url: `https://apps.apple.com/eg/app/${LATIN[i]}/id${1400000000 + i * 7919}`, link: `https://apps.apple.com/eg/app/${LATIN[i]}/id${1400000000 + i * 7919}` }
      : { app_id: `com.${LATIN[i].replace(/-/g, "")}.app`, id: `com.${LATIN[i].replace(/-/g, "")}.app`, title: appName(i), name: appName(i), developer: `${NAMES[i]} للتقنية`, rating: 3.8 + (i % 3) / 5, reviews_count: 12000 - i * 900, link: `https://play.google.com/store/apps/details?id=com.${LATIN[i].replace(/-/g, "")}.app`, url: `https://play.google.com/store/apps/details?id=com.${LATIN[i].replace(/-/g, "")}.app` });
  }
  else if (/review/.test(id)) rows = Array.from({ length: n }, (_, i) => ({ review_id: `r${i}${id.length}`, rating: 1 + ((i * 3) % 5), text: REVIEW_TEXTS[(i * 5) % REVIEW_TEXTS.length], author: AUTHORS[i % AUTHORS.length], date: day(i), place_id: `pl_${i}` }));
  else if (/maps|places|local|apple_maps|business/.test(id) && !/compan/.test(id)) rows = Array.from({ length: n }, (_, i) => ({ place_id: `pl_${i}`, name: `${NAMES[i]} — ${q}`, address: `شارع ${NAMES[(i + 3) % 12]}، ${cityOf}`, city: cityOf, rating: 3.6 + (i % 4) / 5, reviews_count: 40 + i * 13, phone: `+2010${String(2000000 + i * 3571).slice(0, 7)}`, website: `https://${LATIN[i]}.com`, maps_url: `https://maps.google.com/?cid=${1000 + i}`, category: q }));
  else if (/employee|people|linkedin|person|contact\.search/.test(id)) rows = Array.from({ length: n }, (_, i) => ({ person_id: `p${i}`, full_name: AUTHORS[i], title: ["مدير التسويق", "مديرة التسويق الرقمي", "رئيس قسم المبيعات", "مديرة العلامة التجارية"][i % 4], company: companyName(i), company_domain: `${LATIN[i]}.com`, location: cityOf, profile_url: `https://www.linkedin.com/in/${LATIN[i]}-${i}` }));
  else if (/email|phone/.test(id)) rows = Array.from({ length: 3 }, (_, i) => ({ value: ["info@", "sales@", "contact@"][i] + `${LATIN[0]}.com`, type: "generic", source_page: `https://${LATIN[0]}.com/contact` }));
  else if (/compan|organization|firm|openmart/.test(id)) rows = Array.from({ length: n }, (_, i) => ({ company_id: `c${i}`, name: companyName(i), website: `https://${LATIN[i]}.com`, domain: `${LATIN[i]}.com`, industry: sector, city: cityOf, country: countryOf, employees: 15 + i * 7, description: `${companyName(i)}: شركة متخصصة في ${sector}، تأسست في ${2008 + i}` }));
  else if (/scrape|extract|contents|fetch|read/.test(id)) rows = [{ url: String(params?.url ?? `https://${LATIN[1]}-news.com/a1`), title: `${q}: تطورات جديدة`, text: `يتناول هذا المقال ${q} من عدة زوايا، ويعرض آراء المختصين وأحدث الأرقام المنشورة رسميًا.`, published_at: day(1) }];
  else rows = Array.from({ length: n }, (_, i) => ({ title: [`${q}: تطورات جديدة هذا الأسبوع`, `خبراء يعلّقون على ${q}`, `أرقام رسمية حول ${q}`, `${q} بين التحديات والفرص`][i % 4], url: `https://${LATIN[i]}-news.com/${2026}/11/article-${i + 1}`, snippet: `تقرير عن ${q} يتناول آخر المستجدات وآراء المختصين.`, source: `${NAMES[i]} نيوز`, date: day(i), position: i + 1 }));
  return { data: rows, results: rows, items: rows, next_cursor: null };
}
