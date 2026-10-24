# Handoff note (2026-10-24): p4-chat-catalog-map

Kept in its own file so the parallel PRs of this session do not conflict in docs/HANDOFF.md; fold it into HANDOFF.md after merging.

## 0000000. Diger AI knows the catalog (branch `claude/chat-catalog-map`, from main `2548785`, DRAFT, merges only after the owner's tester confirms three requests behave as before)

- `src/lib/catalogMap.ts`, built from the SAME data module as /services: (1) a compact map (sector -> platforms, names only; about 700 tokens) in the cached part of the system prompt with the rules that stop the assistant inventing a service; (2) when the customer's message names a platform (whole words, Arabic prefixes, usual spellings: `detectCatalogPlatforms`), that platform's service names by group (`catalogSliceText`, at most 1,200 characters, at most two platforms) join the planning turn as a system message, found by code; (3) «إيه الخدمات؟» / «بتعملوا إيه؟» is answered by code (`isOfferQuestion`, `offerAnswerAr`), no model turn, decision makers first, a pointer to «خدماتنا».
- Why the map has no per-platform groups: `tests/prompt-token-breakdown.test.ts` keeps the fixed prompt inside a calibrated band (13,000 to 18,000 input tokens; the band was NOT changed); the map with every platform's groups is about 2,100 tokens with its rules, the names-only map about 900. The groups arrive with the slice.
- Nothing here decides a plan, a price, a cap or a charge. Fully stated requests (companies, X posts, TikTok comments, Facebook keyword comments) are planned by code with the model never called (`tests/five-request-regression.test.ts`, `tests/capability-registry-phase2.test.ts`), so the slice never reaches them; the map is in the prompt of every model turn.
- Cost per turn (offline estimate from the real prompt, `src/lib/server/llmTurnCost.ts`, target 0.005 USD): typical cached plan reply 0.00376 -> 0.00382, typical short reply 0.00184 -> 0.00190; cautious reading 0.00422 -> 0.00430; a slice adds about 0.0003 to 0.0004 per named platform on a model turn.

---

