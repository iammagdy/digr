import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * DT-20261119-02b: static guard for supabase/migrations/20261013170000_welcome_email_on_confirm.sql.
 * The real extension is supabase_vault (there is no extension called "vault"), every failure inside the trigger is swallowed, the key is read from the Vault BY NAME and never written
 * in the file, and the payload carries a per-user idempotencyKey. The queue carries only the dedicated welcome key and a user id (O4, فزاع Gate 2 r1). The behaviour (cases B-G) is proved on a real Postgres engine in docs/diger-team/tasks/DT-20261119-02b/plan.md.
 */
const FILE = "supabase/migrations/20261013170000_welcome_email_on_confirm.sql";
const sql = readFileSync(FILE, "utf8");
/** The statements without the comment lines. */
const code = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

describe("welcome e-mail migration", () => {
  it("enables supabase_vault, never an extension named vault", () => {
    expect(code).toMatch(/create extension if not exists "supabase_vault" with schema "vault"/i);
    expect(code).not.toMatch(/create extension (if not exists )?"?vault"?\s*(with|;)/i);
  });
  it("keeps pg_net idempotent, and a failure to enable the Vault does not stop the file", () => {
    expect(code).toMatch(/create extension if not exists "pg_net"/i);
    expect(code).toMatch(/raise warning 'welcome_email_on_confirm: supabase_vault could not be enabled/);
    // every `create extension` is IF NOT EXISTS (re-run safe)
    for (const m of code.match(/create extension[^;]*;/gi) ?? []) expect(m).toMatch(/if not exists/i);
  });
  it("swallows every failure inside the trigger function (the auth.users write always commits)", () => {
    const body = code.slice(code.indexOf("create or replace function public.send_welcome_email"), code.indexOf("revoke execute"));
    expect(body).toMatch(/exception when others then\s+return new;/i);
    // the transition checks, the Vault read and the http call are all INSIDE the guarded block (the nested `begin` comes before them, the handler after them)
    const guard = body.indexOf("begin", body.indexOf("begin") + 1);
    const handler = body.indexOf("exception when others");
    expect(guard).toBeGreaterThan(-1);
    for (const needle of ["new.email_confirmed_at is null", "old.email_confirmed_at is not null", "from public.welcome_email_log", "from vault.decrypted_secrets", "net.http_post"]) {
      expect(body.indexOf(needle), needle).toBeGreaterThan(guard);
      expect(body.indexOf(needle), needle).toBeLessThan(handler);
    }
  });
  it("reads the DEDICATED welcome key from the Vault by name, with an empty or missing key doing nothing", () => {
    expect(code).toMatch(/from vault\.decrypted_secrets\s+where name = 'send-email-welcome-key'/);
    expect(code).not.toContain("send-email-service-role-key");
    expect(code).toMatch(/if v_key is null or v_key = '' then\s+return new;/);
  });
  it("the pg_net queue gets ONLY x-welcome-key and {welcomeUserId}: no Authorization, no service key, no e-mail, no name", () => {
    const start = code.indexOf("perform net.http_post(");
    const post = code.slice(start, code.indexOf("exception when others", start));
    expect(post).toMatch(/'x-welcome-key', v_key/);
    expect(post).toMatch(/body := jsonb_build_object\('welcomeUserId', new\.id\)/);
    expect(post).not.toMatch(/authorization|bearer|service_role|new\.email|raw_user_meta_data|'to'|'vars'|'Name'|idempotencyKey/i);
    // nothing in the whole function reads the address into a variable that is sent
    const fn = code.slice(code.indexOf("create or replace function public.send_welcome_email"), code.indexOf("revoke execute"));
    expect(fn).not.toMatch(/raw_user_meta_data/);
    expect(fn.match(/new\.email\b/g) ?? []).toHaveLength(1); // only the empty-address guard
    expect(code).toMatch(/set search_path = ''/);
    expect(code).toMatch(/security definer/);
  });
  it("one welcome per user for life: a private log table (RLS on, no policies, service role only) and the trigger skips a logged user", () => {
    expect(code).toMatch(/create table if not exists public\.welcome_email_log \(\s*user_id uuid primary key references auth\.users \(id\) on delete cascade,\s*sent_at timestamptz not null default now\(\),\s*resend_id text\s*\);/);
    expect(code).toMatch(/alter table public\.welcome_email_log enable row level security;/);
    expect(code).not.toMatch(/create policy/i);
    expect(code).toMatch(/revoke all on table public\.welcome_email_log from public, anon, authenticated;/);
    expect(code).toMatch(/grant select, insert, update, delete on table public\.welcome_email_log to service_role;/);
    expect(code).not.toMatch(/grant [^;]*welcome_email_log to (anon|authenticated|public)/i);
    expect(code).toMatch(/if exists \(select 1 from public\.welcome_email_log where user_id = new\.id\) then\s+return new;/);
  });
  it("fires only on the confirmation: INSERT confirmed or UPDATE null -> set", () => {
    expect(code).toMatch(/if new\.email_confirmed_at is null then\s+return new;/);
    expect(code).toMatch(/if tg_op = 'UPDATE' then\s+if old\.email_confirmed_at is not null then\s+return new;/);
    expect(code).toMatch(/after insert or update of email_confirmed_at on auth\.users/);
    expect(code).toMatch(/when \(new\.email_confirmed_at is not null\)/);
  });
  it("is re-run safe and keeps the grants (service_role only)", () => {
    expect(code).toMatch(/create or replace function public\.send_welcome_email\(\)/);
    expect(code).toMatch(/drop trigger if exists on_email_confirmed_send_welcome on auth\.users;\s+create trigger on_email_confirmed_send_welcome/);
    expect(code).toMatch(/revoke execute on function public\.send_welcome_email\(\) from public, anon, authenticated;/);
    expect(code).toMatch(/grant execute on function public\.send_welcome_email\(\) to service_role;/);
  });
  it("holds no secret: no JWT, no sb_secret_, no bearer literal", () => {
    expect(sql).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
    expect(sql).not.toMatch(/sb_secret_/);
    expect(sql).not.toMatch(/sbp_[A-Za-z0-9]{10,}/);
    expect(code).not.toMatch(/bearer/i);
    expect(sql).not.toMatch(/vault\.create_secret/);
  });
});
