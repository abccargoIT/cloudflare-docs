# WhatsApp Customer Communication Platform

**Architecture and Implementation Plan**

| Item           | Detail                                     |
| -------------- | ------------------------------------------ |
| Organisation   | ABC Cargo                                  |
| Prepared by    | ABC Cargo IT Department                    |
| Approver       | Head of IT                                 |
| Classification | ABC Cargo Official, internal               |
| Document date  | 2026-09-03                                 |
| Version        | 0.1 (draft for review)                     |
| Status         | Planning. No live system has been changed. |

---

## 1. Executive summary

ABC Cargo wants a customer communication capability on WhatsApp comparable to
commercial tools such as respond.io and Freshworks (Freshchat): a shared team
inbox for human agents during working hours, automated handling when the team
is offline, and business-initiated notifications such as shipment updates.

This is feasible with the official Meta WhatsApp Business Platform (Cloud
API), which is the same foundation the commercial tools use. ABC Cargo already
holds the main prerequisites: a Facebook-verified Meta business, a WhatsApp
Business Account (WABA), three regional phone numbers attached to it, one
number fully verified, and three approved display names.

The recommended approach is a small, owned platform on Cloudflare Workers:
a webhook receiver, a queue for reliable processing, one Durable Object per
customer thread, D1 for records, R2 for media, and a thin internal API for an
agent console. A starter code skeleton accompanies this plan. It compiles,
passes its unit tests, and has not been deployed.

Delivery is proposed in four phases. Phase 1 (webhook, one number, automated
replies, template notifications) is small and low risk. Phase 2 adds the
human agent inbox. Phases 3 and 4 add the remaining numbers, integrations with
shipment systems, and reporting.

Several steps are live changes to Meta or Cloudflare production assets and
each requires the Head of IT's explicit approval before execution. They are
listed in section 11.

## 2. Business requirement

- Customers must be able to reach ABC Cargo on WhatsApp on the regional
  number they know and receive a timely, professional response.
- During working hours, human agents must handle conversations from a shared
  inbox with clear ownership.
- Outside working hours, or when no agent is available, customers must receive
  an immediate automated acknowledgement that captures their shipment
  reference and sets expectations.
- ABC Cargo must be able to send proactive notifications (shipment status,
  pickup and delivery confirmations, document requests) using approved
  templates.
- All conversations must be recorded for service quality, audit and dispute
  handling.
- The solution must comply with Meta's platform rules so that the business
  numbers are not restricted or banned.

## 3. Scope

In scope:

- Integration with the Meta WhatsApp Business Platform (Cloud API) for the
  ABC Cargo WABA and its regional numbers.
- Inbound message receipt, storage, routing and automated first response.
- Outbound agent replies and template-based notifications.
- Data model, security controls, deployment and rollback procedures.
- A starter code skeleton (see section 7).

Out of scope for this version:

- Channels other than WhatsApp.
- The agent console user interface (planned in Phase 2; the internal API it
  will use is included).
- Reselling the platform to other companies (would require Meta Tech Provider
  or Solution Partner status).
- Marketing broadcast campaigns. These are technically possible with the same
  template mechanism but carry higher cost and quality-rating risk and should
  be a separate decision.

## 4. Environment

### 4.1 Meta assets (as reported by the Head of IT)

| Asset                     | Reported state                      | Note                                             |
| ------------------------- | ----------------------------------- | ------------------------------------------------ |
| Meta Business Portfolio   | Facebook business verification done | Prerequisite for production messaging limits     |
| WhatsApp Business Account | Exists                              | The container for numbers, templates and quality |
| Regional phone numbers    | Three connected                     | Region assignment to be confirmed                |
| Number verification       | One number verified                 | See finding F2                                   |
| Display names             | Three approved                      | Required before a number can message customers   |

These items are reported, not yet inspected by the IT Department in WhatsApp
Manager. Section 9 includes the verification steps.

### 4.2 Target platform

| Component      | Service                  | Purpose                                                    |
| -------------- | ------------------------ | ---------------------------------------------------------- |
| Compute        | Cloudflare Workers       | Webhook endpoint, internal API, queue consumer             |
| Reliability    | Cloudflare Queues        | Buffer and retry webhook events; dead-letter queue         |
| Thread state   | Durable Objects (SQLite) | One instance per customer thread; ordering and window rule |
| Records        | Cloudflare D1            | Contacts, conversations, messages, agents, audit log       |
| Media          | Cloudflare R2            | Inbound images and documents                               |
| Access control | Cloudflare Access        | Protects the agent console and internal API                |
| Optional       | Workers AI               | Intent classification and reply drafting (Phase 3)         |

A Cloudflare Workers Paid plan is required because Queues are not available on
the free plan. Confirm current plan limits and pricing on the Cloudflare
pricing pages before approval.

## 5. Findings

Each finding is marked as verified fact (F), reasonable inference (I), or
unverified (U).

- **F1. The official Cloud API is the only compliant route.** Tools that
  automate the WhatsApp Web or mobile app session violate Meta's terms and
  lead to number bans. They must not be used for ABC Cargo numbers.
- **F2. "Verified" has two meanings for a number (I).** Each number must
  (a) pass the one-time OTP ownership verification and (b) be registered for
  the Cloud API with a two-step verification PIN before it can send messages
  through the API. The report that one of three numbers is verified most
  likely means only one has completed both steps. This must be confirmed in
  WhatsApp Manager before planning the number rollout.
- **F3. Numbers currently used in the WhatsApp Business app need a decision
  (U).** If any regional number is in daily use on a phone with the WhatsApp
  Business app, moving it to the Cloud API changes how that phone can use it.
  Meta offers a coexistence mode for some onboarding paths, but its
  availability for a direct Cloud API integration must be verified with Meta's
  current documentation before any number is migrated. Chat history on the
  phone is not migrated to the API.
- **F4. The 24-hour customer service window governs the design.** After a
  customer's last message, free-form replies are allowed for 24 hours. Outside
  that window only approved template messages can be sent. The skeleton
  enforces this.
- **F5. Template messages are charged per message by category (utility,
  marketing, authentication).** Customer-initiated service conversations
  inside the window are free at the time of writing. Rates vary by
  destination country and change periodically. Verify on Meta's pricing page
  before budgeting.
- **F6. Messaging limits and quality rating apply per number.** New numbers
  start with a limited daily count of business-initiated conversations. Limits
  rise automatically with volume and good quality. High block or report rates
  reduce limits and can pause a number.
- **F7. Webhooks must be answered quickly and can be retried.** The design
  acknowledges within milliseconds and processes asynchronously. Duplicate
  deliveries are handled by de-duplicating on the WhatsApp message id.
- **F8. Media links from Meta are short-lived.** Inbound media must be
  downloaded promptly and stored by ABC Cargo. The skeleton copies media to R2
  on receipt.
- **F9. No existing WhatsApp integration content exists in the Cloudflare
  documentation repository used as this project's workspace.** The building
  blocks (Workers, Queues, Durable Objects, D1, R2, Access) are documented and
  were used as the reference for the design.

## 6. Architecture

### 6.1 Overview

```
Customer (WhatsApp)
      |
      v
Meta WhatsApp Cloud API  <----- outbound: text / template / mark-read / media
      |
      | webhook POST (X-Hub-Signature-256)
      v
Cloudflare Worker: /webhooks/whatsapp
   verify signature -> split payload -> enqueue -> 200 EVENT_RECEIVED
      |
      v
Cloudflare Queue (retries, dead-letter queue)
      |
      v
Queue consumer
   messages  -> Conversation Durable Object (per number + customer)
   statuses  -> D1 message status update
      |
      +-> D1 (contacts, conversations, messages, agents, audit)
      +-> R2 (media)
      +-> Auto-reply engine (offline / no agent online)
      +-> Meta API (mark as read, replies, templates)

Agent console (Phase 2)  --Cloudflare Access-->  Worker /api/*  -->  D1 + Durable Objects
Shipment systems (Phase 3) --------------------->  Worker /api/notifications/template
```

### 6.2 Component responsibilities

- **Webhook endpoint.** Handles Meta's verification handshake and signed
  deliveries. Rejects unsigned or badly signed requests with HTTP 401. Never
  processes inline; only enqueues.
- **Queue.** Isolates processing failures from Meta's delivery. Each queue
  message is one webhook change, so a failure for one thread does not block
  others. Failed messages retry with backoff and land in a dead-letter queue
  after the configured attempts.
- **Conversation Durable Object.** One instance per (business number,
  customer) pair. Serialises all work for that thread. Holds the service
  window expiry, assigned agent, status and last automated reply time. Applies
  the auto-reply decision exactly once per inbound message. Enforces the
  window rule on agent replies.
- **D1.** System of record for everything an agent console, report or audit
  needs. Schema in `src/db/migrations/0001_init.sql`.
- **R2.** Stores inbound media under a per-conversation key with the original
  content type.
- **Region configuration.** Maps each Meta phone number id to a region label,
  timezone, working days and hours, and default template language. Stored as
  a Worker variable so numbers can be added without a code change.
- **Internal API.** Bearer-key protected endpoints for listing and reading
  conversations, replying, assigning, changing status, sending templates and
  setting agent presence. Intended to sit behind Cloudflare Access.

### 6.3 Online and offline behaviour

| Situation                                         | Behaviour                                                                                                               |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Inside working hours, an agent is online          | Message stored, marked read, appears in the inbox. No automated reply. Agent replies through the API.                   |
| Inside working hours, no agent online             | Automated reply "all agents busy", shipment reference extracted, conversation queued. Cooldown prevents repeat replies. |
| Outside working hours                             | Automated reply with regional working hours and reference acknowledgement. Conversation waits for the next shift.       |
| Customer replies after more than 24 hours silence | Free-form replies are blocked (HTTP 409). Agent must use an approved template to re-open the conversation.              |
| ABC Cargo office loses connectivity               | Meta and Cloudflare are unaffected. Messages are received, stored and auto-acknowledged. Agents catch up on return.     |
| Meta webhook delivery fails or is retried         | Meta retries; the platform de-duplicates by message id.                                                                 |
| Processing bug or outage in the consumer          | Events wait in the queue and retry; unrecoverable ones go to the dead-letter queue for manual replay.                   |

### 6.4 Data model

| Table            | Purpose                                                                |
| ---------------- | ---------------------------------------------------------------------- |
| `contacts`       | One row per customer WhatsApp id, profile name, region, opt-out flag   |
| `conversations`  | One row per number and customer: status, owner, window expiry, preview |
| `messages`       | Every inbound and outbound message with delivery status and media key  |
| `agents`         | Agent directory with region and role                                   |
| `agent_presence` | Online, away or offline, used by the auto-reply decision               |
| `template_sends` | Record of every business-initiated template message                    |
| `audit_log`      | Assignment, status changes, automated replies and window closures      |

## 7. Starter code skeleton

Location: `abc-cargo/whatsapp-platform/` on branch
`claude/whatsapp-customer-communication-bg7m78`.

State of the skeleton at the time of this document:

| Check                           | Result        |
| ------------------------------- | ------------- |
| TypeScript type check           | Passes        |
| Unit tests (Node test runner)   | 20 tests pass |
| ESLint                          | Passes        |
| Prettier formatting             | Passes        |
| Deployed anywhere               | No            |
| Connected to the ABC Cargo WABA | No            |

Placeholders that must be replaced before any deployment:

- `REGION_NUMBERS` in `wrangler.jsonc`: phone number ids, display numbers,
  region labels, timezones and working hours.
- `database_id` in `wrangler.jsonc` after the D1 database is created.
- The tracking-number pattern in `src/auto-reply.ts`, which is a generic
  placeholder and must match the ABC Cargo AWB or tracking format.
- Automated reply wording, and Arabic or other language variants per region.

## 8. Implementation plan

### Phase 0. Verification and preparation (read-only)

1. In WhatsApp Manager, record for each number: phone number id, display
   name status, OTP verification status, Cloud API registration status,
   quality rating and messaging limit.
2. Confirm whether each number is currently active in the WhatsApp Business
   app on a phone (finding F3) and decide migration or coexistence per number.
3. Confirm the Meta App that will own the webhook, or note that one must be
   created (live change).
4. Confirm regional working hours, days and timezones with operations.
5. Confirm the ABC Cargo tracking-number format and public tracking URL.
6. Draft the first utility templates (shipment status, delivery confirmation,
   document request, re-engagement) for Meta approval.
7. Confirm the Cloudflare account and plan to be used.

### Phase 1. Foundation on one number

1. Create the Cloudflare resources: Worker, Queue and dead-letter queue, D1
   database, R2 bucket. Apply the D1 migration.
2. Set Worker secrets. Deploy the Worker on a dedicated hostname.
3. In the Meta App, configure the webhook callback URL and verify token,
   subscribe to the `messages` field, and subscribe the App to the WABA.
4. Submit the templates from Phase 0 for approval.
5. Test with the verified number and a small set of internal test phones:
   inbound text and media, automated replies inside and outside hours,
   template send, delivery status updates, signature rejection.
6. Go-live on the first number with automated replies and notifications only.

### Phase 2. Human agent inbox

1. Build the agent console (web application) on the internal API: inbox by
   region, conversation view, reply, assign, resolve, presence.
2. Protect the console and `/api/*` with Cloudflare Access using the ABC
   Cargo identity provider. Define agent, supervisor and admin roles.
3. Add real-time inbox updates (WebSocket from the Durable Object or polling).
4. Pilot with one regional team. Collect feedback on wording, hours and
   assignment rules.

### Phase 3. Remaining numbers and integrations

1. Complete verification and Cloud API registration for the remaining
   numbers (live change per number). Add each to `REGION_NUMBERS`.
2. Integrate shipment systems: trigger utility templates on status events.
3. Optional Workers AI step for intent classification and suggested replies,
   presented to the agent for approval rather than sent automatically.

### Phase 4. Reporting and hardening

1. Reports: response times, volumes per region, template usage and cost,
   quality rating trend.
2. Retention policy for messages and media, and customer opt-out handling.
3. Dead-letter queue monitoring and alerting, error-rate alerts, and a
   documented replay procedure.
4. Runbook and handover to the support team.

## 9. Testing plan

- **Unit tests** (included): signature verification, region configuration
  validation, timezone-aware business hours, webhook payload splitting,
  automated reply content.
- **Local integration** with Wrangler: D1 migration, queue consumer, Durable
  Object behaviour with simulated webhook payloads.
- **Meta sandbox testing**: use the Meta test number and internal phones
  before any customer-facing number is connected.
- **Acceptance tests on the first number** (Phase 1, step 5), each with an
  expected result recorded as evidence:
  - Webhook verification handshake succeeds only with the correct token.
  - POST without a valid signature returns 401 and is not processed.
  - Inbound text creates contact, conversation and message rows.
  - Inbound image is stored in R2 and linked to the message.
  - Outside hours: exactly one automated reply, then none within the cooldown.
  - Inside hours with an agent online: no automated reply.
  - Agent reply inside the window succeeds; after the window returns 409.
  - Template send succeeds and its delivery status is updated from webhooks.
  - Duplicate webhook delivery does not create a second message row.

## 10. Rollback

- **Worker**: redeploy the previous version from the Cloudflare dashboard or
  with the Wrangler rollback command. Versions are retained by Cloudflare.
- **Meta webhook**: remove or change the callback URL in the Meta App to stop
  deliveries. Meta then retries for a limited period and drops events; this is
  acceptable during a controlled rollback because customers still receive
  their own sent-message confirmations.
- **Numbers**: a number registered for the Cloud API can be deregistered. If a
  number was migrated from the WhatsApp Business app, returning it to the app
  is possible but chat history that was on the phone is not restored by Meta.
  This is the main irreversible aspect and is why finding F3 requires a
  decision before migration.
- **Data**: D1 supports point-in-time recovery on paid plans. Export D1 and
  R2 before any schema migration after go-live.

## 11. Live-change approval points

Each of the following is a live change and requires the phrase
"APPROVE LIVE CHANGE" from the Head of IT after review of the proposed
change, affected assets, expected result, risk, rollback and verification.

1. Creating or modifying the Meta App, webhook configuration and WABA
   subscription.
2. Creating System Users, tokens and permissions in Meta Business settings.
3. OTP verification, Cloud API registration, or migration of any regional
   number.
4. Submitting message templates for approval.
5. Creating Cloudflare resources and setting Worker secrets.
6. Deploying the Worker to any hostname reachable by Meta.
7. Configuring Cloudflare Access policies.
8. Any change to the tracking-number pattern or automated reply wording after
   go-live.
9. Sending any message to a real customer number.

## 12. Security

- Meta System User token, App secret, verify token and internal API key are
  stored only as Worker secrets. They never appear in source, logs, error
  messages or this document.
- Every webhook delivery is verified with HMAC-SHA256 over the raw body using
  a constant-time comparison.
- The internal API requires a bearer key and must additionally sit behind
  Cloudflare Access with the corporate identity provider. The key is a second
  factor, not the only control.
- Customer phone numbers, names and message content are personal data. Access
  is limited to the support team; the audit log records agent actions.
- Retention: define a period for messages and media in Phase 4 and enforce it
  with scheduled deletion.
- Opt-out: customers who ask to stop receiving notifications are flagged in
  `contacts` and must be excluded from template sends.
- Least privilege on the Meta System User: only the WhatsApp messaging and
  management permissions, scoped to the ABC Cargo WABA.

## 13. Risk

| Risk                                                 | Likelihood | Impact | Mitigation                                                           |
| ---------------------------------------------------- | ---------- | ------ | -------------------------------------------------------------------- |
| Number currently on the app loses phone chat history | Medium     | High   | Decide per number in Phase 0; export history from the phone first    |
| Template rejected or delayed by Meta                 | Medium     | Medium | Submit early; keep wording transactional; avoid promotional language |
| Quality rating drops from unwanted notifications     | Low        | High   | Only utility templates tied to real shipment events; honour opt-out  |
| Automated reply repeats or misfires                  | Low        | Medium | Cooldown, Durable Object serialisation, acceptance tests             |
| Token expiry or revocation stops messaging           | Low        | High   | Use a permanent System User token; alert on 401 responses from Meta  |
| Webhook backlog after an outage                      | Low        | Medium | Queue with retries and dead-letter queue; replay procedure           |
| Agent console built without access control           | Low        | High   | Cloudflare Access is a Phase 2 exit criterion                        |

## 14. Business and technical impact

- Customers receive an immediate acknowledgement at any hour and consistent
  service across regions.
- Agents work from one inbox per region with clear ownership and a record of
  every conversation.
- Operations can send shipment notifications automatically, reducing inbound
  "where is my shipment" traffic.
- IT owns the platform and its data, avoiding per-seat subscription costs and
  vendor lock-in, at the cost of building and maintaining the agent console.
- Running costs are Cloudflare plan and usage charges plus Meta per-message
  charges for template messages. Both must be confirmed against current price
  lists before approval.

## 14a. Change of direction: replacing Freshworks for WhatsApp

Recorded 2026-09-05, on the Head of IT's instruction. This section supersedes the
build-versus-buy position taken earlier in this plan.

### Position

ABC Cargo runs Freshworks today (Freshdesk with Freshchat) with roughly 40 active
users, roles already separated by region, and a large conversation history. The
decision is **not** to connect WhatsApp to Freshworks. It is to build ABC Cargo's own
customer communication platform and move the three WhatsApp numbers onto it.

The scope therefore widens from an integration layer to a product in its own right,
benchmarked against the Freshdesk and Freshchat feature surface and the respond.io
working model. The prototype at `demo/platform.html` shows the intended shape:
shared inbox, contacts, broadcasts, automations, reports and an admin surface.

### The constraint that governs the move

A WhatsApp phone number can be connected to **one** platform at a time. There is no
period in which both Freshworks and the new platform receive messages on the same
number. Each number is a discrete cutover with a before and an after.

### What moves and what does not

| Item                                        | Moves to the new platform | Note                                     |
| ------------------------------------------- | ------------------------- | ---------------------------------------- |
| The phone numbers themselves                | Yes                       | The WABA is ABC Cargo's own              |
| Approved message templates                  | Yes                       | Re-approval is not normally required     |
| Messaging limits and quality rating         | Yes                       | Tied to the number, not the platform     |
| Green tick, if held                         | Yes                       | Tied to the business                     |
| **Conversation history held in Freshworks** | **No**                    | Stays in Freshworks                      |
| **Contact records held in Freshworks**      | **No**                    | Must be exported first                   |
| Canned responses, SLA policies, automations | No                        | Rebuilt in the new platform              |
| Reporting history                           | No                        | Export before the number is disconnected |

### Pre-cutover requirements

These must be complete before the first number is disconnected, because some are
irreversible once access to the WhatsApp channel in Freshworks is removed.

1. Export contacts, conversation history and reporting for the WhatsApp channel from
   Freshworks, and verify the exports open and are complete.
2. Record the current per-number quality rating and messaging limit, so any change
   after the move is measurable.
3. List the approved templates and confirm each is present on the WABA.
4. Confirm which Meta App will own the webhook after the move, and that it is
   subscribed to the ABC Cargo WABA.
5. Agree what happens to Freshworks: whether it continues for email and ticketing, or
   is retired entirely. This affects licence cost and the agent experience, and is a
   commercial decision, not a technical one.

### Sequenced cutover

Move one number at a time, lowest volume first, so a problem affects the smallest
group of customers. Suggested order: Region 3, then Region 2, then Dubai.

For each number: freeze outbound campaigns, export, disconnect from Freshworks,
connect to the new platform, verify inbound and outbound on internal test phones,
then release to the regional team. Keep the previous number live until the current
one is verified.

### Honest assessment of effort

Reaching feature parity with what Freshworks gives ABC Cargo today is a product
build, not a configuration exercise. Phase 1 and 2 in section 8 deliver a working
inbox for one number. Matching the wider surface — canned responses, CSAT, custom
fields, SSO, reporting, exports, audit — is a programme measured in months, and it
carries ongoing maintenance that a subscription currently absorbs.

That is a legitimate trade for data ownership, cargo-system integration and removal of
per-seat cost, and it is the Head of IT's decision to make. It is recorded here so the
cost side is visible alongside the benefit, and so nobody is surprised later.

### Risk introduced by this decision

| Risk                                                 | Impact | Mitigation                                                                            |
| ---------------------------------------------------- | ------ | ------------------------------------------------------------------------------------- |
| Agents lose familiar tooling mid-shift               | High   | Cut over per region, train before each, keep the previous number live until verified  |
| Historic conversations become unreachable            | High   | Export before disconnecting; keep Freshworks read-only for a defined retention period |
| Feature gap at go-live against what agents use today | Medium | Agree the minimum acceptable feature set with supervisors before the first cutover    |
| Single team owns the whole platform                  | Medium | Document and hand over properly; avoid one-person dependency                          |

## 15. Approval

| Role       | Name                   | Decision | Date |
| ---------- | ---------------------- | -------- | ---- |
| Head of IT | Hakkeem Mohammed Kutty |          |      |

Approval of this document authorises Phase 0 (read-only verification) only.
Each live change in section 11 requires its own approval.

## 16. Status

Draft for review. Code skeleton prepared and validated locally. No Meta or
Cloudflare production asset has been created, modified or connected.

## 17. Next action

1. Head of IT reviews this plan and the skeleton.
2. IT Department completes Phase 0 in WhatsApp Manager and returns the
   per-number status table and the decision on finding F3.
3. Operations confirms regional hours, tracking format and template wording.
4. On approval, Phase 1 proceeds with the verified number.
