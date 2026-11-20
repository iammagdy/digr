-- Welcome email on email confirmation (Supabase / Resend, no Appwrite).
--
-- Fires the send-email Edge Function (welcome template) via pg_net whenever
-- auth.users.email_confirmed_at transitions from NULL -> set. Covers both
-- email-link confirmation (UPDATE) and OAuth signup (INSERT with confirmed email).
--
-- The service-role key is read from Vault BY NAME (secret name: send-email-service-role-key).
-- The owner creates that Vault secret ONCE via the SQL Editor (never paste the
-- key in chat or into any repo file):
--   select vault.create_secret('<SERVICE_ROLE_KEY>', 'send-email-service-role-key');
--
-- If the Vault secret is missing or empty, the trigger silently does nothing and NEVER
-- breaks auth. EVERY failure inside the trigger (Vault read, http_post, bad metadata) is
-- swallowed the same way: the auth.users INSERT/UPDATE always commits.
--
-- One user never gets two welcome e-mails: the payload carries idempotencyKey
-- 'welcome-' || the user's id (send-email accepts ^[A-Za-z0-9._:-]{1,256}$).
--
-- Safe to run more than once (extensions are IF NOT EXISTS, the function is
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

create or replace function public.send_welcome_email()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key text;
  v_name text;
  v_payload jsonb;
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

    select decrypted_secret into v_key
    from vault.decrypted_secrets
    where name = 'send-email-service-role-key';

    if v_key is null or v_key = '' then
      return new;
    end if;

    v_name := coalesce(
      nullif(new.raw_user_meta_data ->> 'full_name', ''),
      nullif(new.raw_user_meta_data ->> 'name', ''),
      split_part(coalesce(new.email, ''), '@', 1)
    );

    v_payload := jsonb_build_object(
      'template', 'welcome',
      'to', new.email,
      'vars', jsonb_build_object('Name', v_name),
      'idempotencyKey', 'welcome-' || new.id::text
    );

    perform net.http_post(
      url := 'https://pfinlfaqwnytesedchik.supabase.co/functions/v1/send-email',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || v_key,
        'Content-Type', 'application/json'
      ),
      body := v_payload
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
