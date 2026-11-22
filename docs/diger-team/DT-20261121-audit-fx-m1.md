# Ordinary mission settlement uses the workbook the customer downloads

DT-20261121-audit / FX-M1 covers F4, F5, F8 and F9 under D-0181. Billing counts and requested contacts come from the verified XLSX data sheets. The mission and job downloads stay bound to those bytes. The existing atomic money functions write the ledger and the finalizer records the delivery receipt in the same transaction.

PostgreSQL records the first attempt before workbook storage is opened. Verification opportunities are nominally 0, 15, 60 and 150 seconds after that start. Release-only opportunities are nominally 165 and 225 seconds. Each failed attempt spaces the next by at least 15 seconds. A reachable database and an available worker are required to pick up a due attempt. Once fenced for release, a job cannot take a fresh debit. A committed delivery receipt wins on recovery. Create-only writes protect the winning XLSX and CSV in both buckets from late workers.

## Offline charge and hold replays

| Scenario | Physical | Billable | Held | Charged | Net returned |
| --- | ---: | ---: | ---: | ---: | ---: |
| Three companies and three people, one with no requested contact | 6 | 5 | 1067 | 774 | 293 |
| Partial delivery | 6 of 12 | 6 | 553 | 241 | 312 |
| No output | 0 | 0 | 553 | 0 | 553 |
| Social delivery | 30 of 30 | 30 | 200 | 200 | 0 |

The replay cases use synthetic accepted quotes. The contact case includes an email-only contact and an office line. A workbook with physical rows and zero billable rows stays downloadable. The existing minimum policy, caps, quote amounts and ledger identifiers carry forward. Paid add-on publication and compensation belong to FX-M1b.

## Existing regression coverage updated

The changes below preserve the original ledger, amount, workbook cell and customer metadata assertions. Both new RPC paths are also covered on scratch PostgreSQL.

- `tests/agent-mission-run.test.ts`
- `tests/dt-0119-01-stage-units.test.ts`
- `tests/dt-0119-06-billable-settle.test.ts`
- `tests/dt09-money-unchanged.test.ts`
- `tests/engine-settlement.test.ts`
- `tests/flags-off-byte-identical.test.ts`
- `tests/helpers/agentMoney.ts`
- `tests/helpers/agentReplay.ts`
- `tests/methodology-section.test.ts`
- `tests/ownership-fail-closed.test.ts`
- `tests/safety-migration-one-open-addon.test.ts` (D-0185)
- `tests/stage2-done-snapshot-safe.test.ts` (D-0185)
- `tests/stage2-live-writer.test.ts`
- `tests/stage4-first-version.test.ts`
- `tests/worker-ownership.test.ts`

## Rollout and rollback

Additive migration `20261122010000_finalize_agent_delivery_atomic.sql` with SHA-256 `9b1bd72e33cbca995b518ff757f9bd73b35592c4975b2688e68839f72254b013`.

Commander owns the snapshot and application of the migration after same-head Gate 2 and QA. Deploy the receipt-aware readers before activating the writer. Drain unsealed in-flight ordinary writers before activation. Rollback requires stopping new work and completing or resolving active journals with the receipt-aware worker. Retain the migration, sealed files and append-only ledger. Keep receipt-aware download support for already settled output. An emergency application rollback before the drain needs an owner-managed recovery bridge.
