# Engage — what is needed on go-live day, and what is not needed before it

**Prepared by:** Head of IT, ABC Cargo IT Department
**Date:** 8 October 2026
**Position agreed:** the three Meta phone number IDs are supplied at go-live, after the pre-cutover checks — not now.

---

## 1. Executive summary

Holding the phone number IDs back until go-live is the right call and costs
nothing, **provided the platform can still be tested without them.** As
committed, it could not: all three regions carried the same `REPLACE_ME`
placeholder, `parseRegionConfig` correctly refuses duplicates, and the refusal
made **every `/api/*` route answer 500**. Nothing could be exercised.

That is now fixed. Each region carries a distinct placeholder, so the whole
platform runs and can be tested end to end — everything except an actual send
to Meta, which is the only thing a real id unlocks.

Verified: `/api/dashboard`, `/api/conversations`, `/api/broadcasts` and
`/api/contacts/board` all answer **200** where they previously answered 500.

## 2. What is now correct, and what is still a placeholder

| Field                 | Status                                                 |
| --------------------- | ------------------------------------------------------ |
| Region ids and labels | **Correct** — `uae`, `ksa`, `uk`                       |
| Published numbers     | **Correct** — +971800916, +966548454866, +447388800000 |
| Timezones             | **Correct** — Asia/Dubai, Asia/Riyadh, Europe/London   |
| Languages             | **Correct** — en, ar, en                               |
| `phoneNumberId`       | **Placeholder**, by agreement — supplied at go-live    |
| `businessHours`       | **NOT CONFIRMED** — see §3                             |

Confirmed working across the three timezones: with the clock at 16:58 UTC the
dashboard reported Dubai 20:58, Riyadh 19:58, London 17:58. The offsets are
read from the zone, not hard-coded.

## 3. Business hours — settled

Given by the Head of IT on 8 October 2026 and confirmed the same day:

| Region | WhatsApp desk  | Hours (local) |
| ------ | -------------- | ------------- |
| UAE    | All seven days | 08:00 – 23:00 |
| KSA    | All seven days | 08:00 – 23:00 |
| UK     | All seven days | 08:00 – 23:00 |

### The distinction that matters

**These are the WhatsApp desk hours, not the office week.** The offices work
UAE and KSA Sunday to Thursday, UK Monday to Friday. The desk is covered all
seven days, which is why the configuration says seven.

That distinction is written into `wrangler.jsonc` beside the values, because
the obvious "correction" is to put the office week back — and doing so would
tell customers the desk is shut on days it is staffed, and stop the service
clocks running while agents are answering.

### What this changes

- **The out-of-hours automated reply now fires only overnight**, between 23:00
  and 08:00 in each region. Verified: open at 22:59, shut at 23:00, shut at
  07:59, open at 08:00 — a nine-hour gap and a fifteen-hour day.
- **Service targets run every day**, weekends included, which is correct when
  agents are there to meet them. A target set in business minutes no longer
  stops on a Friday in Dubai.
- **Each region keeps its own clock.** The hours are identical but the
  timezones are not, so the three desks close three hours apart in real time.

Verified against the running platform across a full week: open Sunday through
Saturday in all three regions, with the correct local time in each.

## 4. What is needed on go-live day

Per region, one value:

| Region | Value           | Where it comes from                                    |
| ------ | --------------- | ------------------------------------------------------ |
| UAE    | `phoneNumberId` | Meta Business Suite → WhatsApp Manager → Phone numbers |
| KSA    | `phoneNumberId` | as above                                               |
| UK     | `phoneNumberId` | as above                                               |

It is an identifier, not a secret — it may be pasted into configuration and
committed. The access token is the secret, and that is set with
`wrangler secret put`, never in a file.

Swapping them in is one edit to `REGION_NUMBERS` in `wrangler.jsonc` and a
redeploy. Nothing else in the platform changes.

## 5. What is still needed before go-live, beyond the numbers

Carried forward from the module documents, in the order they block things:

1. **The three Freshchat bot flow exports** (`ABC Cargo`, `ABC Cargo KSA`,
   `ABC Cargo UK`). The largest outstanding item. Without them a cutover either
   drops the bot the customers currently meet, or replaces it with something
   nobody has approved.
2. **The first `master_admin`** — name and work email.
3. **Which templates Meta has approved**, for broadcasts and notifications.
4. **Retention decisions** for bot turns, broadcast recipients, internal notes
   and outbound media.

## 6. What is deliberately NOT needed before go-live

Worth stating so none of it is chased unnecessarily:

- **The demonstration deployment needs none of the above.** It has no bindings,
  no credentials and no region configuration at all.
- **A Meta access token is not needed to test the platform.** Everything except
  the final send runs without one.
- **The real phone number IDs are not needed to test the platform** — which is
  the point of this change.

## 7. Status

Config corrected, committed and pushed. The platform is testable end to end.

The standing hold remains in force: nothing deployed to the live numbers,
nothing registered with Meta, no remote database migration, broadcasts switched
off. The only approval given so far is for the demonstration.
