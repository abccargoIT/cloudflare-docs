# Engage — Broadcasts

**Prepared by:** Head of IT, ABC Cargo IT Department
**Date:** 8 October 2026
**Status:** Built and verified against a local database. **Sending is switched off.** Nothing deployed. No message sent to anyone.

---

## 1. Executive summary

Template broadcasts are built: audience selection, a frozen recipient list, a
two-person approval, paced sending, a kill switch, and real delivered / read /
replied figures taken from Meta's own status webhooks rather than estimated.

**This is the most dangerous module in the platform.** Everything else in
Engage affects one conversation at a time. A broadcast reaches thousands of
real customers from a single action, and the mistakes it enables — the wrong
template, the wrong audience, a placeholder left in the text, a number
throttled by Meta — are not recoverable once the messages have gone.

So the module is built to be hard to fire by accident, and it is **inert by
default**:

- `BROADCASTS_ENABLED` is `"false"` in `wrangler.jsonc`. With anything other
  than `"true"`, an approved broadcast will not dispatch a single message and
  the pacer does nothing. Turning broadcasts on is a separate decision from
  deploying the Worker. Verified both ways round — see §6.
- A broadcast cannot be approved by the person who wrote it.
- The recipient list is written down before approval, so approval applies to
  particular people rather than to a query that might return different ones.
- Opt-out is re-checked for every recipient immediately before their message
  is sent, not only when the list was drawn up.

## 2. Business requirement

The design package specifies broadcasts with audience, delivered, read and
replied. The operational need is narrower and more immediate than marketing:
when a sailing is cancelled or a customs rule changes, several hundred
customers need telling at once, and today that is done by hand or not at all.

## 3. Scope

| In scope                                                | Not in scope                             |
| ------------------------------------------------------- | ---------------------------------------- |
| Audience selection in SQL, with the exclusions enforced | Creating or submitting templates to Meta |
| A frozen recipient list and a two-person approval       | A/B testing, send-time optimisation      |
| Paced sending, pause, resume, cancel                    | Marketing automation or drip sequences   |
| Delivered / read / replied from Meta's status webhooks  | Attribution of revenue to a campaign     |
| A per-recipient record of what happened and why         | A UI — this is the API one would read    |

## 4. The five safety properties

These are the parts worth reviewing. Each exists because of a specific failure.

### 4.1 Sending is off unless somebody turns it on

`BROADCASTS_ENABLED` must be exactly `"true"`. It is checked at the route _and_
again in the pacer, so a broadcast left in `sending` when the switch is turned
off does not quietly resume.

A platform that can message every customer the moment it is deployed is one bad
merge away from doing so.

### 4.2 The audience is frozen before it is approved

Resolving an audience writes a row per recipient. Approval then applies to that
written-down list. A broadcast that selected its recipients at send time could
message people nobody reviewed — new customers added between approval and send,
for instance.

A campaign that has started cannot be re-aimed at all. Reconciling a new list
against the people already messaged either messages somebody twice or drops
them silently, and neither is acceptable; a part-sent campaign is paused,
cancelled or finished.

### 4.3 Approval is a second person's act

The author of a broadcast cannot approve their own. This is deliberately an
obstacle. The failures it catches — wrong template, wrong audience, a
placeholder left in the text — are caught by nothing else in the platform, and
are caught almost every time by one other person reading it.

Changing the message or the audience sends the broadcast back to draft and
clears the approval. Otherwise the thing a second person read is not the thing
that goes out.

### 4.4 Opt-out is absolute, and checked twice

The audience query excludes anyone who has opted out, and it is the compiler
that adds that condition rather than the rule — so no audience can be written
that omits it. It applies to service notices as well as marketing.

Then, immediately before each message, the sender re-checks the opt-out for the
recipients in that batch. This is what makes freezing the list safe: somebody
who asked not to be contacted yesterday is not messaged today because of a list
drawn up last week.

Marketing additionally requires `opt_in_marketing`. A service notice about a
shipment the customer asked us to carry does not — but a customer excluded by
the marketing opt-in is **recorded as skipped with the reason**, not silently
dropped, because "4,812 of 5,000 sent" needs an answer better than a guess.

### 4.5 A recipient cannot be messaged twice

The primary key on `(broadcast_id, wa_id)` makes a double send impossible
rather than unlikely — a retried queue batch or a second press of Send cannot
produce two messages to one number.

The pacer claims work with an `UPDATE … RETURNING` that moves rows to `sending`
in the same statement that selects them, so two concurrent passes cannot pick
up the same recipient. Verified in §6.

## 5. What was built

| File                                    | What it holds                                              |
| --------------------------------------- | ---------------------------------------------------------- |
| `src/broadcasts/types.ts`               | The lifecycle, the recipient states, forward-only delivery |
| `src/broadcasts/audience.ts`            | Audience rules compiled to SQL, with the exclusions        |
| `src/broadcasts/template.ts`            | Template name, language and variable checking              |
| `src/broadcasts/policy.ts`              | Who may compose, approve, send and stop                    |
| `src/broadcasts/service.ts`             | Storage, the frozen list, the claim, the figures           |
| `src/broadcasts/sender.ts`              | Paced dispatch, the opt-out re-check, failure handling     |
| `src/db/migrations/0009_broadcasts.sql` | `broadcasts`, `broadcast_recipients`                       |

Pacing is driven by a one-minute cron trigger, not by the request that pressed
Send. A campaign of several thousand cannot be sent inside one request — that
request would be killed part way through with no record of how far it had got.

The send rate is held between 1 and 120 per minute. Meta throttles a number
that sends too fast and lowers its quality rating, and that rating is shared
with every ordinary customer conversation on the same number. A campaign that
gets the UAE number rate-limited has damaged the thing it was meant to support.
`MAX_AUDIENCE` is 10,000 for the same reason: anything larger should be split
deliberately.

## 6. Evidence

Verified on 8 October 2026 against a **local** database, with a local-only
service key in a gitignored `.dev.vars` that was deleted afterwards. The
fixture was invented and was deleted afterwards. **No message was sent and no
request was made to Meta.** No remote database, no deployment.

| Check                                         | Result                               |
| --------------------------------------------- | ------------------------------------ |
| `npm run test`                                | **268 passed, 0 failed** (36 new)    |
| `npm run typecheck` / `lint` / `format:check` | Clean                                |
| `wrangler deploy --dry-run`                   | 386.31 KiB / 94.25 KiB gzip          |
| `wrangler d1 migrations apply --local`        | `0009_broadcasts.sql`, 8 commands    |
| A machine credential composing a campaign     | **403 `service_caller`**             |
| `GET /api/broadcasts`                         | 200, reports `sendingEnabled: false` |

### 6.1 The switch was verified in both directions

A broadcast was left in status `sending` with four pending recipients, and the
pacer was invoked.

| `BROADCASTS_ENABLED` | Result                                                                                                               |
| -------------------- | -------------------------------------------------------------------------------------------------------------------- |
| off (the default)    | Pacer returned immediately. All four recipients still `pending`, broadcast still `sending`. **Nothing dispatched.**  |
| `"true"`             | Pacer acted: it found the broadcast, saw its region was not configured, and **paused** it. Still nothing dispatched. |

The second half matters as much as the first. Without it, "nothing was sent"
would be consistent with the pacer never having run at all, and the test would
prove nothing about the switch.

The switch-on case was deliberately arranged to exercise the
unconfigured-region guard, so the pacer could be shown to be active **without
any outbound request to Meta**. A test that actually attempted a send would
have contacted Meta's API, which is not something to do unasked.

### 6.2 The audience exclusions were checked against real rows

Seven customers were seeded. The resolve query returned exactly the right three
UAE numbers:

| Customer                    | In the audience?  | Why                                  |
| --------------------------- | ----------------- | ------------------------------------ |
| A — opted in, has shipped   | Yes               |                                      |
| B — opted in, never shipped | Yes               |                                      |
| C — **not** opted in        | Yes, as `skipped` | Recorded `not_opted_in`, not dropped |
| D — **opted out**           | **No**            | Excluded by the compiler's condition |
| E — no WhatsApp number      | **No**            | Cannot be messaged on WhatsApp       |
| G — a KSA customer          | **No**            | Wrong region                         |

### 6.3 The double-send and race guards were demonstrated

Inserting a recipient already present in a broadcast left the count at **4, not
5** — the primary key refused it.

Claiming batches of two from four pending recipients returned:

| Pass | Returned                          |
| ---- | --------------------------------- |
| 1    | …900001, …900002                  |
| 2    | …900005, …900006 — **no overlap** |
| 3    | nothing                           |

Two concurrent passes cannot hand out the same recipient.

### 6.4 A bug found in my own code, before it shipped

`parseAudience` originally fell back to `{ customerIds: [] }` for an unreadable
audience rule, with a comment claiming this "resolves to nobody rather than to
everybody". It did the opposite. Every field in an audience rule is a
_narrowing_ filter, and `compileAudience` skips an empty list entirely — so the
fallback would have resolved to **every customer in the region with a WhatsApp
number**.

It now returns `null`, and `resolveAudience` refuses with
`unreadable_audience`. There is no safe default here, so the caller is required
to handle it rather than being handed something that looks usable. A test
pins the behaviour.

### 6.5 A correction to a claim in my own test

One test asserted that grouping by WhatsApp id stops two customer records for
the same number producing two messages. `customers.wa_id` is already uniquely
indexed, so that cannot happen — the grouping is belt and braces, and the guard
that matters is the recipient primary key. The test comment now says so rather
than claiming to prevent something impossible.

## 7. API

| Method | Path                                    | Who                                                                           |
| ------ | --------------------------------------- | ----------------------------------------------------------------------------- |
| GET    | `/api/broadcasts?region=`               | Region scope; reports `sendingEnabled`                                        |
| POST   | `/api/broadcasts`                       | Team lead or master admin                                                     |
| GET    | `/api/broadcasts/:id`                   | Region scope; includes a plain-English audience description and live progress |
| PATCH  | `/api/broadcasts/:id`                   | Composer; voids approval where it matters                                     |
| GET    | `/api/broadcasts/:id/recipients?state=` | Region scope                                                                  |
| POST   | `/api/broadcasts/:id/resolve`           | Composer; before the first send only                                          |
| POST   | `/api/broadcasts/:id/status`            | `review`, `approved`, `sending`, `paused`, `cancelled`                        |

An agent cannot compose a broadcast, and a machine credential cannot either.
Every lifecycle step is written to the audit log with who did it and, for an
approval, how many people it covered.

Refusals about the _state_ of a broadcast answer **409**, not 400: the request
was well formed and the refusal is about where the broadcast had got to.

`POST /api/broadcasts/:id/status` with `paused` is the kill switch. It takes
effect on the next pacer pass, so the worst case is one batch — at the default
rate, twenty messages.

## 8. Risk

| Risk                                                 | Mitigation                                                              |
| ---------------------------------------------------- | ----------------------------------------------------------------------- |
| A campaign sent by accident                          | `BROADCASTS_ENABLED` off by default, checked at the route and the pacer |
| The wrong template or audience approved              | A second person must approve; editing voids the approval                |
| Somebody messaged after opting out                   | Excluded at resolve, re-checked per recipient at send                   |
| A recipient messaged twice                           | Primary key on (broadcast_id, wa_id); claim-and-select in one statement |
| The number throttled, hurting ordinary conversations | Rate capped at 120/minute, audience capped at 10,000                    |
| One bad number stranding the campaign                | Failures recorded per recipient; the batch carries on                   |
| A campaign claiming credit for unrelated replies     | Replies attributed only within 72 hours of that recipient's send        |
| A read figure that falls as statuses arrive          | Delivery states move forward only                                       |

## 9. What is still required from the business

1. **Which templates exist and are approved by Meta.** Nothing here can create
   one. A campaign naming a template Meta has not approved fails for every
   recipient.
2. **Who may approve a broadcast**, and whether the two-person rule is
   acceptable as built. It is deliberately strict; relaxing it is a decision,
   not a change I would make unasked.
3. **Whether `opt_in_marketing` is actually populated.** If it is empty for
   everyone, every marketing audience resolves to nobody — which the platform
   will refuse to approve, correctly, but it would look like a fault.
4. **A retention decision for `broadcast_recipients`**, which records who was
   messaged and when.

## 10. Rollback

Nothing deployed and nothing sent, so nothing to roll back.
`0009_broadcasts.sql` adds two tables and touches no existing one, so applying
it to the remote database — when authorised — changes no existing row and is
reversible with `DROP TABLE`.

If broadcasts were ever enabled and a campaign went wrong, the sequence is:
`POST /api/broadcasts/:id/status` with `paused` to stop it within one batch,
then set `BROADCASTS_ENABLED` to `"false"` if the problem is not specific to
one campaign. Neither deletes anything, so the per-recipient record of what was
sent survives for the post-mortem.

## 11. Approval

No approval is required for what has been done, which is preparation and local
verification only. Nothing was sent and Meta was not contacted.

**`APPROVE LIVE CHANGE` would be required before** setting
`BROADCASTS_ENABLED` to `"true"`, applying `0009_broadcasts.sql` to the remote
database, deploying the Worker, or sending any broadcast — including a test
send to a real number.

The standing hold of 8 October 2026 — _"dont change any live"_ — remains in
force and none of the above has been requested.

## 12. Next action

From the design package this leaves the **Composer** additions — internal note,
voice note, file, location — as the only module with nothing built. None of it
is on the cutover's critical path.

The critical path remains the three Freshchat bot flow exports.
