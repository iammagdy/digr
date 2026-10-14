# Proposal: Seed Data for Supabase (Gate G2)

> [!IMPORTANT]
> **Status: PROPOSAL ONLY under Gate G2. No seed rows have been inserted into Supabase.**
> This document records the proposed values, their original Appwrite sources, and exact formulas for owner and reviewer verification.

---

## 1. Public Settings (`settings_public`)

### Proposed Row: `key = 'pricing'`
```json
{
  "key": "pricing",
  "value": {
    "creditValueEgp": 0.10,
    "safetyBuffer": 0.15,
    "minPoints": 1,
    "markup": 2.0,
    "usdToEgp": 53.0
  }
}
```

### Source & Rationale:
- **`creditValueEgp: 0.10`**:
  - Source: `scripts/setup-db.ts:566` (`creditValueEgp: 0.1`) and `src/functions/shared/quotes.ts:34`.
  - Product Rule: 1 point = 0.10 EGP (10 points = 1.00 EGP; 50 EGP top-up = 500 points).
- **`safetyBuffer: 0.15` (15%)**:
  - Source: `src/functions/shared/quotes.ts:35` (`safetyBuffer: 0.15`).
  - Sacred Money Rule: 15% buffer is applied strictly on reservation (`total_reserved_credits`), NEVER on settlement/charge.
- **`minPoints: 1`**:
  - Source: `src/functions/shared/quotes.ts:36` (`minPoints: 1`).
- **`markup: 2.0`**:
  - Source: `src/functions/shared/quotes.ts:33` (`markup: 2.0`).
- **`usdToEgp: 53.0`**:
  - Source: `src/functions/shared/quotes.ts:32` (`usdToEgp: 53.0`).

---

## 2. Private Settings (`settings_private`)

### Proposed Row: `key = 'pricing'`
```json
{
  "key": "pricing",
  "value": {
    "usdToEgp": 50.0,
    "markup": 1.3,
    "minMarginThreshold": 0.20,
    "providerDailySpendCapUsd": 0.80,
    "jobMaxPointsCap": 600
  }
}
```

### Source & Rationale:
- **`usdToEgp: 50.0`, `markup: 1.3`, `minMarginThreshold: 0.20`**:
  - Source: `scripts/setup-db.ts:572-575`.
- **`providerDailySpendCapUsd: 0.80`**:
  - Source: Project constant `PROVIDER_DAILY_SPEND_CAP_USD = 0.80`.
- **`jobMaxPointsCap: 600`**:
  - Source: Project constant `JOB_MAX_POINTS_CAP = 600`.

---

## 3. Capability Registry (`capability_registry`)

### Pricing Formula:
$$\text{pointsPerUsd} = \frac{\text{usdToEgp} \times \text{markup}}{\text{creditValueEgp}} = \frac{53.0 \times 2.0}{0.10} = 1060 \text{ points/USD}$$
$$\text{unitPricePoints} = \lceil \text{unitCostUsd} \times \text{pointsPerUsd} \rceil$$

### Proposed Capability Catalog (from `scripts/update-capability-registry.ts`):

| Slug | Endpoint ID | Pricing Unit | Cost Basis (USD) | Unit Price (Points) | Enabled | Source |
| :--- | :--- | :---: | :---: | :---: | :---: | :--- |
| `tiktok-profile` | `tikhub.tiktok.user.profile` | call | 0.00100 | **2** | `true` | `update-capability-registry.ts:27` (Verified live in job_calls: 1000 µUSD) |
| `tiktok-user-videos` | `tikhub.tiktok.user.posts` | item | 0.00030 | **1** | `false` | `update-capability-registry.ts:59` |
| `tiktok-keyword-videos` | `tikhub.tiktok.search.video` | item | 0.00035 | **1** | `false` | `update-capability-registry.ts:80` |
| `x-user-tweets` | `twitter.user.tweets` | item | 0.00025 | **1** | `false` | `update-capability-registry.ts:101` |
| `x-keyword-search` | `twitter.search.tweets` | item | 0.00030 | **1** | `false` | `update-capability-registry.ts:122` |
| `instagram-profile` | `instagram.user.profile` | call | 0.00120 | **2** | `false` | `update-capability-registry.ts:143` |
| `instagram-user-posts` | `instagram.user.posts` | item | 0.00040 | **1** | `false` | `update-capability-registry.ts:164` |
| `youtube-channel` | `youtube.channel.details` | call | 0.00100 | **2** | `false` | `update-capability-registry.ts:185` |
| `youtube-video-search` | `youtube.search.video` | item | 0.00040 | **1** | `false` | `update-capability-registry.ts:206` |
| `facebook-page-posts` | `facebook.page.posts` | item | 0.00050 | **1** | `false` | `update-capability-registry.ts:227` |
| `google-serp-search` | `google.serp.organic` | call | 0.00200 | **3** | `false` | `update-capability-registry.ts:248` |
| `telegram-channel-posts` | `telegram.channel.messages` | item | 0.00030 | **1** | `false` | `update-capability-registry.ts:269` |

> Only `tiktok-profile` is enabled (`true`), matching the active production capability. All others are marked `enabled = false` ("coming soon") pending cost verification.

---

## 4. Templates (`templates`)

### Proposed Rows (from `scripts/setup-db.ts:578-850`):
1. **`tiktok-profile`**:
   - `id`: `tiktok-profile`
   - `title_ar`: `"ملف تيك توك الشخصي"`
   - `prompt_ar`: `"استخراج بيانات الملف الشخصي لحساب تيك توك عام مع إحصائيات المتابعين والمشاهدات"`
   - `category`: `"social"`
   - `enabled`: `true`

---

## 5. SQL Insertion Script (DO NOT RUN - Awaiting Owner Approval)

```sql
-- To be executed only after Owner review and approval:
BEGIN;

INSERT INTO public.settings_public (key, value, updated_at) VALUES (
  'pricing',
  '{"creditValueEgp": 0.1, "safetyBuffer": 0.15, "minPoints": 1, "markup": 2.0, "usdToEgp": 53.0}'::jsonb,
  now()
) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();

INSERT INTO public.settings_private (key, value, updated_at) VALUES (
  'pricing',
  '{"usdToEgp": 50.0, "markup": 1.3, "minMarginThreshold": 0.2, "providerDailySpendCapUsd": 0.8, "jobMaxPointsCap": 600}'::jsonb,
  now()
) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();

INSERT INTO public.capability_registry (
  slug, name_ar, name_en, category, endpoint_id, pricing_unit, unit_cost_usd, unit_price_credits, enabled, max_rows, pagination_type, params, params_schema
) VALUES
  ('tiktok-profile', 'استخراج ملف تيك توك الشخصي', 'TikTok User Profile', 'tiktok', 'tikhub.tiktok.user.profile', 'call', 0.001, 2, true, 1, 'none', '["username"]'::jsonb, '{"type":"object","properties":{"username":{"type":"string"}},"required":["username"]}'::jsonb),
  ('tiktok-user-videos', 'مقاطع فيديو مستخدم تيك توك', 'TikTok User Recent Videos', 'tiktok', 'tikhub.tiktok.user.posts', 'item', 0.0003, 1, false, 200, 'cursor', '["username","count"]'::jsonb, '{"type":"object","properties":{"username":{"type":"string"},"count":{"type":"integer"}},"required":["username"]}'::jsonb)
ON CONFLICT (slug) DO UPDATE SET
  name_ar = EXCLUDED.name_ar,
  unit_price_credits = EXCLUDED.unit_price_credits,
  enabled = EXCLUDED.enabled;

INSERT INTO public.templates (id, title_ar, prompt_ar, category, enabled) VALUES
  ('tiktok-profile', 'ملف تيك توك الشخصي', 'استخراج بيانات الملف الشخصي لحساب تيك توك عام مع إحصائيات المتابعين والمشاهدات', 'social', true)
ON CONFLICT (id) DO UPDATE SET title_ar = EXCLUDED.title_ar, prompt_ar = EXCLUDED.prompt_ar;

COMMIT;
```
