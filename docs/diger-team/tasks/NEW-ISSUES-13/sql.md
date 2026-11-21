# Atomic mission approval SQL

The wrapper locks the owned mission row before it invokes the existing quote, reserve and job functions. Quote creation, acceptance, job lease and attachment commit together. The wrapper uses a private new quote, and no previous quote IDs. The plan and timestamp must still match under the lock. The function runs as the caller, with execution granted to the service role only.

Run the database proof on an allowlisted disposable PostgreSQL server with the existing scratch schema and fixtures.

```sh
DIGER_PROOF=1 npx vitest run tests/sql/mission-approval.local-pg.test.ts
```

Commander applies the additive migration before the app cut. Drain legacy approval requests before enabling the new app. Leave the additive function in place while any deployed app can call it. If the app cut needs rollback, suspend approvals first and retain the function until its callers drain. An accepted legacy quote without an attachment remains for separate reconciliation.
