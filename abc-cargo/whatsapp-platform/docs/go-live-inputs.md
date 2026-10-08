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

## 3. The one input that should not wait for go-live

**Business hours are unconfirmed, and the current values are probably wrong.**

All three regions read **Monday to Saturday, 09:00–18:00**. That is what this
file has always said; I have left it rather than substituting an assumption.
But it means the platform currently believes:

- the UAE and KSA desks work **Saturday and not Sunday**, which is backwards
  for a Gulf working week;
- the UK desk works **Saturday**, and until 18:00 London.

This is not cosmetic. Business hours drive two things that customers feel:

1. **The out-of-hours automated reply.** Wrong hours means a customer messaging
   on a working Sunday is told the office is shut, or one messaging on a closed
   Saturday waits in silence expecting an answer.
2. **Every service-target clock.** Targets are counted in business minutes on
   each region's own calendar, so a wrong calendar makes every first-response
   and resolution target wrong, in both directions.

**Needed per region: which days, and what hours.** It takes a minute to answer
and it should not wait for cutover day, because it wants testing against real
hours before anyone depends on it.

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
2. **Business hours per region** — §3.
3. **The first `master_admin`** — name and work email.
4. **Which templates Meta has approved**, for broadcasts and notifications.
5. **Retention decisions** for bot turns, broadcast recipients, internal notes
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
