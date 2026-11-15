# P0, 15 Nov 2026: overly literal search and a false «no match» conclusion

## Production evidence (read-only)

Three real missions made the same request, with the understanding layer and discovery ON globally:
- `msn_84d0f3738c87d5ed3aee`
- `msn_7758164aa2b4a840fda5`
- `msn_47c4016d9099f63c2bb5`

The request asked for up to 400 tweets of the Saudi Ministry of Health's account «عن الشائعات أو التصدي للشائعات أو جهود الوزارة في مكافحة الشائعات» over the last five years.

| Fact | Value |
|---|---|
| Source question | asked before pricing; the customer answered `@SaudiMOH — https://x.com/SaudiMOH` |
| Query sent (each mission, both calls) | `"الشائعات أو التصدي للشائعات أو جهود الوزارة" from:SaudiMOH since:2021-11-14_22:00:00_UTC until:… -filter:replies` |
| Call 1 | 0 rows, with a `nextCursor` |
| Call 2 | the SAME query with that cursor, 0 rows |
| Raw rows returned | 0 in all 6 calls (nothing was filtered after retrieval) |
| Outcome | `unserved`; «بحثنا في المصادر المتاحة فلم نجد ما يطابق طلبك، ولم يُخصم منك شيء.» |
| Customer points | none held, none charged |
| Internal spend | 6 search calls, USD 0.00294 (`mission_calls.cost_usd`), plus planning model USD 0.000679 (0.000229 + 0.000226 + 0.000224). **Total USD 0.003619.** |
| Customer panel | «لقينا المصادر» shown as done (any planning call marked it) |
| Chat | Asked «هل بحثت فقط داخل حساب @SaudiMOH …؟ وما المصادر التي بحثت فيها بالضبط؟», the assistant answered that the details were «مكتوبة في خطة الطلب المعروضة أمامك». No plan existed. |

## Root cause, proved

1. **Overly literal search construction (the cause).**
   - `buildAsk` read the topic as ONE phrase, «الشائعات أو التصدي للشائعات أو جهود الوزارة», with the literal «أو» kept inside it.
   - The third alternative was cut at «في», where the parser stops a topic for a place.
   - The X card quotes the topic, so one exact sentence was searched. No tweet contains that sentence.
   - The provider's own note says: «bare terms are ANDed … use one short phrase or OR between alternatives».
2. **Planning sample exhaustion (an aggravating cause).** The second of the two samples the gateway allows for one source was spent on the cursor of an EMPTY page. It returned 0 rows again, as it had in every recorded case.
3. **Not the cause: unsupported syntax.**
   - `since:`/`until:` answered rows on this card in production (`"العاصمة الإدارية" lang:ar since:… until:…`, 20 rows).
   - A grouped `OR` answered rows (`الذكاء الاصطناعي (أعتقد OR رأيي OR برأيي OR أرى) lang:ar -filter:replies`, 20 rows; `(to:… OR to:…)`, 20 rows a call).
   - `from:` is the catalog's documented operator. No production `from:` call has returned rows yet, because only the improbable phrase was ever sent with it.
4. **Not the cause: filtering after retrieval.** 0 raw rows came back.
5. **Provider coverage or pagination.** These cannot be judged from an improbable phrase, and nothing here assumes them.

## The fix (general: one language rule and the card's own data; no topic, account or platform word list)

**Alternatives** (`foundation/topicAlternatives.ts`, `ask.ts`):
- The customer's disjunction words («أو», «او», «or», a slash between words) separate alternative concepts. They go to `Ask.topic.alternatives`.
- The last alternative keeps the words written after «في», unless they name a country, which stays the country condition.
- A topic with no disjunction is untouched.

**Query** (`compilePlan.ts` `topicQueryOf`, the X card `query.or: "OR"`):
- On a card that documents a disjunction, alternatives are ONE group: `(الشائعات OR "التصدي للشائعات" OR "جهود الوزارة في مكافحة الشائعات")`.
- The account operator (`from:`), the period and originals-only are kept as before.
- A card without a documented disjunction searches the first alternative, never the sentence with «أو». The plan says so.

**Relevance** (`pool.ts` `topicTierOf`):
- An item is about the topic when it names ANY alternative, each read by the existing rule.
- «أو» is never a required word.

**Validation of every row:**
- The exact author check is unchanged.
- **X rows are now also checked by their own date.** The mapping writes ISO instants. Before, the code relied on `since:`/`until:`.
- **A search that carries a named source by its operator is a topic gate.** A row naming none of the alternatives is never chosen. When rows of the account exist but none is about the topic, the customer is asked before anything is priced (the existing «no_about» question).

**Bounded strategies** (`relaxedInputsOf`, `agent/src/compiled.ts`):
- When the first page of an operator search holds NO row, its cursor is not followed. The one remaining sample, the same two reads as before (`SEARCH_STRATEGIES_MAX = 2`), tries ONE relaxed strategy that keeps every written condition:
  - one phrase of several words: its words unquoted;
  - a source carried by its operator: the source's own posts in the period, each then checked for the topic.
- There is no relaxed read for alternatives without a source. The request never broadens to all of X.
- Rows are deduplicated by id across strategies.

**Truthful end** (`foundation/searchScope.ts`, `runMission.ts`). With no plan, the customer reads:
- what was searched: the account they gave, the platform, the period, the alternatives and the strategies tried;
- the observed counts: returned, from the account, in the period, naming the topic;
- that this does not prove the account never posted about it;
- that nothing was priced or charged.

It has no provider name, no price and no Latin identifier.

**Progress panel** (`customerView.ts`): a request that ended with no plan never shows «لقينا المصادر» or the sample as done.

**Chat** (`chatTurn.ts`): a reply that speaks of a plan, in a conversation whose latest request has none, is replaced by the facts. Either «لم تُجهَّز خطة لطلبك الأخير …، ولم يُخصم منك شيء.» followed by the request's own end sentence, or, while planning, «لم تُجهَّز خطة لطلبك بعد …».

Pricing, reservations, settlement, the ledger and the feature switches are unchanged.

## Tests (offline, no paid call)

`tests/p0-x-literal-search.test.ts` (22 tests, on `tests/fixtures/p0-x-account/production-2026-11-15.json`) covers:
- the root-cause proof;
- A (alternatives and the OR group);
- B (`from:` and the period in every strategy);
- C (one matching post gives a plan for one post, with source, topic, price and shortfall);
- D (an empty first page goes to the relaxed strategy, not the cursor);
- E (no fabricated row);
- F (other accounts, out-of-period rows and off-topic rows are never planned);
- G (at most two reads);
- H (the truthful end, at compiler and worker level, with 0 held and 0 charged);
- I (progress steps);
- the chat's plan claim;
- K (an ordinary single-topic X query is byte-identical, and a non-empty first page still reads its next page);
- L (a card without a documented disjunction).

The 14 Nov fixture tests and the full suite cover the other platforms and pricing.

## What remains unverified live

- A real search of this account with the OR group. No paid call was made. Whether the provider returns the account's posts for `(… OR …) from:SaudiMOH` over five years is proved only by a real mission.
- The provider's depth for an account over five years. A plan can contain at most the rows read in the two planning samples, about 40. The plan says when that is fewer than asked.
- Arabic morphology in the SEARCH: the provider matches whole words, so «شائعة» is not «الشائعات». Relevance by code already reads «للشائعات», «الشائعات» and «شائعات» as the same word. A proposed next step, not done here, is for the understanding layer to suggest grounded variants.
