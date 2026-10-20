# Proposed numbers (for the owner's decision at G-MONEY)

All figures are computed by `src/lib/money/*.ts` and pinned in `tests/money-proposals/`. 1 point = 0.10 EGP. 1 USD = 55 EGP. Markup 10x
(unchanged). So one USD of provider cost = 5,500 points. The 15% buffer is on the reserve only.

## 4d. Price from the real cost of one DELIVERED record

Today a delivered record is priced at the cost of one provider CALL, rounded up to a whole point. Proposed: cost per delivered record x 5,500,
kept as a fraction (ten-thousandths of a point), shown to the customer as whole points per 100 records. Charge = ceil(delivered x unit);
reserve = ceil(volume x unit x 1.15); charge never exceeds the reserve (tested for many volumes).

| Capability | Cost per record (USD) | Basis | Today (points/record) | Proposed block price (points per 100) | Proposed (points/record) |
|---|---|---|---|---|---|
| X posts | 0.0000213 | owner's own run (about 0.80 USD / 37,500) | 5 | 12 | 0.12 |
| YouTube comments | 0.000045 | ASSUMED (0.0009 per call / 20) | 9 | 25 | 0.25 |
| TikTok comments | 0.00005 | ASSUMED (0.001 per call / 20) | 6 | 28 | 0.28 |
| Facebook comments | 0.000188 | ASSUMED (0.00188 per call / 10) | 11 | 104 | 1.04 |
| Facebook posts | 0.000627 | ASSUMED (highest page price in the catalog) | 11 | 345 | 3.45 |
| Companies | 0.000576 | MEASURED (434 records, 44 completed jobs) | 3 | 317 | 3.17 |

Validation: the measured company price lands within 6% of today's 3 points, which supports the formula. Every ASSUMED row must be replaced by
a measured one from the scaled-down verification run before approval. People (decision makers) are unchanged: 83 + 55 + 55 points.

## The owner's missions (proposed charge if every record is delivered; reserve includes +15%)

| Mission | Volume | Provider cost (USD) | Proposed charge | EGP | Proposed reserve | Today's charge |
|---|---|---|---|---|---|---|
| M1 channels, top 10 videos, comments | 2,000 comments (cap) | 0.09 | 500 | 50 | 575 | 18,000 |
| M2 FIFA channel, Egypt World Cup | 3,000 comments (cap) | 0.135 | 750 | 75 | 863 | 27,000 |
| M3 X match posts and replies | 37,500 posts | 0.80 | 4,500 | 450 | 5,175 | 187,500 |
| M4 Facebook marriage/dowry/divorce | 2,000 posts (ASSUMED, none stated) | 1.254 | 6,900 | 690 | 7,935 | 22,000 |
| B2B companies | 50 companies | 0.029 | 159 | 15.9 | 183 | 150 |

M3 comes out at 4,500 points against the owner's target of about 4,000 (the 12-point block price is the 11.72 raw price rounded up). At a 9x markup the
block price is 11 and M3 is 4,125; this is the owner's call. M2, M3 and M4 reserves exceed 600 points: they need the cap decision below, and the customer confirms any
reserve above 600.

## 4e. Cap, confirmation and provider checks

- Proposed per-job cap: 6,000 points (covers M3's 5,175 reserve; M4 at 2,000 posts needs 7,935 and would be split or capped by the customer). Today: 600.
- Confirmation: any reserve above 600 points needs an explicit confirmation on the plan (`CONFIRM_ABOVE_POINTS`).
- Provider daily cap: the live setting (`provider_limits.dailyUsd`, built-in 0.80 USD) must be raised before M3 (0.80 USD alone) can run; the gate blocks a job whose estimated cost would pass it. The owner sets the number.
- Balance checks: the customer's balance must cover the reserve; the provider's balance must cover the estimate plus 20% (the provider balance is read by the application, there is no table for it).

## 4a. Wallet bundles (bonus on top of the base points; `bon_<topup id>`)

| Paid (EGP) | Base points | Bonus | Bonus points | Total | Gross margin on cost* |
|---|---|---|---|---|---|
| 100 | 1,000 | 0% | 0 | 1,000 | 90.0% |
| 250 | 2,500 | 5% | 125 | 2,625 | 89.5% |
| 500 | 5,000 | 15% | 750 | 5,750 | 88.5% |
| 1,000 | 10,000 | 25% | 2,500 | 12,500 | 87.5% |
| 2,500 | 25,000 | 40% | 10,000 | 35,000 | 86.0% |

*Gross margin = 1 - cost per point / revenue per point, with cost per point = 0.10 / 10 = 0.01 EGP, before payment fees and unspent points. At the 40% tier
a pound buys 14 points instead of 10, revenue per point falls from 0.100 to 0.0714 EGP, and margin falls from 90% to 86% (4 points). Exact values per tier
are in `marginImpact()`; every tier stays above 85%.

## 4b. Work-email bonus: 100 points (10 EGP face value) once per account, confirmed company domain, at most 3 accounts per domain.

## 4c. Referral: 200 points to the referrer and 100 to the new account, only after the new account's first approved top-up of at least 100 EGP;
the referrer must have a top-up of their own; at most 20 rewarded referrals per referrer. On a minimum first top-up the give-away is 300 points (30 EGP face
value); total points issued for those 100 EGP are 1,300, so margin before fees is 87%.

## 4f. Custom offers: an admin-written unit price, most volume, most reserve and expiry for one customer; no ledger write.
## 4g. Driver: database scheduler (pg_cron + pg_net) every minute calls `/api/cron/drive`; it only dispatches the next chunk of approved jobs.
