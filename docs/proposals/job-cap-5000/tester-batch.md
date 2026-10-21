# Tester batch, restated with the proposed prices (nothing is run until the owner applies the SQL and says so)

Balance: 1,209 points + 1,000 from a promo code = 2,209. Jobs run one after the other, so at most one reserve is held at a time (largest 539). Total charge of the full batch 1,149 points.
Provider spend = provider cost only (MEASURED/ASSUMED as in all-in-cost-and-margins.md); the model (review) spend is extra and is read from `llm_usage` after each job.

| # | job | records | unit price | expected quote (charge) | reserve | expected provider USD (our rate / owner-reported X rate) | stop if |
|---|---|---|---|---|---|---|---|
| 1 | X posts | 300 | 0.11715 | 36 | 41 | 0.012 / 0.007 | charge > 36, or provider > 0.03 |
| 2 | YouTube comments | 300 | 0.275 | 83 | 95 | 0.018 | charge > 83, or provider > 0.04 |
| 3 | TikTok comments | 300 | 0.275 | 83 | 95 | 0.017 | charge > 83, or provider > 0.04 |
| 4 | companies | 5 | 3.168 | 16 | 19 | 0.0038 | charge > 16, or provider > 0.01 |
| 5 | Facebook posts of a named page | 20 | 3.4485 | 69 | 80 | 0.0125 (ASSUMED, never measured) | charge > 69, or provider > 0.03 |
| 6 | X posts | 1,000 | 0.11715 | 118 | 135 | 0.039 / 0.022 | charge > 118, or provider > 0.06 |
| 7 | TikTok comments | 1,000 | 0.275 | 275 | 317 | 0.045 | charge > 275, or provider > 0.09 |
| 8 | X posts | about 4,000 | 0.11715 | 469 | 539 | 0.156 / 0.086 | charge > 469, or provider > 0.2 |

Cumulative provider spend: after job 5 about 0.063 USD; after job 6 about 0.102 (0.080 at the owner's X rate); after job 7 about 0.147; after job 8 about 0.304 (0.211). **The stated limit of 0.1 USD in total holds only for jobs 1 to 5 (0.063) plus job 6 at the owner-reported rate (0.080).** Jobs 7 and 8 need a higher limit: about 0.35 USD in total covers everything at our own measured rates.
A job quoted above 500 points as a reserve: only job 8 (539). The charge of job 8 (469) is under 500; to keep the reserve at or under 500 ask for 3,700 posts (charge 434, reserve 499).
Per job, record: price, duration range, real duration, charge, delivered count, provider cost of the job (`provider_costs`), review calls and cost (`llm_usage` rows of the account in the job's window).
