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

## 3. Business hours — given, with one point to confirm

Supplied by the Head of IT on 8 October 2026 and now in the configuration:

| Region | Days               | Hours (local) |
| ------ | ------------------ | ------------- |
| UAE    | Sunday to Thursday | 08:00 – 23:00 |
| KSA    | Sunday to Thursday | 08:00 – 23:00 |
| UK     | Monday to Friday   | 08:00 – 23:00 |

Verified against the running platform: open Sunday to Thursday in Dubai and
Riyadh, shut Friday and Saturday; shut Sunday in London, open Monday to
Friday, shut Saturday. The desk opens exactly at 08:00 local and closes at
23:00 — open at 22:59, shut at 23:00 — in each region's own timezone.

### The point to confirm

The hours were given as **"08:00 to 23:00 Monday to Sunday"**, which does not
sit with the five-day weeks in the same message. Both cannot be true: either
the desk is shut at the weekend, or it is open seven days.

**The narrower reading is in place**, deliberately, because the two mistakes
are not equally bad:

- If the desk _is_ staffed at the weekend and the platform thinks it is shut,
  a customer is told we are closed while somebody is actually there. Mildly
  wrong, and an agent still answers.
- If the desk is _not_ staffed and the platform thinks it is open, no
  automated reply is sent at all. The customer gets silence with no
  explanation and no idea when anyone will respond.

The second is the worse failure, so the configuration errs towards sending an
acknowledgement.

**One line settles it:** is the WhatsApp desk covered on Friday and Saturday
(UAE, KSA) and on Saturday and Sunday (UK)? If yes, the days become all seven
and the hours stay as they are.

Note this is a 15-hour day, which is well beyond an office week — so a seven-day
answer is a real staffing question rather than a formality.

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
2. **Confirmation of weekend cover** — §3. The hours themselves are settled.
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
