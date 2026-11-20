-- Welcome email on email confirmation (Supabase / Resend, no Appwrite).
--
-- Fires the send-email Edge Function (welcome-only path) via pg_net whenever
-- auth.users.email_confirmed_at transitions from NULL -> set. Covers both
-- email-link confirmation (UPDATE) and OAuth signup (INSERT with confirmed email).
--
-- WHAT GOES INTO THE pg_net QUEUE (net.http_request_queue is readable by every database role, so nothing wide or personal may go in):
--   header  x-welcome-key  = a DEDICATED random key that can do nothing except ask for a welcome (Vault secret 'send-email-welcome-key')
--   body    {"welcomeUserId": "<the user's id>"}
-- NO service-role key, NO e-mail address, NO name. The Edge Function (send-email, header x-welcome-key) checks the key in constant time,
-- looks the user up ITSELF, and sends only to that user's own confirmed address, once per user for life (public.welcome_email_log).
--
-- The dedicated key is created ONCE by the project owner, in one pipeline, into BOTH the Vault (name: send-email-welcome-key) and the
-- Edge Function secret WELCOME_TRIGGER_KEY. It is never typed into chat, a repo file or a ticket.
--
-- If the Vault secret is missing or empty, the trigger silently does nothing and does not break auth. Every ordinary error inside the
-- trigger (Vault read, http_post, bad metadata) is swallowed the same way (PL/pgSQL's WHEN OTHERS does not catch query cancellation or
-- assertion failures), so the auth.users INSERT/UPDATE commits.
--
-- Safe to run more than once (extensions and the table are IF NOT EXISTS, the function is
-- CREATE OR REPLACE, the trigger is DROP IF EXISTS + CREATE).

create extension if not exists "pg_net" with schema "extensions";

-- The real extension name on Supabase is supabase_vault (it owns the schema "vault" and the view
-- vault.decrypted_secrets). There is NO extension called "vault". Already installed (production, any
-- Supabase project) -> nothing to do. A failure to enable it must not stop the migration: without the
-- Vault the trigger below simply sends nothing.
do $$
begin
  if not exists (select 1 from pg_extension where extname in ('supabase_vault', 'vault')) then
    begin
      create extension if not exists "supabase_vault" with schema "vault";
    exception when others then
      begin
        create extension if not exists "supabase_vault";
      exception when others then
        raise warning 'welcome_email_on_confirm: supabase_vault could not be enabled (%); the welcome trigger sends nothing until the Vault exists', sqlerrm;
      end;
    end;
  end if;
end
$$;

-- One welcome per user for life. Private: RLS on, no policies, no grants except the server's own role.
create table if not exists public.welcome_email_log (
  user_id uuid primary key references auth.users (id) on delete cascade,
  sent_at timestamptz not null default now(),
  resend_id text
);
alter table public.welcome_email_log enable row level security;
revoke all on table public.welcome_email_log from public, anon, authenticated;
grant select, insert, update, delete on table public.welcome_email_log to service_role;

create or replace function public.send_welcome_email()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key text;
begin
  -- The whole body is guarded: nothing in here may ever stop the auth.users write.
  begin
    -- Only on the confirmation transition (INSERT confirmed, or UPDATE null -> set).
    if new.email_confirmed_at is null then
      return new;
    end if;
    if tg_op = 'UPDATE' then
      if old.email_confirmed_at is not null then
        return new;
      end if;
    end if;
    if coalesce(new.email, '') = '' then
      return new;
    end if;
    -- already welcomed once (a reset and a second confirmation must not send a second one)
    if exists (select 1 from public.welcome_email_log where user_id = new.id) then
      return new;
    end if;

    select decrypted_secret into v_key
    from vault.decrypted_secrets
    where name = 'send-email-welcome-key';

    if v_key is null or v_key = '' then
      return new;
    end if;

    perform net.http_post(
      url := 'https://pfinlfaqwnytesedchik.supabase.co/functions/v1/send-email',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-welcome-key', v_key
      ),
      body := jsonb_build_object('welcomeUserId', new.id)
    );
  exception when others then
    -- Never break auth: email failures are silent here.
    return new;
  end;

  return new;
end;
$$;

revoke execute on function public.send_welcome_email() from public, anon, authenticated;
grant execute on function public.send_welcome_email() to service_role;

drop trigger if exists on_email_confirmed_send_welcome on auth.users;
create trigger on_email_confirmed_send_welcome
after insert or update of email_confirmed_at on auth.users
for each row
when (new.email_confirmed_at is not null)
execute function public.send_welcome_email();
