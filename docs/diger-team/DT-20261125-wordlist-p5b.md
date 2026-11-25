# DT-20261125-wordlist-p5b — Phase 5B: Provider Labels & Methodology Platform Resolution

## 1. Overview
- **Authority:** Megz `D-0211` / Commander `go-P5B-hagras.md` & `order-O12-ashraf-gate1-p5b-p6.md` (M4)
- **Branch:** `team/DT-20261125-wordlist-p5b-provider-labels`
- **Base Commit:** `origin/main` `fec6de75` (including Phase 3 `77fb5bc1` and Phase 4 `fec6de75`)
- **Phase 4 Preceding PR Link (Waived from Phase 4):** [PR #686](https://github.com/iammagdy/digr/pull/686)
- **Phase 5B PR Link:** [PR #687](https://github.com/iammagdy/digr/pull/687)

## 2. Scope & Implementation Points

1. **Dynamic Provider Host Extraction (`src/lib/agentMission/providerLabels.ts`):**
   - Eliminated all 93 hardcoded literal provider tokens from `PROVIDER_LABELS`.
   - Replaced with dynamic loader deriving provider host tokens from `data/treg/treg_catalog_index.json` (`providers`) and `data/capabilities/provider-metadata.json` (`web.*.summary.server` host tokens).
   - Zero literal provider names in code (`-93 treg_tokens`).
   - Server-only isolation maintained (no imports into client components).

2. **Catalog-Driven Platform Resolution (`agent/src/methodology.ts`):**
   - Eliminated `PLATFORM_WORDS` keyword parser (`-2 treg_tokens` for `x`, `youtube`).
   - Replaced `platformOfEndpoint` with direct metadata lookup:
     - Primary: Catalog metadata (`ep.platform` from `loadTregCatalog()`).
     - Web Sources: Stage/parser metadata from `data/capabilities/web-sources.json`.
     - Catalog prefix matching for hierarchical endpoints (e.g. `crawl4ai.youtube.channel`).
   - Resolves canonical Arabic text via `PLATFORM_AR` from `src/lib/agentMission/platformLabels.ts`.
   - Customer-facing platform spellings reconciled to canonical `PLATFORM_AR` forms:
     - `instagram` -> `«إنستجرام»` (was `«إنستغرام»`)
     - `linkedin` -> `«لينكدإن»` (was `«لينكد إن»`)
     - `google_maps` / `maps` -> `«خرائط جوجل»` (preserved identical Arabic text)
   - Preserved punctuation trimming regex `/[.،\s]+$/` on line 378 unchanged (`-0 ar` delta).

3. **Provider Labels Parity Test (`tests/provider-labels-parity.test.ts`):**
   - Tests that 100% of historical 95 provider labels are dynamically extracted (0 missing).
   - Asserts that `withoutProviderHosts` strips URLs and bare domains containing provider hostnames for all historical providers.
   - Asserts that legitimate non-provider domains and social platform links are preserved intact.

4. **Methodology Section Test Verification (`tests/methodology-section.test.ts`):**
   - Verified that `platformOfEndpoint` resolves all platform endpoints correctly and returns `null` for non-platform/web endpoints.
   - Pinned canonical `PLATFORM_AR` spellings (`«إنستجرام»`, `«لينكدإن»`, `«خرائط جوجل»`).
