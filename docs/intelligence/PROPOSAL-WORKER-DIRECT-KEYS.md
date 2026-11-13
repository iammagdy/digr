# Proposal (OWNER APPROVAL REQUIRED, NOT APPLIED): direct Firecrawl / Context.dev keys for the worker

**Audit reference:** PR-2.3 and decision D3 (`docs/intelligence/DIGER_INTELLIGENCE_AUDIT.md` §4.4, §14, §15).

**Status:** proposal only. No secret, permission, migration, Vault entry or environment variable was read, copied, created or changed.

## The facts (safe, non-secret metadata only)

* **How the worker resolves a web provider key.** `agent/src/main.ts` passes `providerKey: async (provider) => (await resolveProviderKey(provider)).key || null`.
  * `resolveProviderKey` reads the encrypted `provider_api_keys` store and decrypts it with `PROVIDER_KEYS_ENCRYPTION_KEY`.
  * If that gives nothing, it reads the environment names `FIRECRAWL_API_KEY` / `CONTEXT_DEV_API_KEY` (`src/lib/server/providerKeys.ts`).
* **What a missing key does.**
  * The planner never sees a provider without a key. `webAvailability.ts` hides its tools, and the capability registry marks it `provider_key_missing`.
  * A call that still reaches the web gateway is refused `source_unavailable` before any request (`agent/src/webGateway.ts`).
* **Recorded history** (read-only aggregate, 13 Nov 2026, `data/capabilities/reliability-snapshot.json` in the Phase 3 PR):
  * `firecrawl.search`: 18 refused calls; `firecrawl.scrape`: 6 refused calls. No direct Firecrawl call ever reached the provider.
  * `contextdev.search`: 24 refused calls.
  * On 13 Nov 2026 direct Context.dev scrapes and parsers DID run (msn_088c: 7 scrapes, 23 e-mail parses, 19 phone parses). A key resolved on the worker that day, by one of the two paths above. Which path is unknown: Heroku configuration values were not read, by rule.
* **The same providers are already reachable without any new key, through TREG.** `firecrawl.web.search`, `firecrawl.web.scrape`, `branddev.web.search`, `branddev.web.scrape` and the `branddev.brand.*` family are TREG catalog ids. They go through the existing TREG gateway, key pool, daily cap and ledger path.
  * Phase 2 of this campaign uses that path for company enrichment (`web_via_treg`, OFF).

## The decision the owner is asked to make

| Option | What it means | Risk | Recommendation |
|---|---|---|---|
| A. Stay TREG-only for Firecrawl / Context.dev search, scrape and brand data | Nothing to change. The direct adapters stay for the Context.dev **parsers** and **people search**, which TREG does not resell. | None new | **Yes, now** (audit D1) |
| B. Vault scheme for direct keys (audit D3) | Store the two keys the same way the TREG key pool does (`tregKeyPool.ts`, Vault-encrypted, decrypted by a database function the worker calls with the service role). The worker then no longer needs `PROVIDER_KEYS_ENCRYPTION_KEY`. | A migration (a new security-definer function, a grant to `service_role`) and two secrets written into Vault by the owner | Later, only if the Context.dev parsers / people search are needed in production and have no verified TREG equivalent |
| C. Copy `PROVIDER_KEYS_ENCRYPTION_KEY` to Heroku | One more place holds the master key of the website's key store | A leaked worker environment exposes every stored provider key | **No** |

## If option B is approved: the exact steps (to be done in a separate, owner-authorized PR)

1. **SQL** (reviewed in the PR, applied by the owner): a function `get_provider_api_key(p_provider text) returns text`, `security definer`, `search_path = ''`.
   * It reads `vault.decrypted_secrets` by a fixed name per provider.
   * It is granted to `service_role` only; `revoke` from `public`, `anon` and `authenticated`.
   * The same pattern as the TREG pool's key function.
2. **Owner action:** create two Vault secrets (`provider_key_firecrawl`, `provider_key_contextdev`) in the Supabase dashboard. No value is ever sent to an agent.
3. **Code:** `resolveProviderKey` tries the RPC first, then the current paths. A unit test with a fake client proves the order and that no value is logged.
4. **Verification without a paid call:**
   * the worker logs `provider_key_source=vault|store|env|none` (the source's name, never the value);
   * the registry's `provider_key_missing` disappears for that provider.
5. **Rollback:** drop the function. The current paths are unchanged.

**Estimated cost of verification:** $0 for steps 1–4. A first real call of each provider is a paid call and needs its own authorization: at most one Context.dev parse (≈ 1 credit) and one Firecrawl search (2 credits), well under $0.05.
