# Review precision: reply sample and a sharper match definition

Two small changes to the model review of posts and comments. No change to prices, caps, the charge formula, the review budgets or SQL.

## 1. Reply sample (diagnosis)

**Why.** The first X job of build b6b3403 (116 of 300 delivered) paid about 1,758 output tokens per 20-row call, where a verdict-only reply needs about 300. Output is 77% of the review cost, so this is the biggest cost lever. The replies are not stored, so the reason is not known yet.

**What.** The FIRST review call of each job (not each chunk) writes one internal `job_events` row of type `review_sample` (hidden from the customer, like `review_cost`, `review_failure` and `review_fallback`):

```
review_sample step=0 rows=20 stop=end_turn in=2586 out=1962 reply_chars=4210 starts_json=0 reason_keys=20 head="..."
```

- `head` is the first 500 characters of the raw reply, JSON-quoted so it stays one line.
- **No row text, no customer data:** a reply that thinks aloud may quote the posts. Before the head is kept, every run of 10 or more characters that also occurs in the text of one of the call's rows (the fields sent to the model) or in the customer's request is replaced by «…». The format, the verdict words, the numbers and the model's own wording stay.
- `starts_json=0` means words came before the JSON; `reason_keys=N` counts `reasonAr`/`reason` keys (N above 0 means the model writes the reasons it is told not to).
- Written once per job: only when no earlier chunk of the job reviewed anything (an unreadable running record writes nothing, never a duplicate).

**How to read it** (SELECT only): `select message from job_events where event_type = 'review_sample' order by created_at desc limit 5`.

**If the reply thinks aloud.** The prompt now ends with a strict-format rule (first character `{`, last `}`, exactly two keys per item, never reasoning, reasons or notes, before, inside or after the JSON), and the parser reads the answer from its own opening `{"reviews"`, so words with braces before it do not break the read. Salvage of partial replies and fail-closed are unchanged: a row without a verdict is held, not delivered, not charged.

## 2. Sharper match definition (posts and comments)

The instruction now says a row matches only if the text is itself ABOUT the requested topic (discusses, reports, complains about or reacts to it as its subject), and lists what is NOT a match whatever words it shares with the topic: an advertisement or promotion, a price list or product or service listing, a job or sales post, a passing mention (with the Arabic words إعلان، ترويج، عرض، خصم، قائمة أسعار، ذكر عابر so the model recognises them in Arabic text). When the topic is broad or abstract and the text only touches it, or the model cannot tell whether it is the subject, the answer is `uncertain` (held, not delivered, not charged). Generic: nothing in the rules names a topic; the request supplies it. The video-list prompt and the prompts for companies and people are not changed (the strict-format rule is in every verdict-only prompt, including the video list).

**Extra input per call (measured on the text, estimated in tokens).** The three added rules are 779 characters (735 non-Arabic, 44 Arabic), plus about 85 characters for the longer match sentence (net of the 51 it replaces), so about 810 characters more per call. Estimate: 735/4 + 44/2 + 85/4 = about 225 tokens, range 225 to 260 depending on the tokenizer. On the measured call (2,586 to 2,846 tokens in) that is +8% to +10% input, 0.8 USD per million: +0.00018 to +0.00021 USD per call, +0.003 USD per 16-call job (about +2% of the review cost, because output dominates). Not measured live: no model call was made; the real figure is the `in=` of the next job's `review_sample` row against 2,586 (the same size of page).

**Expected effect (an estimate, not a measurement).** Off-topic share of delivered rows from about 20% to about 10% to 12%, with fewer delivered rows (the doubtful ones are held). Whether replies get shorter is what the sample row will show.
