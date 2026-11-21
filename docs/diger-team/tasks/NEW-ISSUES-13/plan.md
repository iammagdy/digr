# Bind approval to the plan the customer saw

The pinned base is `a31808c59e174283f6a456930a4bb2fc1e6584e6`. In the fail-first route replay, the 715-point card accepted a plan edit during precheck and reserved 1,348 points. Earlier research also found two reservations when a database acknowledgement was lost between the hold and the separate mission link.

A click sends the version of its displayed plan. The server checks the first owned snapshot, prices that snapshot, and passes its plan and timestamp to the database. PostgreSQL compares them under the mission lock and commits quote, hold, job and attachment together. A stale click refreshes the card. A lost reply can recover the existing attachment.

The release prerequisites and rollback are in [SQL operations](sql.md). Keep T4 changes and historical reconciliation separate.

## Verification

- The scratch PostgreSQL suite checks the service-role grant, unchanged money functions, two concurrent callers, version changes, rollback, clean refusal and legacy orphan detection.
- The route suite covers the old and new displayed amounts, two distinct lost-reply boundaries, an overlapping click, a failed link and a new mission after settlement.
- Run `npm test`, `npx tsc --noEmit` and `npm run agent:typecheck` under the shared lock on the reviewed commit. The opt-in PostgreSQL proof runs separately.
- No production rows, migration application, deployment or real provider calls are part of this verification.
