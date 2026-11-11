import { buildRequestContract } from "../../src/lib/agentMission/requestContract";
import { buildAsk } from "../../src/lib/agentMission/foundation/ask";
import { legacyRouteOf, platformOptionOf, withPlatformChoice } from "../../src/lib/agentMission/platformQuestion";
import { classifyMessage } from "../../src/lib/agentMission/messageType";
import { preModelAnswer } from "../../src/lib/agentMission/guardRules";
import { identityQuestionKind } from "../../src/lib/assistantIdentity";
import { isGreetingOrGeneralQuestion } from "../../src/functions/shared/briefManager";
import { findUnresolvedResearchPlaceholder } from "../../src/lib/researchPlaceholders";
import { requestWantsContacts } from "../../src/lib/agentMission/contacts";

/**
 * PR-0.1 (semantic regression baseline): ONE read-only view of how today's code UNDERSTANDS a customer's words, assembled only from the existing pure functions. No network, no model, no database, no flag.
 *
 * What it mirrors (and what it does not):
 *   - `prefilter` follows the order the code applies BEFORE a request reaches the agent: the template-placeholder check (`api/chat/route.ts`), the identity answer (`chatHandler`), the greeting / general-question skip of the agent gate (`chatHandler`), then the fixed
 *     pre-model answers (`agentChatTurn`: privacy, account, trust). It does NOT replay every other branch of `chatHandler` (file shaping, methodology, studies), so «agent» means «none of the audited pre-filters stopped it», not «a mission is certain».
 *   - the contract / Ask fields are what the worker reads (`runMission`): a platform the customer TAPPED on the platform card is kept for the whole mission (`withPlatformChoice`), a typed answer is only appended to the request text.
 *   - `route` assumes every platform flag is `on` (the production setting of 2026-11-11, docs/HANDOFF.md and the audit): a request with a platform takes the compiled path, one without goes to `legacyRouteOf`.
 *   - `message_type` is the KEYWORD classifier only. In production the chat model decides first and this classifier only rescues a data request or answers when the model call fails.
 */
export interface Understood {
  prefilter: "placeholder" | "identity" | "greeting" | "general_question" | "privacy_refusal" | "privacy_clarify" | "account" | "trust" | "agent";
  platform: string | null;
  kind: string | null;
  count: number | null;
  comments: string;
  replies: string;
  topic: string | null;
  source_named: boolean;
  /** The contract says the words asked for a country / a period / a language (a FLAG: the value is `country` / `period` / `language`). */
  country_present: boolean;
  period_present: boolean;
  language_present: boolean;
  country: string | null;
  period: { from: string; to: string } | null;
  language: string | null;
  media: string | null;
  route: "compiled" | "legacy" | "platform_question" | "clarify";
  wants_email: boolean;
  message_type: string;
}

/** The moment the fixture's relative dates count back from: the Cairo day 2026-11-11 (a Wednesday). */
export const SEMANTIC_NOW_MS = Date.parse("2026-11-11T09:00:00Z");

export function understand(text: string, answer: string | null = null, nowMs: number = SEMANTIC_NOW_MS, options: { semantic?: boolean } = {}): Understood {
  let mission: { request_text: string; answer_text: string | null } = { request_text: text, answer_text: answer };
  // runMission: the platform the customer TAPPED is kept for the whole mission when the request names none of its own
  const tapped = platformOptionOf(mission.answer_text);
  if (tapped && buildRequestContract(mission.request_text, undefined, options).platform === null) mission = withPlatformChoice(mission, tapped);

  const contract = buildRequestContract(mission.request_text, mission.answer_text, options);
  const ask = buildAsk(mission.request_text, mission.answer_text, nowMs, {}, options);
  const general = isGreetingOrGeneralQuestion(text);
  const fixed = preModelAnswer(text);
  const prefilter: Understood["prefilter"] = findUnresolvedResearchPlaceholder(text)
    ? "placeholder"
    : identityQuestionKind(text)
      ? "identity"
      : general.isGreeting
        ? "greeting"
        : general.isGeneralQuestion
          ? "general_question"
          : fixed
            ? fixed.kind
            : "agent";
  return {
    prefilter,
    platform: contract.platform,
    kind: contract.parentKind,
    count: contract.count,
    comments: contract.comments,
    replies: contract.replies,
    topic: contract.topic,
    source_named: contract.source.named,
    country_present: contract.country,
    period_present: contract.period,
    language_present: contract.language,
    country: ask.country,
    period: ask.period ? { from: ask.period.from, to: ask.period.to } : null,
    language: ask.language,
    media: contract.media ?? null,
    route: contract.platform ? "compiled" : legacyRouteOf(mission.request_text, mission.answer_text),
    wants_email: requestWantsContacts(mission.request_text).email,
    message_type: classifyMessage(text),
  };
}
