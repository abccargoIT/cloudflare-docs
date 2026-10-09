# Service targets, transfer, and the two numbers nobody measured

**Status:** Decision logic built and demonstrated. **Not yet persisted and not
yet exposed over HTTP** — see §8, which is the part to read before quoting
this document to anyone.
**Prepared by:** ABC Cargo IT Department
**Date:** 8 October 2026

---

## 1. Executive summary

Four items from the design package's unbuilt list are now built as platform
logic and visible in the demonstration:

| # on the unbuilt list | Item                  | State                          |
| --------------------- | --------------------- | ------------------------------ |
| 7                     | Per-team SLA policies | Built, demonstrated on Setup   |
| 6                     | Cross-region transfer | Built, demonstrated on Inbox   |
| 4                     | CSAT                  | Built, demonstrated on Reports |
| 4                     | Bot deflection        | Built, demonstrated on Reports |

Four new source modules, 77 new tests, 365 passing in total. Each is a pure
function over records — no database, no clock beyond the one passed in — which
is the same shape as the rest of the platform's decision logic and the reason
it can be tested at all.

Three of the four turned up something the designs do not show. Those three
findings are the substance of this document; the code is secondary.

## 2. Finding: a conversation cannot change its WhatsApp number

The designs offer "Forward to KSA team" and "Transfer to another region" as
though a conversation could move house. It cannot, and the reason is not a
limitation of the build.

The customer messaged `+971800916`. That is the thread on their handset, and
the 24-hour service window is a property of that number paired with that
customer — not of whichever team happens to hold the work. Replying from the
KSA number would start a second, unrelated thread from a number the customer
has never contacted, and the window on it would be closed, so the first
message would have to be an approved template.

So a transfer moves **ownership** and never the channel. The KSA team answers
the customer and the reply still leaves over the UAE number.
`transferConversation` returns the phone number ID unchanged, and
`assertChannelUnchanged` is called on the write path so that a later
well-meaning change — "correct the number to match the new region" — fails
loudly instead of silently splitting a customer's thread in two.

## 3. Finding: a transfer must not restart the service clock

A conversation transferred twenty minutes into a thirty-minute first-response
target is ten minutes from late. Recomputing the due date from the transfer
instant would reset it, which makes a transfer the cheapest way to clear a
late queue and hides the customer's real wait from everyone looking at the
dashboard. The customer has been waiting since they wrote.

The due date is therefore carried over untouched. What the receiving team gets
instead of a reset clock is a warning, because the honest problem is real:
handing UAE work to the UK at 17:00 Dubai time, when London is open, is
routine; handing it over at 23:00 Dubai time, when London is shut, sets a
target nobody can meet. `transferConversation` returns that as
`first_response_due_outside_receiving_hours`, alongside
`receiving_region_closed`, `first_response_already_late`,
`service_window_closed` and `service_window_closing_soon`.

Warning rather than silently re-basing is the whole design. The alternative
produces a dashboard where nothing is ever late and nobody knows why.

## 4. Finding: a deflection rate hides its own failures

"41% deflected" can be computed several ways from the same data, and the
difference between them is exactly the amount by which the bot is failing
quietly.

The bot already records why each session ended, so no new definition had to be
invented — only an honest mapping of the reasons the platform actually writes:

| End reason                               | Counts as     | Why                                                              |
| ---------------------------------------- | ------------- | ---------------------------------------------------------------- |
| `completed`, no human message            | Deflected     | The bot answered; nobody was needed                              |
| `handover`, `customer_asked_for_agent`   | Escalated     | A person finished it                                             |
| `too_many_invalid_replies`, `flow_stuck` | Escalated     | The bot failed. A failure is not a deflection                    |
| `expired`, no human message              | **Abandoned** | The customer went quiet. Nobody can say whether they were helped |

Abandonment is the category that decides the headline. Computing
`deflected / (deflected + escalated)` treats every abandonment as though it
never happened. On the demonstration's own data that reads **51%**. Dividing
by every ended session instead — abandonment included — reads **41%**.

The Reports screen publishes 41% and prints 51% beside it, labelled as the
figure that excludes abandonment, so neither can be quoted without the other.
Abandoned sessions also get their own breakdown by step, because abandonment
is uninterpretable in aggregate and perfectly interpretable per question: if
the same question loses everybody, the question is the problem.

A `completed` session where a human did send a message is **not** deflected.
The end reason describes the bot's flow, not the conversation.

## 5. CSAT: eligibility that cannot be gamed

A survey is a business-initiated message, so it obeys the same two rules as
any other: outside the 24-hour window it can only be an approved template, and
a customer who has opted out is not surveyed. Beyond that:

- Once per conversation, and at most once per customer per 30 days. Survey
  fatigue depresses the response rate, and a falling response rate biases the
  score toward whoever is still bothering to answer.
- A survey stops accepting answers after 72 hours.
- Replies are read from button payloads (`csat:4`) **and** from typed text,
  including `5/5`, `4 - good service` and Arabic-Indic digits, because
  insisting on a button press loses real responses and biases the sample
  toward the button-pressers.

**There is deliberately no way to exclude a conversation from the survey
because it went badly.** Eligibility turns on channel, consent and fatigue —
never on the outcome, the ticket type or the agent. A score that can be shaped
by choosing who to ask is worse than no score.

A mean is never returned without the response count and the response rate, and
below ten responses `summarise` sets `reportable: false` and the screen prints
a sentence instead of a figure. Each region clears that minimum on its own: on
the demonstration's data UAE publishes 4.4/5 from ten replies, and KSA shows
"3 responses — too few to publish a score" where the designs showed a number.
A healthy group sample is precisely how a thin regional one gets laundered
into a headline.

## 6. Per-team service targets

The designs set targets on the team — "UAE Support 5m/4h", "UAE Sales 15m/1d".
The build set them per region and per ticket type. Both now apply, resolved
most-specific-first:

1. the team's entry for that ticket type
2. the team's own default
3. the region's entry for that ticket type
4. the region's default
5. the platform default

`resolveTarget` returns the target **with its provenance**, because a
supervisor looking at a five-minute target will ask why, and "UAE Support sets
5 minutes for a claim" is an answer where "5" is not. The Setup screen shows
all five levels in force and marks inherited rows apart from the team's own.

A malformed policy is ignored, reported, and not fatal. A stored target of
zero minutes must not take a region's ticket queue down, and must not silently
become the thing a team is measured against — so it falls through to the next
level and the Setup screen says so. The demonstration carries one on purpose:
open **KSA Night Desk**.

Priority still shortens a target on top of all of this, and the platform's
floors still apply, so a team policy of 2 minutes resolves to 5. `stated` and
`target` are both returned so the gap between what a team asked for and what
applies is visible rather than mysterious.

## 7. A bug this work exposed

Wiring the platform's authorisation functions into the demonstration surfaced
a real defect in the demonstration's data, not in the rules.

`assignedAgentId` held a **display name** — `"Mariam (agent)"` — while the
platform's `canTransfer`, `canReplyToConversation` and
`canAssignConversation` all compare that field against a caller's `id`. The
comparison could never match, so an agent was refused their own conversation
with a message that sounded entirely correct.

This is the second instance of the same class of fault in this build: demo
data shaped differently from what a platform function expects, producing a
plausible wrong answer rather than an error. The first was `direction` where
the records use `dir`, which silently zeroed two dashboard figures.

Fixed by introducing `AGENT_ID` for the identifier and keeping `AGENT_NAME`
for display, and by pointing both at Omar, who is an actual agent in the Setup
directory, so the people list and the conversations now agree. Verified by
signing in as three different people and checking the transfer control:

| Signed in as                    | Same-region teams | Other regions |
| ------------------------------- | ----------------- | ------------- |
| Master admin                    | Permitted         | Permitted     |
| Agent who owns the conversation | Permitted         | Refused       |
| Agent who does not own it       | Refused           | Refused       |

## 8. What is NOT built

Read this before telling anyone these features are available.

- **Nothing is persisted.** There is no D1 table for team policies, transfer
  records, survey sends, survey responses or bot session outcomes, and no
  migration. The demonstration holds them in browser storage.
- **Nothing is exposed over HTTP.** No endpoint transfers a conversation,
  edits a team policy, sends a survey or returns these figures. `src/index.ts`
  is untouched.
- **No survey is ever sent.** `shouldSendSurvey` decides whether one should be
  and over which channel; nothing dispatches it. That needs a scheduled job,
  an approved survey template per language, and a reply route that recognises
  a survey answer before the bot sees it.
- **Report item 3 is still unbuilt** — charts, a report library and export.
  Only the two measurement items from item 4 were done.
- **Per-team policies are not editable.** The Setup screen displays them;
  there is no form, and `validateTeamPolicy` has no caller yet.
- The figures on the Reports screen are computed from **seeded demonstration
  data**, not from ABC Cargo's traffic. They are real computations over
  invented numbers.

## 9. Still blocked on a decision

Unchanged from the acceptance note, and none of it was guessed at here:

1. **Third region** — the package says Oman; the business runs UK. The
   demonstration still uses UK.
2. **Palette** — graphite/steel/amber in the designs, ABC Cargo red in the
   build.
3. **"Payment"** as a lifecycle stage.
4. **Email and phone channels** — the largest remaining piece of package
   scope, and still an open question of timing rather than of design.
5. The three **Freshchat bot flow exports**, which remain the largest single
   blocker to replacing the live service.

## 10. Status

Built, tested, demonstrated, documented. Typecheck, ESLint, Prettier and all
365 tests pass. All 14 demonstration views verified rendering in headless
Chromium after the change.

No live system was touched. No Meta credential exists in this work. The
standing hold of 8 October 2026 is unaffected.

## 11. Next action

Decide §9.1 and §9.2, which unblock the Management pack. If these four
features are wanted in production rather than only in the demonstration, the
next step is a migration and four endpoints, which is a separate change note.
