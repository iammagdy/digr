#!/bin/bash
# OFFLINE REHEARSAL of 001 + 003 + both verifies + a functional pass + both rollbacks, on a SCRATCH Postgres only. NOTHING here touches production.
# It mimics Supabase's `postgres` role: a NON-superuser with CREATEROLE and BYPASSRLS that owns the public schema and the tables, with Supabase's default
# privileges (every new public function executable by anon, authenticated and service_role) and RLS enabled on public.missions and public.credit_ledger.
#
# Needs a scratch cluster you can administer as `postgres` (never a hosted database). Usage:
#   PGSOCK=/tmp/pgs PGPORT=54329 bash docs/proposals/spend-gate/sql/rehearse-as-supabase-owner.sh
# It creates and drops the database `sbrehearse` and the cluster roles anon, authenticated, service_role, sbpostgres, spend_gate_owner on THAT cluster.
# Limits (stated, not hidden): Postgres 16 in the rehearsal, 17 in production; the role model is an emulation of Supabase's, not Supabase itself.
set -u
SQLD="$(cd "$(dirname "$0")" && pwd)"
H="-h ${PGSOCK:-/tmp/pgs} -p ${PGPORT:-54329}"
SU="psql $H -U postgres -v ON_ERROR_STOP=1 -X -q"
SB="psql $H -U sbpostgres -d sbrehearse -X -q"
fail=0
step() { echo; echo "=== $*"; }
expect_true() { local n; n=$(grep -c ' t$' <<<"$1"); local f; f=$(grep -c ' f$' <<<"$1"); echo "verify rows true=$n false=$f"; [ "$f" = 0 ] || fail=1; }

$SU -d postgres -c "drop database if exists sbrehearse with (force)" -c "drop role if exists spend_gate_owner" >/dev/null 2>&1
$SU -d postgres <<'EOF'
do $$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname='sbpostgres') then create role sbpostgres login createrole bypassrls createdb; end if;
end $$;
grant anon, authenticated, service_role to sbpostgres;
create database sbrehearse owner sbpostgres;
EOF
$SU -d sbrehearse -c "grant usage on schema public to anon, authenticated, service_role" -c "alter schema public owner to sbpostgres"
step "owner role (must say is_super = f)"
$SB <<'EOF'
select current_user, (select rolsuper from pg_roles where rolname=current_user) as is_super;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
create table public.missions (id text primary key, user_id uuid not null, status text not null default 'queued', created_at timestamptz not null default now());
alter table public.missions enable row level security;
create table public.credit_ledger (id bigserial primary key, user_id uuid, delta int not null);
alter table public.credit_ledger enable row level security;
insert into public.missions (id, user_id, status) values ('msn_test_a','11111111-1111-1111-1111-111111111111','delivered'),('msn_other_b','22222222-2222-2222-2222-222222222222','delivered');
insert into public.credit_ledger (user_id, delta) values ('11111111-1111-1111-1111-111111111111', 100);
EOF
step "001 (as the owner role)"; $SB -v ON_ERROR_STOP=1 -f "$SQLD/001_spend_gate.sql" 2>&1 | tail -3
step "002 verify"; out=$($SB -f "$SQLD/002_verify.sql" 2>&1); expect_true "$out"
step "003"; $SB -v ON_ERROR_STOP=1 -f "$SQLD/003_campaign_scope.sql" 2>&1 | tail -3
step "004 verify"; out=$($SB -f "$SQLD/004_verify_campaign.sql" 2>&1); expect_true "$out"
step "002 verify again (after 003)"; out=$($SB -f "$SQLD/002_verify.sql" 2>&1); expect_true "$out"

step "functional: issue one campaign grant (owner), then act as service_role"
$SB -c "select spend_gate.issue_campaign_grant('camp-rehearse-1','11111111-1111-1111-1111-111111111111'::uuid,0.30,0.10,0.30,'{provider,model}',now(),now()+interval '3 hours',1,'owner','rehearsal')::text;" 2>&1 | tail -2
$SB <<'EOF' 2>&1 | grep -E '"(ok|reason)"'
set role service_role;
select 'other account mission' as case_, public.spend_enroll_mission('msn_other_b')::text;
select 'unknown mission', public.spend_enroll_mission('msn_nope')::text;
select 'own mission', public.spend_enroll_mission('msn_test_a')::text;
select 'unenrolled mission reserves', public.spend_reserve('k1','provider','treg',0.05,'msn_other_b',60)::text;
select 'enrolled, 0.05', public.spend_reserve('k2','provider','treg',0.05,'msn_test_a',60)::text;
select 'above per-op max', public.spend_reserve('k3','provider','treg',0.5,'msn_test_a',60)::text;
select 'chat kind', public.spend_reserve('k4','chat','x',0.01,'msn_test_a',60)::text;
EOF
echo "-- service_role must be refused each of these (permission denied):"
for q in "select * from spend_gate.grants" "update spend_gate.grants set ceiling_usd=50" "select spend_gate.issue_campaign_grant('x-evil-1','11111111-1111-1111-1111-111111111111'::uuid,0.1,0.1,0.1,'{provider}',now(),now()+interval '1 hour',1,'a','b')"; do
  $SB -c "set role service_role; $q" 2>&1 | grep -q 'permission denied' && echo "refused: ${q:0:60}" || { echo "NOT REFUSED: $q"; fail=1; }
done
echo "-- the terms are immutable even for the owner role:"
$SB -c "set role spend_gate_owner; update spend_gate.grants set ceiling_usd=5 where id='camp-rehearse-1';" 2>&1 | grep -q 'ERROR' && echo "refused" || { echo "NOT REFUSED"; fail=1; }
echo "-- 003 rollback must REFUSE while a campaign grant exists:"
$SB -f "$SQLD/003_campaign_scope.rollback.sql" 2>&1 | grep -q 'a campaign grant exists' && echo "refused" || { echo "NOT REFUSED"; fail=1; }
echo "-- after revoke, a second grant may not push the campaign past 0.30 in total:"
$SB -c "select spend_gate.revoke_grant('camp-rehearse-1','rehearsal done')::text;" >/dev/null 2>&1
$SB -c "select spend_gate.issue_campaign_grant('camp-rehearse-2','11111111-1111-1111-1111-111111111111'::uuid,0.30,0.10,0.30,'{provider}',now(),now()+interval '1 hour',1,'owner','again');" 2>&1 | grep -q ERROR && echo "refused" || { echo "NOT REFUSED"; fail=1; }

step "rollbacks, on a clean rebuild (no grant exists)"
$SB -c "delete from spend_gate.reservations; delete from spend_gate.enrollments; delete from spend_gate.events; delete from spend_gate.grants;" >/dev/null 2>&1
$SB -f "$SQLD/003_campaign_scope.rollback.sql" 2>&1 | grep -E 'ERROR' ; out=$($SB -f "$SQLD/002_verify.sql" 2>&1); expect_true "$out"
$SB -f "$SQLD/001_spend_gate.rollback.sql" 2>&1 | grep -E 'ERROR'
$SB -c "select (select count(*) from pg_namespace where nspname='spend_gate') as schema_left, (select count(*) from pg_roles where rolname='spend_gate_owner') as owner_role_left, (select count(*) from public.credit_ledger) as ledger_rows, (select sum(delta) from public.credit_ledger) as ledger_sum;"
$SU -d postgres -c "drop database if exists sbrehearse with (force)" >/dev/null 2>&1
echo; [ "$fail" = 0 ] && echo "REHEARSAL OK" || { echo "REHEARSAL FAILED"; exit 1; }
