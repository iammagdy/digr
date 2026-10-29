-- ROLLBACK of 01. Run it ONLY after the rollout switch is OFF and after 02/03/04 were rolled back (or no pool key exists):
-- deleting this secret makes every pool key stored with it unreadable (the main key and the old key store are not affected).
DELETE FROM vault.secrets WHERE name = 'diger-treg-pool-enc-key';
