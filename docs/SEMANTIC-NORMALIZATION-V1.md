# Semantic normalization v1 (PR-1.1): an isolated, flag-gated foundation

**Status: code and tests only. Not connected to the product. Flag `semantic_normalization_v1` is OFF by default and nothing sets it. No customer sees any change.**

## What exists

`src/lib/agentMission/semantic/`

| File | Job |
|---|---|
| `normalizeArabic.ts` | `normalizeArabic(raw)`: conservative, idempotent text (NFKC / presentation forms, invisible characters, diacritics, tatweel, Arabic and Persian digits to Western, stretched letters, links, punctuation, spaces). Every Arabic letter stays as typed. `matchKey(token)`: the spelling folds (أإآ→ا, ى→ي, ة→ه, ڤ→ف …) used only to *compare* with the vocabulary. `explainNormalization` lists which steps changed a text. The input is never altered or stored. |
| `lexicon.ts` | The controlled vocabulary: 5 platforms, 5 content kinds (posts, videos, comments, replies, tweets), the Egyptian asks (عايز/عاوز/محتاج, هات, اجمع, طلعلي …). Whole tokens only; clitics (و ف ب ل ك ع ال) and pronoun endings (كومنتاتهم) are accepted for platform and content words only. |
| `interpret.ts` | `interpretRequest(text)`: platform (`resolved` / `ambiguous` / `multiple` / `none`), requested content, parent kind, topic, ambiguities. Never guesses; keeps a TOPIC apart from a requested OUTPUT. |
| `flag.ts` | `readSemanticNormalizationFlag(settings)` (true only for the boolean `true` or the string `"on"` under the key `semantic_normalization_v1` of the `agent_settings` object, the place the redesign flags already live) and `interpretIfEnabled(settings, text)` (null when OFF). Reads an object it is given; writes nothing. |

Deliberately **not** in the vocabulary: any messenger (WhatsApp, Telegram …) and «رسايل»/«messages». A semantic reading therefore cannot express «read a private conversation». `guardRules.ts` (PR #447) and `messageType.normalize` do not import this module and are unchanged.

A bare «x» / «اكس» is the X platform only after a platform cue («على X», «منصة X») with content requested and no name cue in front («مطعم اسمه X» is a name). Otherwise it stays `ambiguous`.

## Integration point (a later PR, not this one)

`buildRequestContract` (`requestContract.ts`) would call `interpretIfEnabled(settings, text)`; only when the result is not null would it fill a field the existing regexes left empty (never override a filled one, never override the privacy rules). With the flag OFF that call returns null and the parser behaves as it does today. This PR does not make that call anywhere.

## What it can address, measured against the PR #446 baseline (98 scenarios, 62 known gaps)

Measured offline by `tests/semantic-normalization.test.ts` on the 54 gap cases that are single-turn (the 8 multi-turn gaps carry a typed answer and are not read here):

* **24 gaps are in this layer's scope and the isolated reading gets them right** (platform spelling L3, comments spelling L1, topic after «الخاصة ب» L5, a topic cut at an output field or an exclusion X1): sa-01, sa-02, sa-03, sa-08, sb-09, pl-04, pl-05, pl-07, pl-11, pl-14, pl-15, pl-16, pl-17, pl-22, pl-23, pl-24, pl-25, cm-02, cm-05, cm-06, cm-09, ct-07, rt-04, rt-05.
* **6 more are partly addressed** (the platform or comments are right, the topic is not): sa-04, sa-06, cm-08, dt-04, dt-11, rt-03. They need a topic rule without a marker, a trailing date or country cut (PR-1.2).
* **24 are outside this layer** and untouched: dates (L4: dt-02, dt-07…dt-10), countries and language (L4: ct-04, ct-05, ct-10, sb-01, sb-02, pl-21), e-mail (L6: sb-11…sb-13), pre-filter false positives (W1, W2, W3, W4, W6: pf-01…pf-06, pf-09), routing (K2 pl-19, K5 rt-06), message type (L7 cm-13).
* **Actually fixed for customers: 0.** The layer is not integrated, so **all 62 known gaps remain exactly as PR #446 pinned them** (`it.fails` still passes for each; no fixture entry was deleted or rewritten).
* The reading is not a drop-in replacement: on the one non-gap case where today's code is right and the reading differs (cm-11, topic «رأي الناس في الذكاء الاصطناعي» vs «الذكاء الاصطناعي») today's parser stays authoritative. That is why the integration point only fills empty fields.

## Next (PR-1.2, not started)

Dates, countries and languages in the same controlled style; the integration behind the flag (fill-only, test accounts first); then the pre-filter false positives (W1–W6), which are separate from vocabulary.
