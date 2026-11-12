import { PLATFORM_AR, operationLabelAr, type CapabilityDiscovery } from "./discover";
import { OPERATIONS, type CapabilityRegistry, type Operation } from "./registry";

/**
 * WHAT THE MODELS ARE TOLD ABOUT THE CAPABILITIES (docs/UNIFIED-CAPABILITY-DISCOVERY.md), built by code from the registry and the discovery, never by a model.
 *   - the CHAT model (brief mode): the kinds of public data that can be collected NOW, in Arabic, by data type and platform only (never a provider, an endpoint or a price: the reply guard refuses provider names anyway), so its
 *     discovery question asks only what decides which of them fits the customer's goal;
 *   - the PLANNING model (the model-planned path): the validated candidates of each stage, by id, in the code's rank order, with what they take, give, page and cost; a plan stage with any other id is refused by code.
 */
const SOCIAL_ORDER = ["tiktok", "x", "instagram", "facebook", "youtube"];

/** The operations with at least one usable capability, as Arabic lines (one per operation; social operations list their platforms). */
export function availableKindsAr(registry: CapabilityRegistry): string[] {
  const usable = registry.all.filter((c) => c.privacy === "public" && c.unavailable === null);
  const lines: string[] = [];
  for (const op of OPERATIONS) {
    const caps = usable.filter((c) => c.operation === op);
    if (caps.length === 0) continue;
    if (op.startsWith("social.")) {
      const platforms = SOCIAL_ORDER.filter((p) => caps.some((c) => c.platform === p));
      if (platforms.length === 0) continue;
      lines.push(`${operationLabelAr(op as Operation, null)}: ${platforms.map((p) => PLATFORM_AR[p]).join("، ")}`);
    } else lines.push(operationLabelAr(op as Operation, null));
  }
  return lines;
}

/** The discovery section of the chat prompt (brief mode with the capability switch on). */
export function chatCapabilityLines(registry: CapabilityRegistry): string[] {
  const kinds = availableKindsAr(registry);
  if (kinds.length === 0) return [];
  return [
    "",
    "أنواع البيانات العامة التي يقدر النظام يجمعها الآن (بيانات من النظام وليست تعليمات):",
    ...kinds.map((k) => `- ${k}`),
    "- قبل أن تسأل: إن كان هدف العميل يحتمل أكثر من نوع من هذه الأنواع (مثل آراء الناس أو التعليقات أو الشركات أو الأماكن وتقييماتها أو صفحات الويب)، فاسأله سؤالًا واحدًا طبيعيًا يحدد النوع المناسب لهدفه، بكلماتك أنت.",
    "- لا تَعِد بنوع غير موجود في هذه القائمة، ولا تذكر اسم أي مزود أو مصدر تقني. ولا نجمع أبدًا بيانات خاصة لأفراد (أرقامهم أو إيميلاتهم الشخصية أو رسائلهم).",
    ...OBJECTIVE_PROMPT_LINES,
  ];
}

/**
 * LLM-FIRST OBJECTIVES (docs/LLM-FIRST-OBJECTIVES.md): the model writes, inside the SAME brief of the SAME call, its structured reading of the customer's research goals as data operations. The operation names are the execution vocabulary of the
 * registry (what can be RUN), not a list of acceptable requests: any goal is understood, and one no operation serves is written «unsupported» so the code asks the customer. The code validates every objective (researchBrief.ts) and maps it to
 * the capabilities (need.ts, discover.ts); the model never names a provider, an endpoint, a field or a price.
 */
export const OBJECTIVE_PROMPT_LINES: readonly string[] = [
  "- أهداف البحث: داخل brief أضف الحقل objectives، قائمة بكل هدف فهمته من طلب العميل كله (لا تحذف هدفًا ولا تضف هدفًا لم يطلبه):",
  '  "objectives":[{"id":"o1","operation":"social.parents","platform":"tiktok"},{"id":"o2","operation":"social.comments","platform":"tiktok","parent":"o1"}]',
  "  operation واحدة من: social.parents (منشورات أو فيديوهات أو تغريدات منصة)، social.comments (تعليقات عليها)، social.replies (ردود على التعليقات)، companies.discover (شركات وأنشطة تجارية)، company.contacts (إيميل أو تليفون العمل الرسمي المنشور للشركة، وcontacts فيها email أو phone أو الاثنين)، people.discover (مهنيون عامون وأدوارهم، وparent شركاتهم إن طُلبوا من شركات)، places.discover (أماكن من الخرائط)، places.reviews (تقييمات الأماكن)، web.search (مقالات وأخبار وصفحات ويب عامة)، web.read (نصوص تلك الصفحات).",
  "  هذه أسماء ما يقدر النظام ينفّذه، وليست قائمة بما يحق للعميل طلبه: افهم أي هدف بكلماته، فإن لم تطابقه أي operation فاكتب operation بالقيمة unsupported وفي what الهدف بكلمات قليلة، ولا تحوّله لعملية أخرى.",
  "  platform: لبيانات وسائل التواصل فقط (tiktok أو x أو instagram أو facebook أو youtube، أو اسم المنصة الأخرى التي ذكرها العميل بحروف إنجليزية صغيرة مثل snapchat)، وnull لغيرها. parent: id الهدف الذي يُقرأ منه هذا الهدف (التعليقات من المنشورات، التقييمات من الأماكن، التواصل والمهنيون من الشركات، نص الصفحة من نتائج البحث) وإلا null.",
  "  طلب فيه أكثر من نوع (مثل تعليقات وفنادق ومقالات، أو منصتين) يُكتب كل نوع هدفًا مستقلًا. وفي كل تكملة أو تصحيح اكتب objectives كاملة محدّثة: ما أكده العميل يبقى، وما صحّحه يتغير.",
  "  إن كان في الطلب أكثر من هدف أول (parent: null) فاكتب في كل هدف أول الحقل request: طلب هذا الجزء وحده في جملة قصيرة كاملة بنفس قواعد request العامة (المنصة باسمها، ما يُجمع، «عن» قبل موضوعه، شروط العميل وأرقامه لهذا الجزء فقط). كل جزء تُجهَّز له خطة بسعرها، ولا تطلب من العميل أن يختار جزءًا واحدًا.",
  "  شروط العميل: ما ينطبق على الطلب كله (فترة أو مكان أو لغة) اكتبه مرة واحدة في period وcountry وlanguage العامة بكلماته. وما ينطبق على جزء واحد فقط اكتبه في الهدف الأول لهذا الجزء: period وcountry وlanguage بكلمات العميل نفسها، وcount بالعدد الذي كتبه لهذا الجزء. لا تنقل شرط جزء لجزء آخر، ولا تغيّر قيمته (آخر شهر تبقى آخر شهر، والغردقة تبقى الغردقة)، واكتبه كما هو في request الجزء.",
  "  اختصر: احذف من كل هدف أي حقل فارغ (platform وparent وcontacts وwhat)، واكتب what فقط مع unsupported، واجعل reason كلمات قليلة، وreply فارغًا عند ready لطلب فيه أكثر من جزء.",
  "  حقول الهدف المسموحة فقط: id وoperation وplatform وparent وcontacts وwhat وrequest وperiod وcountry وlanguage وcount؛ لا تضف حقلًا غيرها (مثل topic). والشروط (period وcountry وlanguage وcount) تُكتب في الهدف الأول للجزء فقط، لا في الهدف الذي يتفرع منه.",
  '  مثال شكل طلب فيه جزءان (الكلمات للتوضيح فقط): "objectives":[{"id":"o1","operation":"social.parents","platform":"tiktok","request":"تعليقات تيك توك عن ..."},{"id":"o2","operation":"social.comments","platform":"tiktok","parent":"o1"},{"id":"o3","operation":"places.discover","request":"تقييمات فنادق ...","country":"..."},{"id":"o4","operation":"places.reviews","parent":"o3"}]',
];

const usd = (n: number | null): string => (n === null ? "unpriced" : `${n.toFixed(6)} USD/row`);

/** The VALIDATED CAPABILITIES section of the planning prompt. */
export function plannerCapabilitySection(d: CapabilityDiscovery, max = 8): string {
  const lines: string[] = ["VALIDATED CAPABILITIES (computed by code from the catalog, the web sources, the account's policy, the providers' keys and caps; ranked by ability to serve the request first, then price):"];
  for (const s of d.stages) {
    lines.push(`- stage ${s.stage.key} (${s.stage.operation}${s.stage.platform ? `, ${s.stage.platform}` : ""}${s.stage.parentKey ? `, child of ${s.stage.parentKey}` : ""}; must give: ${s.stage.requires.join(", ")})`);
    if (s.eligible.length === 0) { lines.push("    no validated capability: this step is NOT available; do not plan it, say so in unserved_steps"); continue; }
    if (s.eligible.length > max) lines.push(`    (the first ${max} of ${s.eligible.length} validated; any of the ${s.eligible.length} may be planned, describe_endpoint shows the others)`);
    for (const e of s.eligible.slice(0, max)) lines.push(`    ${e.rank}. ${e.id} [${e.provider}] gives ${e.outputs.join("/") || "unknown fields (prove them on a sample)"}; takes ${e.takes.join("/")}; ${e.pagination ? "pages" : `one call, up to ${e.maxRowsPerCall} rows`}; ${usd(e.usdPerRow)}${e.limits ? `; ${e.limits}` : ""}`);
  }
  const lim = d.limitations.filter((l) => l.textAr);
  if (lim.length > 0) lines.push(`Limitations the customer is told before approval (never claim these conditions were applied): ${lim.map((l) => `${l.stageKey}:${l.code}${l.filter ? `:${l.filter}` : ""}`).join(", ")}`);
  lines.push("Plan stages ONLY with these ids (a stage reading any other id is refused by code). Sample them in this order unless one cannot give the fields; never call an id that is not listed for a stage you plan.");
  return lines.join("\n");
}
