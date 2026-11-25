import { buildRequestContract } from "../requestContract";
import { buildAsk } from "../foundation/ask";
import { legacyRouteOf, platformOptionOf, withPlatformChoice } from "../platformQuestion";
import { classifyMessage } from "../messageType";
import { privateContactAsk, privateMessagesAsk, personalIdentifierAsk } from "../guardRules";
import { identityQuestionKind } from "../../assistantIdentity";
import { isGreetingOrGeneralQuestion } from "../../../functions/shared/briefManager";
import { findUnresolvedResearchPlaceholder } from "../../researchPlaceholders";
import { requestWantsContacts } from "../contacts";

/**
 * PHASE 7: HOW THE REQUEST IS UNDERSTOOD, TODAY AND WITH THE SEMANTIC LAYER. One read-only view assembled from the existing pure functions only (the same ones `tests/helpers/semanticUnderstand.ts` mirrors for the paraphrase baseline):
 * `semantic: false` is production today (`semantic_normalization_v1` unset); `semantic: true` is what the switch would do. No network, no model, no database, no switch is read or written. The moment relative dates count back from is a
 * parameter, so a replay is deterministic.
 *
 * It mirrors, and does not replay, the chat: `prefilter` follows the order of the audited pre-filters (placeholder, identity, greeting, fixed pre-model answers); `route` assumes every platform switch is on (the production setting of 14 Nov 2026).
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
  country_present: boolean;
  period_present: boolean;
  language_present: boolean;
  country: string | null;
  period: { from: string; to: string } | null;
  language: string | null;
  media: string | null;
  route: "compiled" | "legacy" | "platform_question" | "clarify";
  wants_email: boolean;
  wants_phone: boolean;
  /** The columns the words asked for (contract `wants`), in order. */
  wants: string[];
  /** The deterministic privacy guards of the chat, read on the words alone. */
  guard: { privateContact: boolean; privateMessages: boolean; personalIdentifier: boolean };
}

/** The moment the paraphrase baseline counts relative dates back from: the Cairo day 2026-11-11. */
export const SHADOW_NOW_MS = Date.parse("2026-11-11T09:00:00Z");

export function understandForShadow(text: string, answer: string | null = null, options: { semantic: boolean; nowMs?: number }): Understood {
  const ctxOptions = { semantic: options.semantic };
  const nowMs = options.nowMs ?? SHADOW_NOW_MS;
  let mission: { request_text: string; answer_text: string | null } = { request_text: text, answer_text: answer };
  // the platform the customer TAPPED is kept for the whole mission when the request names none of its own (runMission)
  const tapped = platformOptionOf(mission.answer_text);
  if (tapped && buildRequestContract(mission.request_text, undefined, ctxOptions).platform === null) mission = withPlatformChoice(mission, tapped);
  const contract = buildRequestContract(mission.request_text, mission.answer_text, ctxOptions);
  const ask = buildAsk(mission.request_text, mission.answer_text, nowMs, {}, ctxOptions);
  const general = isGreetingOrGeneralQuestion(text);
  const prefilter: Understood["prefilter"] = findUnresolvedResearchPlaceholder(text)
    ? "placeholder"
    : identityQuestionKind(text) ? "identity"
      : general.isGreeting ? "greeting"
        : general.isGeneralQuestion ? "general_question"
          : "agent";
  const contacts = requestWantsContacts(mission.request_text);
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
    wants_email: contacts.email,
    wants_phone: contacts.phone,
    wants: [...(contract.wants ?? [])].map(String),
    guard: { privateContact: privateContactAsk(text), privateMessages: privateMessagesAsk(text), personalIdentifier: personalIdentifierAsk(text) },
  };
}
