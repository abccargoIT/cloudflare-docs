# Integration design — ABC Cargo CRM and UK Microsoft telephony

**Status:** Prepared for review. Nothing built, nothing connected, no tenant inspected.
**Prepared by:** ABC Cargo IT Department
**Date:** 7 October 2026

---

## 1. Executive summary

Two integrations were requested: ABC Cargo's CRM, and the Microsoft telephony
system created for the UK today. They are different in kind and should not be
scheduled together.

**Telephony is tractable and can be built now.** Microsoft Graph publishes a
call record after every Teams call, and Engage already has a `calls` table and
an activity stream shaped to receive it. The work is a webhook endpoint, a
number-to-customer match, and two new columns.

**The CRM integration is blocked on a decision, not on engineering.** Engage
already contains a customer, lead, quotation, booking and ticket model. If ABC
Cargo's CRM contains the same records, one of the two has to be the system of
record for each. Choosing wrongly produces two half-correct customer lists that
disagree, which is worse than either system alone. That decision is set out in
§4 and belongs to the Head of IT, not to the implementation.

**One constraint worth stating immediately:** a Teams call record is created
_after the call ends_. It cannot pop a customer's record onto an agent's screen
while the phone is ringing. If a screen pop is wanted, it is a different and
considerably larger piece of work — see §3.3.

## 2. What Engage already has

| Asset                     | Where                       | Fit                                                  |
| ------------------------- | --------------------------- | ---------------------------------------------------- |
| `calls` table             | `0002_operations.sql`       | direction, agent, start, duration, outcome, link     |
| Link to any record        | `linked_type` / `linked_id` | a call can attach to a lead, booking, ticket or chat |
| Activity stream           | `activities`                | one customer timeline across every channel           |
| Customer lookup by number | `customers.phone`, `wa_id`  | the join a telephony feed needs                      |
| Regional separation       | `region_id` everywhere      | UK telephony stays UK-only, as required              |

The telephony integration is therefore mostly plumbing into a model that was
already built for it. The Calls view in `demo/app.html` shows the end state.

## 3. UK Microsoft telephony

### 3.1 What the system actually is — to be confirmed

"Microsoft PABX" most likely means **Microsoft Teams Phone**, with calls
reaching the public network either through a Microsoft Calling Plan or through
Direct Routing via a session border controller. Which of the two is in use
changes nothing about the integration below, but it changes who to involve when
a call fails to appear.

**Not yet verified.** No Microsoft 365 tenant has been inspected. Under ABC
Cargo's own rules a corporate tenant is not connected to a personal Claude
account without explicit instruction, so this is stated as the likely case
rather than as fact.

### 3.2 Recommended: call records after the call (build this first)

Verified against Microsoft Learn:

| Item           | Detail                                                                          |
| -------------- | ------------------------------------------------------------------------------- |
| API            | Microsoft Graph, `/communications/callRecords`                                  |
| Delivery       | Change notification (webhook) on create and update                              |
| Permission     | `CallRecords.Read.All` — **application** permission; delegated is not supported |
| Timing         | The record is created **after the call ends**                                   |
| Retention      | Microsoft keeps a call record for 30 days                                       |
| Filtering      | Notifications can be filtered to specific participants by Entra object ID       |
| PSTN reporting | `getPstnCalls` and `getDirectRoutingCalls` give tabular usage data              |
| Tenant limit   | 10,000 Teams subscriptions per organisation, shared across all Teams resources  |

Flow:

1. Graph posts a notification to a new Engage endpoint, `/telephony/graph`.
2. Engage validates the notification, then fetches the full call record.
3. The external number is normalised to E.164 and matched against
   `customers.phone` and `customers.wa_id`.
4. A `calls` row is written with `region_id = 'uk'`, and one activity is added
   to that customer's timeline.
5. No match: the call is held as unmatched for an agent to assign, rather than
   silently dropped or attached to a guess.

Schema additions needed, both for safety rather than features:

```sql
ALTER TABLE calls ADD COLUMN external_id TEXT;   -- Graph call record id
ALTER TABLE calls ADD COLUMN source TEXT;        -- manual | teams
CREATE UNIQUE INDEX idx_calls_external ON calls (source, external_id)
	WHERE external_id IS NOT NULL;
```

The unique index is the important half. Graph sends an update notification
whenever a record is revised, so without it one call would appear several times
on the customer's timeline.

Subscriptions expire and must be renewed on a schedule. A missed renewal is
silent: calls simply stop arriving. The renewal job needs its own alert.

### 3.3 Screen pop — possible, but a separate project

A call record cannot drive a screen pop, because it does not exist until the
call has ended. Showing an agent who is calling _while the phone rings_ needs
one of:

- a **Teams calling bot** registered in Azure Bot Service, using the Graph
  cloud communications APIs — a Teams app, its own approval, its own review; or
- **Direct Routing SBC events**, if an SBC is in the path and can emit them.

Recommendation: do not attempt this in the first phase. Deliver the timeline
first, confirm the number matching is accurate against real traffic, and treat
the screen pop as a decision taken afterwards with evidence.

### 3.4 Recording and transcription — out of scope until asked

Graph can notify on call recordings and transcripts, under separate permissions
(`CallRecordings.Read.All`, `CallTranscripts.Read.All`). These carry data
protection obligations that have nothing to do with the rest of this work:
lawful basis, notification to callers, retention, access control and deletion.
They are deliberately excluded here. If recording is wanted, it needs its own
assessment before a line of code.

## 4. ABC Cargo CRM — the decision that blocks it

Engage holds customers, companies, leads, quotations, bookings, tickets, calls
and an activity stream. If ABC Cargo's CRM holds the same, every shared record
needs one owner. Three workable patterns:

| Pattern                  | What it means                                                                                                          | Best when                                            |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| **CRM is master**        | CRM owns customers and commercial records; Engage owns conversations and tickets, and reads customer data from the CRM | The CRM is established and sales already works in it |
| **Engage is master**     | Engage owns everything; the CRM is retired or reduced to reporting                                                     | The CRM is thin, or is itself being replaced         |
| **Split by record type** | CRM owns company, credit and invoicing; Engage owns leads, conversations, tickets and calls                            | The CRM is really a finance or shipment system       |

**The split pattern is usually the right answer** when the other system is an
operational or accounting system rather than a true sales CRM, because it gives
each record exactly one owner without forcing a migration. But it cannot be
chosen without knowing what the CRM is.

Whichever is chosen, the same three things have to be settled: which system
mints the customer identity, how a customer is matched across both (phone
number in E.164 is the only identifier both systems reliably hold), and which
direction each field flows. Two-way synchronisation of the same field is the
one option to avoid — it produces conflicts that have no correct resolution.

## 5. What is needed before this can be built

| #   | Question                                                                  | Blocks                     |
| --- | ------------------------------------------------------------------------- | -------------------------- |
| 1   | What is "ABC Cargo CRM" — product name, or in-house? Does it have an API? | All CRM work               |
| 2   | Which system is master for customers? (§4)                                | All CRM work               |
| 3   | Is the UK system Teams Phone? Calling Plan or Direct Routing?             | Who to involve on failures |
| 4   | Is a screen pop required, or is the call timeline enough for now?         | Phase 2 scope              |
| 5   | Is call recording in scope? If so, it needs its own assessment first.     | §3.4                       |

## 6. Approvals that will be required

None of the below is covered by any approval currently held. Each needs its
own `APPROVE LIVE CHANGE`, with its own change note:

- Granting `CallRecords.Read.All` in the Microsoft Entra tenant. This is an
  application permission requiring admin consent, and it exposes organisation-wide
  calling metadata. Microsoft's own guidance is to grant it only to applications
  trusted to meet the organisation's data protection requirements.
- Creating the Graph change notification subscription.
- Any credential issued for the CRM.
- Any first write from Engage into the CRM, or from the CRM into Engage.

## 7. Suggested order

1. Settle questions 1–3 in §5.
2. Build the call record endpoint and the schema change, behind a flag, against
   a test tenant. No production permission granted yet.
3. Demonstrate the UK call timeline to Management alongside the WhatsApp demo.
4. Then take the CRM decision in §4 with the Head of IT, and write that
   integration's own design note.

Telephony before CRM, because telephony is additive and reversible — it writes
rows nobody else owns. The CRM integration touches records another system
already holds, and is the one with a wrong answer.
