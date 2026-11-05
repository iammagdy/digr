#!/usr/bin/env bash
# SAFETY ROUND (docs/STAGE-4-FINANCIAL-SAFETY.md section 5a): MUTATION CHECK of the migration's guard against a same-named WRONG object, on a DISPOSABLE LOCAL PostgreSQL ONLY.
#   usage: DIGR_TEST_PG=<socket dir or host>:<port> scripts/verify/mutate-one-open-addon-index.sh
# For each clause of the guard it writes a copy of the migration WITHOUT that clause (the edit must match), runs scripts/verify/verify-one-open-addon-index.sh on the copy (DIGR_MIGRATION_FILE)
# and prints which checks FAIL. A clause that can be removed without any check failing is not proved. Writes only to a private temp dir and to scratch databases. Never read any real connection.
set -u
if [ -z "${DIGR_TEST_PG:-}" ]; then echo "set DIGR_TEST_PG=<socket dir or host>:<port> (a scratch PostgreSQL)"; exit 2; fi
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$(ls "$ROOT"/supabase/migrations/*_one_open_addon_per_file.sql | head -1)"
OUT="$(mktemp -d)"; trap 'rm -rf "$OUT"' EXIT
mutate() { # name, from, to  (python is used only to edit the text of the copy)
  python3 -I - "$SRC" "$OUT/$1.sql" "$2" "$3" <<'EOF'
import sys
src, dst, frm, to = sys.argv[1:5]
text = open(src, encoding="utf-8").read()
n = text.count(frm)
if n < 1:
    print("mutation target not found"); sys.exit(1)
open(dst, "w", encoding="utf-8").write(text.replace(frm, to))
EOF
}
survivors=0
run() {
  local name="$1"
  mutate "$@" || { echo "MUTANT $name: NOT APPLIED"; survivors=$((survivors+1)); return; }
  DIGR_MIGRATION_FILE="$OUT/$name.sql" bash "$ROOT/scripts/verify/verify-one-open-addon-index.sh" > "$OUT/$name.out" 2>&1
  local failed; failed="$(grep -c '^FAIL' "$OUT/$name.out")"
  echo "MUTANT $name: $failed check(s) fail | $(grep '^FAIL' "$OUT/$name.out" | sed 's/  (.*//; s/^FAIL  //' | cut -c1-60 | head -4 | tr '\n' ';')"
  [ "$failed" -gt 0 ] || survivors=$((survivors+1))
}
run no_final_comparison   "IF v_same IS NOT TRUE THEN" "IF false THEN"
# the kind check only chooses the message (a non-index joins to no row, so the comparison refuses it too): the mutant is caught by the check that pins the message
run no_kind_check         "IF v_kind IS DISTINCT FROM 'i' THEN" "IF false THEN"
run no_unique_check       "AND e.indisunique AND e.indisvalid" "AND e.indisvalid"
run no_valid_check        "AND e.indisvalid AND e.indisready" "AND e.indisready"
run no_table_check        "SELECT e.indrelid = 'public.missions'::regclass
     AND e.indisunique" "SELECT true
     AND e.indisunique"
run no_predicate_compare  "     AND pg_get_expr(e.indpred, e.indrelid) IS NOT DISTINCT FROM pg_get_expr(r.indpred, r.indrelid)
" ""
run no_expression_compare "     AND pg_get_expr(e.indexprs, e.indrelid) IS NOT DISTINCT FROM pg_get_expr(r.indexprs, r.indrelid)
" ""
run no_column_shape_compare "AND e.indnkeyatts = r.indnkeyatts AND e.indnatts = r.indnatts
     AND e.indkey::text = r.indkey::text AND" "AND"
echo "=== mutants that survived (no check failed): $survivors"
[ "$survivors" = "0" ]
