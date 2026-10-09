# The bot fallback, flow cloning, and a bug in the service clock

**Status:** Built and demonstrated. **Not persisted and not exposed over
HTTP** — see §7. The service-clock fix in §2 is the part to read first.
**Prepared by:** ABC Cargo IT Department
**Date:** 9 October 2026

---

## 1. Executive summary

Item 8 of the design package's unbuilt list — the bot builder screen, its
"fallback after 10m", and "clone flow to another region" — is built, except
for one piece named in §6.

Two new modules, 45 new tests, **433 passing** in total.

The most important thing in this change is not either of those features. While
testing the fallback timer against the existing service clock, the round-trip
check found that **`addBusinessMinutes` has been computing due dates that
cross a closing time hours too early.** That is a live correctness bug in the
service targets, and §2 is about it.

## 2. The bug: service targets crossing a closing time were too early

### How it surfaced

The fallback timer needed the inverse of `addBusinessMinutes` — "how many
business minutes have elapsed" rather than "what instant is N business minutes
away". Having both makes a property available: walk forward with one, measure
the gap with the other, and the answer must come back. That test failed on the
first run.

### What was wrong

`addBusinessMinutes` walks a cursor through the region's calendar. When the
remaining target exceeded the time left in the current day, it called
`advanceToNextOpen(cursor, closeAt, openAt)` — handing it `closeAt` as "the
local minute the cursor is sitting on" while the cursor was still sitting at
the original time. It therefore advanced by far too little.

### What it produced

On a 08:00–23:00 calendar, from Monday 10:00 Dubai:

| Target      | Returned      | Correct       |
| ----------- | ------------- | ------------- |
| 780 min     | Mon 23:00     | Mon 23:00 ✓   |
| **781 min** | **Mon 19:01** | **Tue 08:01** |
| 900 min     | Mon 21:00     | Tue 10:00     |
| 1000 min    | Mon 22:40     | Tue 11:40     |

One extra minute of target moved the due date **four hours earlier**. The
function was not monotonic.

### What it meant operationally

Every first-response or resolution target that crossed a closing time landed
too early, so **tickets showed as breached before they were actually late**.
The 8-hour claim target, the 12-hour delivery target and the 24-hour billing
and documentation targets are all longer than a working day on at least one
region's calendar, so all of them were affected. The "SLA breaches" figure on
Reports and the "overdue" counts on the dashboard and in the ticket list were
overstated by this.

Nothing was understated: the error only ever made a target stricter, never
more lenient. No customer was disadvantaged; the figures shown to management
were.

### The fix

Move the cursor to closing time first, so the argument is truthful:

```ts
remaining -= availableToday;
cursor = new Date(cursor.getTime() + availableToday * MINUTE);
cursor = advanceToNextOpen(cursor, closeAt, openAt);
```

### Why it was not caught before

The existing tests covered targets inside a single day and targets that
consumed whole days. Neither shape crosses a close with time left over, which
is the only case that triggered it. Five regression tests now cover it,
including a monotonicity check that walks 1 to 2000 minutes and asserts no
target ever lands before a smaller one — the cleanest statement of the defect,
and the one that would have caught it on day one.

## 3. The fallback

The designs put "fallback after 10m" on a bot step. Without it a customer who
stops answering sits at the question until the session expires a day later and
nobody looks at it — by which time they have telephoned.

Four decisions, each with a reason:

**The timer runs in business minutes.** A question asked at 22:55, five
minutes before the desk closes, must not escalate at 23:05 into an empty
office. The clock pauses and resumes, using the same calendar walk as the
service targets — so a 10-minute fallback set at 22:55 fires at 08:05 the next
morning, when somebody can act on it. The demonstration proves this: with the
clock moved to 01:30 Dubai, a session silent for twenty minutes shows **0
business minutes** and waits.

**A fallback escalates; it does not abandon.** The session ends `handover`, not
`expired`. That changes the deflection figures and the change is the point: a
conversation a person picked up is an escalation, and counting it as
abandonment would flatter the bot for losing somebody quietly. Expect
`abandoned` to fall and `escalated` to rise once this runs against real
traffic.

**Escalation is never silent about the service window.** If the 24-hour window
has closed by the time the fallback fires, the agent can only open with an
approved template, and the decision says so rather than letting them discover
it when the send fails.

**Expiry beats the fallback.** A sweep that has not run for a day does not
suddenly escalate yesterday's abandoned sessions onto a live desk as though
they were current.

**Tier 2 is a configured destination, not an invented org chart.** A step may
name its queue; otherwise it goes to the region's own Tier 1 desk. Tier 2 is
reached only after Tier 1 has held the conversation past its own threshold,
and there is no tier 3, because ABC Cargo has not described one.

## 4. Flow cloning

The designs offer "clone flow to another region" as one button. It cannot be
one.

**The queue is the trap.** A UAE flow routes escalations to the UAE desk.
Cloned to KSA untouched, a Saudi customer who asks for a person lands in the
Dubai queue, where nobody is looking for them and where the service target
belongs to a different team. That is a silent mis-route, the worst kind. So a
queue naming the source region is remapped, and a queue naming something else
is carried over and flagged loudly rather than guessed at.

**What cannot be fixed automatically is reported, not rewritten.** A step
saying "our Dubai desk is open 08:00 to 23:00, rates from AED 45" is wrong in
Riyadh in three separate ways, and no string substitution makes it right — the
hours differ, the currency differs, the city is wrong. Each is reported against
its step. Silently editing a customer-facing message is worse than asking
somebody to read it.

**A clone is always a draft at version 1.** Cloning straight to `published`
would put an unreviewed flow in front of customers on a live number, which is
the accident this module exists to prevent. `cloneNeedsReview` is almost never
false, which is the honest answer: a flow written for one country rarely
transfers untouched.

### A bug this found in my own module

Running the clone against the actual starter flow immediately exposed one. The
starter flow's handover queue is the bare string `uae`, not `uae-support`, and
`remapQueue` only matched the hyphenated `<regionId>-<desk>` form — so the
clearest possible case of a queue needing a remap was reported as
"unrecognised" and would have been carried into KSA unchanged. Fixed, with a
test naming the starter flow as the reason.

That is the third time in this project that running code against real data
found something reasoning about it had not: `direction` where the records use
`dir`, a display name in `assignedAgentId`, and now this.

## 5. One more thing the demonstration caught

The fallback panel originally had a written explanation beside each row. With
the clock moved after hours those captions contradicted the live decisions —
a row read "past it, goes to the desk" while the decision correctly read "wait
10m". The caption is now derived from the decision's own reason code, so it
cannot disagree with the thing it captions.

## 6. What is NOT built

- **"Assign to group" is not built.** The runtime hands over to a queue but
  does not choose which group inside it, because who gets what is a routing
  rule ABC Cargo has not written down. A button that picks arbitrarily is
  worse than no button.
- **Nothing is persisted and nothing is exposed over HTTP.** No table stores a
  fallback setting or a cloned flow, no migration, and `src/index.ts` is
  untouched.
- **No sweep runs the fallback.** `checkFallback` decides and `applyFallback`
  produces the effects; nothing calls them on a schedule. That needs a cron
  trigger over waiting sessions, which is a separate change.
- **The builder is read-only.** It shows the flow as blocks with each waiting
  step's fallback, and it previews a clone. It does not edit a flow, add a
  step, or save anything — the designs' drag-and-drop canvas is not built.
- **No flow is actually cloned.** The panel shows what cloning would flag; it
  does not write the clone anywhere.

## 7. Status

Built, tested, verified, documented. Typecheck, ESLint, Prettier and all
**433** tests pass. All 14 demonstration views re-verified in headless
Chromium with no un-evaluated template literals. The business-minute pause was
verified by pinning the demonstration clock to 01:30 Dubai and confirming a
twenty-minute silence measures zero.

No live system was touched. The standing hold of 8 October 2026 is unaffected,
and the Access exemption in `docs/access-webhook-exemption.md` remains
unexecuted.

## 8. Still blocked on a decision

1. **Third region** — the package says Oman; the business runs UK.
2. **"Payment"** as a lifecycle stage.
3. **Email and phone channels** — now, or after the three WhatsApp cutovers.

And the three **Freshchat bot flow exports**, still the largest single blocker
to replacing the live service — and now more pointed than before, because the
fallback and the clone are machinery waiting for real flows to run.

## 9. Next action

The service-clock fix in §2 changes figures that have already been shown. If
any breach count was reported to management from this build, it was overstated
and is worth correcting.
