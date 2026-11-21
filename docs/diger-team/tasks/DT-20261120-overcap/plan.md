# الحجز ضمن الرصيد والحد الأقصى

أثبت اختبار الجودة أن رصيد ٢٬٦٦٨ نقطة لا يغطي الحجز المعروض بقيمة ٢٬٩٨٠ نقطة. يحسب الخادم العدد المناسب من الخطة المحفوظة، ويعيد التحقق من الرصيد وسعر الحجز قبل اعتمادها. لا يغيّر اختيار العدد الرصيد. إذا تغيّرت الخطة أو الرصيد، يطلب التطبيق مراجعة السعر المعروض قبل الاعتماد.

- Approval design inherited from [PR #608](https://github.com/iammagdy/digr/pull/608) at `b28ea11607b5c44533844b4ce6e83a86a0a053dc`. Implementation base `4dcdb14c718515535c946a7a8a5100e617247489` has the same tree and inherits T2 from `a31808c59e174283f6a456930a4bb2fc1e6584e6`.
- The synthetic two-stage case compares the displayed 2,980-point hold with 2,698 for nine and 2,417 for eight. The live evidence does not establish an exact maximum for the original request.
- The plan version and server-issued offer must match before saving. A later click must approve the new version. A verified locked preview cannot enter quote creation. An uncertain approval is resolved using the existing atomic quote/job link.
- D-0170 through D-0173 define the approved file scope. Pre-push review and QA apply to the exact final commit. Roll back through Commander by reverting this PR while leaving #608 in place.

## D-0173 test cap scope

The shared runner still uses 600 points. Each file below scopes the default setting to the original approval or recovery fixture. Existing prices, assertions and digest pins are unchanged except for the two approved recovery scenarios.

- `tests/admin-free-rerun.test.ts`. Free rerun approval and refund with its original hold.
- `tests/agent-admin.test.tsx`. Admin approval and concurrency with the existing stored quote.
- `tests/agent-customer-actions.test.ts`. Ordinary customer approval and insufficient-balance response at the original size.
- `tests/agent-replay-phase1.test.ts`. Existing approved social and company replays through delivery.
- `tests/agent-replay-phase2.test.ts`. Approved company contact delivery and settlement.
- `tests/bilingual-titles-activity.test.ts`. Full approved replay for workbook titles and activities.
- `tests/company-columns-replay.test.ts`. Approved replay for company columns and unchanged billing.
- `tests/contact-benchmark-replay.test.ts`. Original contact benchmark offers and delivered-only settlement.
- `tests/contact-enrichment-replay.test.ts`. Approve the original basket before verifying enrichment.
- `tests/contact-finder-step.test.ts`. Approve the measured finder steps at the original size.
- `tests/contact-money-limits.test.ts`. Original contact-chain hold and spend allowance.
- `tests/contact-sample-cap.test.ts`. Original approval after contact planning and sampling.
- `tests/contact-step-price.test.ts`. End-to-end parity between the displayed and approved contact price.
- `tests/contract-gate-e2e.test.ts`. The normal-approval control for a complete plan.
- `tests/customer-exclusion-phase53.test.ts`. Approve the original plan before exercising delivery exclusions.
- `tests/dt-0119-01-estimate-card.test.ts`. Existing estimated people approvals and per-stage settlement.
- `tests/dt-0119-01-stage-units.test.ts`. Funded replay that supplies the stored plan for per-stage checks.
- `tests/dt-0119-04-people-ask-kept.test.ts`. The full approved company and people replay.
- `tests/dt-0119-05-companies-count.test.ts`. Preserve the original funded count in the end-to-end approval cases.
- `tests/dt-0119-06-billable-settle.test.ts`. Approval and settlement of the full original people basket.
- `tests/dt-0119-10b-recovery.test.ts`. Verify the 200-company locked preview at the 25,000-point ceiling.
- `tests/dt-0119-15b-live-r2-replays.test.ts`. Verify the original saved-evidence preview and its selected offer at the ceiling.
- `tests/dt09-money-unchanged.test.ts`. Hold, charge and release pins for approved flag replays.
- `tests/engine-contract.test.ts`. Approved engine replays for the original request sizes.
- `tests/engine-mission-types.test.ts`. Approved basket execution, partial source failure and recovery.
- `tests/flags-off-byte-identical.test.ts`. Golden plan and billing digests from their original funded plans.
- `tests/golden-g2-petroleum-replay.test.ts`. Original funded petroleum company and decision-maker replay.
- `tests/golden-r2-g1-location.test.ts`. Original funded location-filtered company replay.
- `tests/golden-r2-limits-truth.test.ts`. Original approved replay for delivery-limit copy.
- `tests/integration-stage2-3-4-flags.test.ts`. Approve the same plan under every flag combination, including after each flag reset.
- `tests/mission-12-replay.test.ts`. Original 50-company approval and measured downstream delivery.
- `tests/mission-13-replay.test.ts`. Original approved company replay and settlement.
- `tests/money7a-approve-guard.test.ts`. Normal-approval control beside the add-on refusal tests. Per D-0173 amendment, seeds the existing fake ledger into the db.from read used by readVerifiedWallet with assertions unchanged.
- `tests/people-columns-replay.test.ts`. Approve the original people plan before checking workbook columns.
- `tests/people-company-confirmation.test.ts`. Original approval before company/person matching assertions.
- `tests/people-delivery-evidence.test.ts`. Original full approval before validating per-person evidence.
- `tests/people-depth-replay.test.ts`. Approved parent basket and complete deep people reads.
- `tests/people-rows-replay.test.ts`. Original people plan, file rows and billing parity.
- `tests/people-without-contact-replay.test.ts`. Original approved basket with missing contacts during collection.
- `tests/s6-live-fixture.test.ts`. Original approved offline replay from the live-shaped fixture.
- `tests/stage3-engine-attempts.test.ts`. Approve the original code-built basket and check contact attempts.
- `tests/stage3-flags-off.test.ts`. Golden plans and workbook digests for their original funded worlds.
- `tests/stage3-planning-wiring.test.ts`. Original approval under Stage 3 enabled, disabled or test account only.
- `tests/stage4-first-version.test.ts`. Approve the original plans before checking stored version one.
- `tests/truthful-limits-text.test.ts`. Original approval and delivery evidence for the customer-facing limit text.
- `tests/unified-capability-discovery.test.ts`. Normal end-to-end approval for the original validated capability plans.
