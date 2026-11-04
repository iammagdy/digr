#!/usr/bin/env bash
# SAFETY ROUND (docs/STAGE-4-FINANCIAL-SAFETY.md section 5): runs the PREPARED migration supabase/migrations/*_one_open_addon_per_file.sql on a DISPOSABLE LOCAL PostgreSQL ONLY.
#   usage: DIGR_TEST_PG=<socket dir or host>:<port> scripts/verify/verify-one-open-addon-index.sh
# It creates its own scratch databases (digr_idx_*) on that server and drops them. It refuses to run without DIGR_TEST_PG and never reads any other connection setting (no DATABASE_URL, no .env).
# It writes only inside the scratch databases. NEVER point DIGR_TEST_PG at Supabase or at any real database.
set -u
if [ -z "${DIGR_TEST_PG:-}" ]; then echo "set DIGR_TEST_PG=<socket dir or host>:<port> (a scratch PostgreSQL)"; exit 2; fi
HOST="${DIGR_TEST_PG%:*}"; PORT="${DIGR_TEST_PG##*:}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
MIGRATION="${DIGR_MIGRATION_FILE:-$(ls "$ROOT"/supabase/migrations/*_one_open_addon_per_file.sql | head -1)}"   # DIGR_MIGRATION_FILE: a MUTATED copy, to show the checks fail without a protection
STUBS="$ROOT/tests/sql/supabase-stubs.sql"
DDL_SRC="$ROOT/docs/proposals/agent-worker/01_agent_tables.sql"
PSQL=(psql -h "$HOST" -p "$PORT" -U postgres -X -q -At)
pass=0; fail=0
ok()  { pass=$((pass+1)); echo "PASS  $1"; }
bad() { fail=$((fail+1)); echo "FAIL  $1  ($2)"; }
check() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "expected [$3] got [$2]"; fi; }
newdb() { local n="digr_idx_$1"; "${PSQL[@]}" -d postgres -c "drop database if exists $n with (force)" -c "create database $n" >/dev/null 2>&1; "${PSQL[@]}" -v ON_ERROR_STOP=1 -d "$n" -f "$STUBS" >/dev/null 2>&1; echo "$n"; }
mktable() { sed -n 13,47p "$DDL_SRC" | "${PSQL[@]}" -v ON_ERROR_STOP=1 -d "$1" -f - >/dev/null 2>&1; "${PSQL[@]}" -d "$1" -c "insert into auth.users(id) values ('11111111-1111-4111-8111-111111111111') on conflict do nothing" >/dev/null 2>&1; }
q() { "${PSQL[@]}" -d "$1" -c "$2" 2>&1 | tr -d '\r' | head -${3:-1}; }
# insert one add-on row; prints OK or the SQLSTATE and constraint name
ins() { # db id of status [plan override]
  local plan="${5:-}"; [ -n "$plan" ] || plan="{\"addon\":{\"v\":1,\"kind\":\"review\",\"of\":\"$3\"}}"
  "${PSQL[@]}" -d "$1" -c "do \$\$ begin insert into public.missions(id,user_id,request_text,status,plan) values ('$2','11111111-1111-4111-8111-111111111111','request text','$4','$plan'::jsonb); raise notice 'OK'; exception when unique_violation then declare c text; begin get stacked diagnostics c = constraint_name; raise notice 'UNIQUE %', c; end; end \$\$" 2>&1 | sed -n 's/.*NOTICE:  //p' | head -1
}
apply() { "${PSQL[@]}" -v ON_ERROR_STOP=1 -d "$1" -f "$MIGRATION" 2>&1 | tr '\n' ' ' | cut -c1-260; }
idx() { q "$1" "select indisvalid::text||'/'||indisunique::text from pg_index where indexrelid='public.missions_one_open_addon_per_file'::regclass"; }
D="$(newdb 1)"; mktable "$D"

echo "--- 1 preconditions stop the migration and change nothing"
E="$(newdb nomissions)"; r="$(apply "$E")"; case "$r" in *"does not exist"*) ok "missing table: the migration raises";; *) bad "missing table" "$r";; esac
J="$(newdb jsoncol)"; "${PSQL[@]}" -d "$J" -c "create table public.missions(id text primary key, plan json, status text)" >/dev/null 2>&1; r="$(apply "$J")"; case "$r" in *"must be jsonb"*) ok "plan is json, not jsonb: the migration raises";; *) bad "json column" "$r";; esac
V="$(newdb viol)"; mktable "$V"
ins "$V" msn_a1aaaaaa msn_dupfile1 queued >/dev/null; ins "$V" msn_a2aaaaaa msn_dupfile1 plan_ready >/dev/null
r="$(apply "$V")"; case "$r" in *"1 file(s) already have more than one open add-on row"*) ok "existing violators: the migration raises";; *) bad "violators" "$r";; esac
check "no index was created by the refused migration" "$(q "$V" "select count(*) from pg_indexes where indexname='missions_one_open_addon_per_file'")" "0"
check "no row was changed by the refused migration" "$(q "$V" "select count(*) from public.missions")" "2"

echo "--- 2 clean apply, shape, idempotence"
ins "$D" msn_ordinary1 x completed '{"stages":[]}' >/dev/null
r="$(apply "$D")"; case "$r" in *ERROR*) bad "apply" "$r";; *) ok "applies on a clean table";; esac
check "the index is valid and unique" "$(idx "$D")" "true/true"
check "the index is partial on the key and the deny-list" "$(q "$D" "select pg_get_indexdef('public.missions_one_open_addon_per_file'::regclass)")" "CREATE UNIQUE INDEX missions_one_open_addon_per_file ON public.missions USING btree ((((plan -> 'addon'::text) ->> 'of'::text))) WHERE ((((plan -> 'addon'::text) ->> 'of'::text) IS NOT NULL) AND (status <> ALL (ARRAY['completed'::text, 'failed'::text, 'unserved'::text, 'cancelled'::text])))"
r="$(apply "$D")"; case "$r" in *ERROR*) bad "second apply" "$r";; *) ok "a second apply is a no-op (idempotent)";; esac

echo "--- 3 what the index refuses and allows"
check "first open add-on of a file is allowed" "$(ins "$D" msn_r1aaaaaa msn_fileA queued)" "OK"
check "a SECOND open add-on of the same file is refused with the index's own constraint" "$(ins "$D" msn_r2aaaaaa msn_fileA plan_ready)" "UNIQUE missions_one_open_addon_per_file"
for s in approved executing needs_input planning; do check "a $s row holds the slot" "$(ins "$D" "msn_h${s:0:3}aaaaaa" msn_fileA "$s")" "UNIQUE missions_one_open_addon_per_file"; done
check "a different file is independent" "$(ins "$D" msn_r3aaaaaa msn_fileB queued)" "OK"
check "the same id again is refused by the PRIMARY KEY (an ended-looking duplicate of an existing id)" "$(ins "$D" msn_r1aaaaaa msn_fileC completed)" "UNIQUE missions_pkey"
echo "      engine order when ONE insert violates BOTH (same id AND the file is open): $(ins "$D" msn_r1aaaaaa msn_fileA queued)"
for s in completed failed unserved cancelled; do
  check "an ended ($s) row does not hold the slot: the file's open row may exist beside it" "$(ins "$D" "msn_e${s:0:3}aaaaaa" msn_fileA "$s")" "OK"
done
"${PSQL[@]}" -d "$D" -c "update public.missions set status='cancelled' where id='msn_r1aaaaaa'" >/dev/null
check "after the open row ends, a new open add-on of the file is allowed" "$(ins "$D" msn_r4aaaaaa msn_fileA queued)" "OK"
r="$("${PSQL[@]}" -d "$D" -c "update public.missions set status='queued' where id='msn_r1aaaaaa'" 2>&1 | head -1)"; case "$r" in *"missions_one_open_addon_per_file"*) ok "REOPENING an ended row while another is open is refused";; *) bad "reopen" "$r";; esac
check "open->open updates (the worker's requeue and the approval) are never refused" "$(q "$D" "update public.missions set status='approved' where id='msn_r4aaaaaa' returning status")" "approved"
check "executing -> approved (requeue) is allowed" "$(q "$D" "update public.missions set status='executing' where id='msn_r4aaaaaa' returning status")" "executing"
r="$(q "$D" "update public.missions set status='approved' where id='msn_r4aaaaaa' returning status")"; check "executing -> approved is allowed" "$r" "approved"
echo "      the message PostgREST would return: $("${PSQL[@]}" -d "$D" -c "insert into public.missions(id,user_id,request_text,status,plan) values ('msn_zzz00000','11111111-1111-4111-8111-111111111111','request text','queued','{\"addon\":{\"of\":\"msn_fileA\"}}')" 2>&1 | head -2 | tr '\n' ' ')"

echo "--- 4 ordinary missions and malformed JSON"
for i in 1 2 3; do check "ordinary research mission $i (no addon key) is allowed" "$(ins "$D" "msn_ord0000$i" x queued '{"stages":[]}')" "OK"; done
check "a mission with plan NULL is allowed twice" "$("${PSQL[@]}" -d "$D" -c "insert into public.missions(id,user_id,request_text,status) values ('msn_null0001','11111111-1111-4111-8111-111111111111','request text','queued'),('msn_null0002','11111111-1111-4111-8111-111111111111','request text','queued')" 2>&1 | head -1)" ""
n=0; for p in '{"addon":null}' '{"addon":"text"}' '{"addon":[]}' '{"addon":{}}' '{"addon":{"of":null}}'; do
  n=$((n+1)); a="$(ins "$D" "msn_mal0000$n" x queued "$p")"; b="$(ins "$D" "msn_mal1000$n" x queued "$p")"
  check "malformed plan $p: not an add-on for the key (NULL or no text), so it never blocks anything, and it is not a valid add-on for the application either (readAddonPlan rejects it)" "$a/$b" "OK/OK"
done
check "an object-valued key is the text of the JSON (a key, not NULL): the first row, then the second is refused; neither is a valid add-on (readAddonPlan needs a string) and neither can block a real one" "$(ins "$D" msn_obj00001 x queued '{"addon":{"of":{"x":1}}}')/$(ins "$D" msn_obj00002 x queued '{"addon":{"of":{"x":1}}}')/$(ins "$D" msn_obj00003 msn_realfile queued)" "OK/UNIQUE missions_one_open_addon_per_file/OK"
check "a numeric key is coerced to text: the first row" "$(ins "$D" msn_num00001 x queued '{"addon":{"of":5}}')" "OK"
check "a numeric key is coerced to text: the second is refused" "$(ins "$D" msn_num00002 x queued '{"addon":{"of":5}}')" "UNIQUE missions_one_open_addon_per_file"
check "an empty-string key behaves as a key (no valid add-on has one: readAddonPlan rejects it)" "$(ins "$D" msn_emp00001 x queued '{"addon":{"of":""}}')/$(ins "$D" msn_emp00002 x queued '{"addon":{"of":""}}')" "OK/UNIQUE missions_one_open_addon_per_file"
echo "      rows that would ESCAPE the key (add-on object present, key not a text): $(q "$D" "select count(*) from public.missions where plan ? 'addon' and (plan->'addon'->>'of') is null")"

echo "--- 5 a status added later holds the slot (deny-list)"
F="$(newdb future)"; mktable "$F"; "${PSQL[@]}" -d "$F" -c "alter table public.missions drop constraint missions_status_check" >/dev/null 2>&1; apply "$F" >/dev/null
check "a future status 'paused' holds the slot: first row" "$(ins "$F" msn_pa000001 msn_fileP paused)" "OK"
check "a future status 'paused' holds the slot: second open row refused" "$(ins "$F" msn_pa000002 msn_fileP queued)" "UNIQUE missions_one_open_addon_per_file"

echo "--- 6 two sessions at the same moment: exactly one wins"
R="$(newdb race)"; mktable "$R"; apply "$R" >/dev/null
( "${PSQL[@]}" -d "$R" -c "begin; insert into public.missions(id,user_id,request_text,status,plan) values ('msn_race0001','11111111-1111-4111-8111-111111111111','request text','queued','{\"addon\":{\"of\":\"msn_fileR\"}}'); select pg_sleep(1.5); commit;" >/tmp/pgsafety/race_a.out 2>&1 ) &
sleep 0.4
( "${PSQL[@]}" -d "$R" -c "insert into public.missions(id,user_id,request_text,status,plan) values ('msn_race0002','11111111-1111-4111-8111-111111111111','request text','plan_ready','{\"addon\":{\"of\":\"msn_fileR\"}}')" >/tmp/pgsafety/race_b.out 2>&1 ) &
wait
check "after the race exactly ONE open add-on row of the file exists" "$(q "$R" "select count(*) from public.missions where plan->'addon'->>'of'='msn_fileR'")" "1"
grep -q 'missions_one_open_addon_per_file' /tmp/pgsafety/race_b.out && ok "the loser got the index's unique violation (it waited for the winner's commit)" || bad "the loser's error" "$(head -2 /tmp/pgsafety/race_b.out)"

echo "--- 7 lock, build time, CONCURRENTLY, rollback"
B="$(newdb big)"; mktable "$B"
"${PSQL[@]}" -d "$B" -c "insert into public.missions(id,user_id,request_text,status,plan) select 'msn_big'||lpad(g::text,10,'0'),'11111111-1111-4111-8111-111111111111','request text','completed',case when g%3=0 then jsonb_build_object('addon',jsonb_build_object('of','msn_f'||g,'kind','edit')) else '{\"stages\":[]}'::jsonb end from generate_series(1,200000) g" >/dev/null 2>&1
check "seeded 200,000 rows" "$(q "$B" "select count(*) from public.missions")" "200000"
t0=$(date +%s%N); apply "$B" >/dev/null; t1=$(date +%s%N); echo "      the migration took $(( (t1-t0)/1000000 )) ms on 200,000 rows (plain CREATE UNIQUE INDEX: reads continue, writes to missions wait for the build)"
check "the index is valid on the big table" "$(idx "$B")" "true/true"
r="$("${PSQL[@]}" -d "$D" -c "begin; create index concurrently tmp_probe_idx on public.missions(id); commit;" 2>&1 | head -1)"; case "$r" in *"cannot run inside a transaction block"*) ok "CREATE INDEX CONCURRENTLY cannot run inside a transaction block (so it cannot be the body of a migration that runs in one)";; *) bad "concurrently" "$r";; esac
BEFORE="$(q "$D" "select count(*), coalesce(sum(length(plan::text)),0) from public.missions")"
"${PSQL[@]}" -d "$D" -c "drop index if exists public.missions_one_open_addon_per_file" >/dev/null
check "rollback is one DROP INDEX and changes no row" "$(q "$D" "select count(*), coalesce(sum(length(plan::text)),0) from public.missions")" "$BEFORE"
check "after the rollback the old behaviour returns (a second open row is allowed)" "$(ins "$D" msn_rb000001 msn_fileA queued)/$(ins "$D" msn_rb000002 msn_fileA queued)" "OK/OK"
echo "--- 8 the pre-migration checks of the document, run on the seeded violator database"
check "check 1 (rows that would violate the index) finds the pair" "$(q "$V" "select count(*) from (select plan->'addon'->>'of' from public.missions where (plan->'addon'->>'of') is not null and status not in ('completed','failed','unserved','cancelled') group by 1 having count(*)>1) s")" "1"
check "check 2 (add-on rows that would escape the key) runs and is zero on the violator database" "$(q "$V" "select count(*) from public.missions where plan ? 'addon' and (plan->'addon'->>'of') is null")" "0"
check "check 6 (approved once, waiting again, no job) runs" "$(q "$V" "select count(*) from public.missions where (plan->'addon'->>'of') is not null and status='plan_ready' and approved_at is not null")" "0"
for n in 1 nomissions jsoncol viol future race big; do "${PSQL[@]}" -d postgres -c "drop database if exists digr_idx_$n with (force)" >/dev/null 2>&1; done
echo "=== $pass passed, $fail failed"
[ "$fail" = "0" ]
