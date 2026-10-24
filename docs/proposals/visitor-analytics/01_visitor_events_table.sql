-- STEP 1 of 3: the table of visit records. NOT APPLIED. Apply with 02 and 03, then run 04.
-- One row per beacon: a page view, the time spent when the page was left, a sign-in, a sign-up. INSERT ONLY from the application (service_role).
--
-- What a row can hold (and, by omission, what it can not): an anonymous visitor id and a session id (random, made by the site), the kind of beacon, the path WITHOUT its
-- query string, the host of the referring site, a two-letter country from the hosting platform's header, the device class (the user agent itself is NOT stored),
-- the time, the seconds spent, and the account id ONLY on a sign-in row. There is no column for an IP address, a fingerprint, a user agent, a query string, a request body,
-- chat text, an e-mail address or a token.
--
-- user_id has no foreign key on purpose: a visit record must never block or cascade with an account, and the insert stays one cheap statement.
-- RLS is enabled here, in the same step as the table, with NO policy: anon and authenticated can read or write nothing even before step 3 revokes their grants.

CREATE TABLE IF NOT EXISTS public.visitor_events (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  visitor_id       text        NOT NULL CHECK (visitor_id ~ '^[a-f0-9]{32}$'),
  session_id       text        NOT NULL CHECK (session_id ~ '^[a-f0-9]{16,32}$'),
  kind             text        NOT NULL CHECK (kind IN ('view', 'leave', 'login', 'signup')),
  path             text        NOT NULL CHECK (char_length(path) BETWEEN 1 AND 120 AND path LIKE '/%' AND position('?' IN path) = 0),
  referrer_host    text        NULL     CHECK (referrer_host IS NULL OR char_length(referrer_host) <= 100),
  country          text        NULL     CHECK (country IS NULL OR country ~ '^[A-Z]{2}$'),
  device_class     text        NOT NULL CHECK (device_class IN ('mobile', 'desktop', 'tablet')),
  started_at       timestamptz NOT NULL DEFAULT now(),
  duration_seconds integer     NULL     CHECK (duration_seconds IS NULL OR duration_seconds BETWEEN 0 AND 86400),
  user_id          uuid        NULL
);

COMMENT ON TABLE public.visitor_events IS 'Privacy-safe visit records written by the site beacon (service_role only). No IP, no user agent, no query string, no fingerprint.';
COMMENT ON COLUMN public.visitor_events.user_id IS 'Only on a sign-in row: the account the server verified. Page views never carry it.';

ALTER TABLE public.visitor_events ENABLE ROW LEVEL SECURITY;
