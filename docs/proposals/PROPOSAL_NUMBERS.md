# Proposed numbers, version 2 (for the owner's decision at G-MONEY)

All figures are computed by `src/lib/money/*.ts` and pinned in `tests/money-proposals/`. 1 point = 0.10 EGP. 1 USD = 55 EGP. Markup stays 10x, so one USD of provider
cost is 5,500 points and one point costs 0.01 EGP to deliver. The 15% buffer is on the reserve only. Nothing here is applied or wired.

## 1. Wallet bundles (approved by the owner)

Points are one currency. A bundle costs `points x 0.10 EGP`; the bonus is a separate `bon_<topup id>` row; the work or university e-mail bonus is +5 percentage points of the
bundle's points as its own `bon_email_<topup id>` row. A free amount is 0.10 EGP per point, no bonus, minimum 100 EGP.

| Bundle | Pay (EGP) | Base points | Bonus | E-mail bonus (+5 pp) | Total (no e-mail / with e-mail) | Gross margin* (no e-mail / with e-mail) |
|---|---|---|---|---|---|---|
| Free amount | 100 or more | amount / 0.10 | 0 | 0 | base | 90.0% |
| Social 2,000 | 200 | 2,000 | +10% = 200 | +100 | 2,200 / 2,300 | 89.0% / 88.5% |
| Social 5,000 | 500 | 5,000 | +20% = 1,000 | +250 | 6,000 / 6,250 | 88.0% / 87.5% |
| Social 10,000 | 1,000 | 10,000 | +30% = 3,000 | +500 | 13,000 / 13,500 | 87.0% / 86.5% |
| Social 25,000 | 2,500 | 25,000 | +40% = 10,000 | +1,250 | 35,000 / 36,250 | 86.0% / 85.5% |
| Companies 3,000 | 300 | 3,000 | +10% = 300 | +150 | 3,300 / 3,450 | 89.0% / 88.5% |
| Companies 8,000 | 800 | 8,000 | +20% = 1,600 | +400 | 9,600 / 10,000 | 88.0% / 87.5% |
| Companies 20,000 | 2,000 | 20,000 | +30% = 6,000 | +1,000 | 26,000 / 27,000 | 87.0% / 86.5% |

*Margin = 1 - cost per point / revenue per point, cost per point = 0.10 / 10 = 0.01 EGP; revenue per point = pounds paid / points credited. Before payment fees and unspent points.
Worst case is Social 25,000 with the e-mail bonus: 14.5 points per pound, revenue 0.0690 EGP per point, margin 85.5%.

E-mail bonus rules: only after the e-mail is confirmed, only on a bundle (never a free amount), any confirmed domain that is not a free mail provider (company or university; wording
«بريد عمل أو جامعي»), at most 5 bonus accounts per domain (an account that is already one keeps the +5 on later bundles). Referral: 200 points to the referrer and 100 to the new account,
only after the new account's first approved top-up of at least 100 EGP; the referrer must have an approved top-up; at most 20 rewarded referrals per referrer; rows `ref_<referral id>_referrer` / `_referee`.
On a minimum first top-up the give-away is 300 points (30 EGP face value) against 100 EGP paid: 1,300 points issued, margin 87% before fees.

## 2. Unit prices (4d): from the cost of one DELIVERED record

Corrected from V1: V1 attributed the YouTube comment price to "0.0009 per call / 20". The source chain (`src/lib/socialSources.ts`) is: first source 0.0009 per call and 500 comments
per call (no paging, so at most 500 comments per video), fallback 0.001 per call and 20 comments per call. The proposal is built on the WORST path so that a fallback answering never sells
below cost; the first path is shown beside it. Block price = whole points per 100 records; charge = ceil(delivered x unit); reserve = ceil(volume x unit x 1.15); charge never exceeds reserve (tested).

| Capability | Cost/record USD, worst path (basis) | Cost/record USD, first path | Today (points/record) | Proposed per 100 (worst path) | Per 100 if the first path answers |
|---|---|---|---|---|---|
| X posts | 0.0000213 (owner's run) | 0.000015 | 5 | 12 | 9 |
| YouTube comments | 0.00005 (assumed) | 0.0000018 | 9 | 28 | 1 |
| TikTok comments | 0.00005 (assumed) | 0.00005 | 6 | 28 | 28 |
| Facebook comments | 0.000188 (assumed) | 0.000188 | 11 | 104 | 104 |
| Facebook page posts | 0.000627 (assumed) | 0.0002 | 11 | 345 | 110 |
| Companies | 0.000576 (measured) | n/a | 3 | 317 | n/a |

The measured company price is within 6% of today's 3 points, which supports the formula. Decision makers are unchanged: 83 + 55 + 55 points. The YouTube gap (28 vs 1 per 100) is a
decision for the owner: price on the worst path (safe, 28x dearer when the first path answers) or on a measured blend after the verification run.

## 3. The missions at the proposed (worst-path) price; reserve includes +15%

| Mission | Volume | Provider cost USD (worst / first path) | Charge | EGP at full price | Reserve | Today's charge |
|---|---|---|---|---|---|---|
| M1 channels, top 10 videos, comments (capped) | 2,000 comments | 0.10 / 0.0036 | 560 | 56 | 644 | 18,000 |
| M1 at its real size (5 channels x 10 videos x up to 500) | 25,000 comments | 1.25 / 0.045 | 7,000 | 700 | 8,050 | 225,000 |
| M2 FIFA channel, Egypt World Cup (capped) | 3,000 comments | 0.15 / 0.0054 | 840 | 84 | 966 | 27,000 |
| M2 at its real size (about 10 videos x up to 500) | 5,000 comments | 0.25 / 0.009 | 1,400 | 140 | 1,610 | 45,000 |
| M3 X match posts | 37,500 posts | 0.80 (owner) / 0.5625 | 4,500 | 450 | 5,175 | 187,500 |
| M4 Facebook page posts (volume assumed) | 2,000 posts | 1.25 / 0.40 | 6,900 | 690 | 7,935 | 22,000 |
| B2B companies | 50 | 0.029 | 159 | 15.9 | 183 | 150 |

M3 is 4,500 points against the owner's target of about 4,000; the 12-point block is the raw 11.72 rounded up. At a 9x markup the block is 11 and M3 is 4,125.

## 4. M3 (4,500 points) in pounds, by how the points were bought

Effective EGP = 4,500 x (pounds paid / points credited). The 5,175-point reserve must fit the balance, so M3 needs a bundle of at least Social 5,000 (6,000 / 6,250 points) or 5,175+ points bought freely.

| Points bought as | No e-mail bonus | With e-mail bonus | Balance after buying (no / with e-mail) vs the 5,175 reserve |
|---|---|---|---|
| Full price (free amount) | 450.00 | n/a | 5,175 points = 517.5 EGP needed |
| Social 2,000 (200 EGP) | 409.09 | 391.30 | 2,200 / 2,300: too small for M3 |
| Social 5,000 (500 EGP) | 375.00 | 360.00 | 6,000 / 6,250: enough |
| Social 10,000 (1,000 EGP) | 346.15 | 333.33 | 13,000 / 13,500: enough |
| Social 25,000 (2,500 EGP) | 321.43 | 310.34 | 35,000 / 36,250: enough |
| Companies 3,000 (300 EGP) | 409.09 | 391.30 | 3,300 / 3,450: too small for M3 |
| Companies 8,000 (800 EGP) | 375.00 | 360.00 | 9,600 / 10,000: enough |
| Companies 20,000 (2,000 EGP) | 346.15 | 333.33 | 26,000 / 27,000: enough |

(Assumes points bought in a companies bundle may be spent on social jobs; points are one currency in the ledger. If the owner wants lines kept apart, that is a new rule.)

## 5. Cap, confirmation and provider checks (4e)

- Per-job cap proposed: 6,000 points (today 600). M3's reserve is 5,175. M1 at its real size (8,050) and M4 at 2,000 posts (7,935) exceed it; they would need the customer's own cap or two jobs.
- Any reserve above 600 needs an explicit confirmation. Start gate: balance covers the reserve, reserve within the job cap, provider daily allowance, provider balance (estimate + 20%).
- Provider needs per mission: `VOLUME_FB_PROVIDER.md`.

## 6. Other proposals (unchanged): custom offers (4f), the one-minute driver (4g), SQL order in `README.md`.
