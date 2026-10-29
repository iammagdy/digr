-- PROPOSAL, NOT APPLIED. Additive: creates ONE Vault secret. Touches nothing else.
--
-- What it is: the encryption key for the TREG key pool (AES-256-GCM, 32 random bytes as base64). It is generated INSIDE the
-- database from the database's own random source. Nobody sees it, nobody copies it, nobody pastes it anywhere (not in chat, not in Vercel,
-- not in Heroku). The website and the worker read it through a service-role-only function (file 03: treg_pool_enc_key()).
--
-- It is NOT PROVIDER_KEYS_ENCRYPTION_KEY. That variable, and every key already encrypted with it (TREG main key store, Firecrawl,
-- Context.dev, Anthropic), is not touched.
--
-- Idempotent: running it twice keeps the first secret (a second secret would make the keys encrypted with the first unreadable).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'diger-treg-pool-enc-key') THEN
    PERFORM vault.create_secret(
      encode(extensions.gen_random_bytes(32), 'base64'),
      'diger-treg-pool-enc-key',
      'AES-256-GCM key (base64, 32 bytes) for the TREG key pool. Generated in the database; never displayed.'
    );
  END IF;
END $$;
