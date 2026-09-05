# Current State and Regional Roadmap

**ABC Cargo WhatsApp Customer Platform**

| Item           | Detail                                                           |
| -------------- | ---------------------------------------------------------------- |
| Organisation   | ABC Cargo                                                        |
| Prepared by    | ABC Cargo IT Department                                          |
| Approver       | Head of IT                                                       |
| Classification | ABC Cargo Official, internal                                     |
| Document date  | 2026-09-05                                                       |
| Version        | 0.1 (draft for review)                                           |
| Status         | Baseline captured from screenshots. No live system was accessed. |

---

## 1. How this document was compiled

The IT Department has **no API or connector access to the ABC Cargo Freshworks
tenant** from this workstream. Nothing in this document was read from Freshworks
directly.

Everything in section 3 was transcribed from screenshots supplied by the Head of
IT on 2026-09-03 and 2026-09-05. It is therefore accurate for what those screens
showed at that moment, and silent on everything they did not show. Section 5 lists
exactly what still has to be exported to complete the picture.

Where a value is inferred rather than seen, it is marked **(inferred)**.

## 2. The finding that changes the plan

An assignment rule visible in the Chat Assignment Rules screen filters on:

```txt
message text        contains   "where is my"
AND  message sent from  equals   WHATSAPP_+971…
```

A WhatsApp source of that form only exists once a number is connected as a channel.
**The UAE WhatsApp number is already live inside Freshchat.** Moving to ABC Cargo's
own platform is therefore a migration of a running service, with customers actively
messaging it, and not a greenfield connection.

This raises the stakes of the cutover sequencing in section 14a of the
implementation plan, and makes the pre-cutover export in section 5 mandatory rather
than advisable.

## 3. Configuration captured

### 3.1 Groups and auto-assignment

From the IntelliAssign screen. IntelliAssign is **enabled** at account level, but
switched on for only two of the nine groups.

| Group                     | IntelliAssign | Reassign when member inactive | Region   |
| ------------------------- | ------------- | ----------------------------- | -------- |
| International Escalations | Off           | No                            | Shared   |
| Escalations Department    | Off           | Yes                           | Shared   |
| HR Department             | Off           | Yes                           | Internal |
| UK Customer Support       | **On**        | Yes                           | UK       |
| UK After Sale Support     | Off           | No                            | UK       |
| UAE Domestics Sales       | Off           | No                            | UAE      |
| UAE Shipment Tracking     | Off           | No                            | UAE      |
| UAE Sales Team            | **On**        | Yes                           | UAE      |
| KSA Sales Team            | Off           | No                            | KSA      |

Observations worth carrying into the new platform:

- Regional separation already exists in the group structure, and the new platform
  must preserve it rather than invent a different shape.
- Only UK Customer Support and UAE Sales Team auto-assign. Seven groups rely on
  agents picking work up manually, which is the most likely source of slow first
  responses. The new platform should make automatic assignment the default and
  manual pickup the exception.
- HR Department sitting in the same tool as customer support is a scoping question:
  internal HR conversations should not migrate to a customer WhatsApp platform.

### 3.2 IntelliAssign parameters

| Setting                                             | Current value |
| --------------------------------------------------- | ------------- |
| Member marked inactive after idle                   | 700 minutes   |
| Conversation marked inactive if customer silent for | 10 minutes    |
| Reassign to the same member if reopened             | On            |
| Reassign window for the same member                 | 5 minutes     |
| Active conversations per member                     | 300           |
| Auto-resolve when conversation becomes inactive     | Off           |
| Load levels configured                              | None          |

Two of these deserve review rather than straight migration:

- **700 minutes idle** is over eleven hours. A member effectively never goes
  inactive within a shift, so work continues to be routed to people who have gone
  home. A value close to the shift length, or presence-driven status, is more honest.
- **300 active conversations per member** is not a working limit, it is effectively
  unlimited. It means load balancing has no ceiling to balance against.

Neither is a fault to fix in Freshworks now. Both are decisions to make deliberately
when the equivalent settings are configured in the new platform.

### 3.3 Conversation properties

| Property                | Type                 | Origin  |
| ----------------------- | -------------------- | ------- |
| Group                   | Dropdown             | Default |
| Agent                   | Dropdown             | Default |
| Skill                   | Dropdown             | Default |
| Status                  | Dropdown             | Default |
| Priority                | Dropdown             | Default |
| Business Classification | Multiselect dropdown | Custom  |

`Business Classification` is the only custom property visible. Its permitted values
were not shown and are needed (section 5), because they encode how ABC Cargo
currently segments conversations and will map to labels in the new platform.

Field types available for future properties: single line text, multi line text,
number, decimal, date, dropdown, dependent field, checkbox, multiselect dropdown.
The new platform's contact and conversation field model should cover the same set.

### 3.4 Assignment rules

Three rules are present, all named for WhatsApp UAE tracking, all assigning to
**TRACKING UPDATES**, and all currently enabled. One is named
`WhatsApp UAE - Tracking (where is my) (DRAFT-DO NOT ACTIVATE)` while its status
toggle reads enabled, which is a discrepancy to check before anything is copied.

Rule shape, from the one rule opened:

| Element     | Value                                       |
| ----------- | ------------------------------------------- |
| Match       | All of the conditions                       |
| Condition 1 | `message text` contains `where is my`       |
| Condition 2 | `message sent from` equals `WHATSAPP_+971…` |
| Action      | Assign to agent `TRACKING UPDATES`          |

This is exactly the intent-plus-source routing the new platform models in its
automation rules, so the pattern carries over directly. The full text of all three
rules is needed (section 5).

### 3.5 Roles

Sixteen roles, with user counts where shown:

| Role                  | Users | Scope  |
| --------------------- | ----- | ------ |
| UAE Sales Agent       | 13    | UAE    |
| UK Support Agent      | 12    | UK     |
| Account Admin         | 4     | Global |
| KSA Sales Agent       | 3     | KSA    |
| UK Supervisor         | 3     | UK     |
| Manager               | 2     | Global |
| UK Manager            | 2     | UK     |
| IT Freshworks Support | 1     | Global |
| Support Agent         | 1     | Global |
| Team Leader           | 1     | Global |
| Test                  | 1     | —      |
| Administrator         | 0     | Global |
| Ticket Support Agent  | 0     | Global |
| Supervisor            | 0     | Global |
| UAE Supervisor        | 0     | UAE    |
| KSA Supervisor        | 0     | KSA    |

Six roles carry no users. `Test` should not migrate. The unused supervisor roles for
UAE and KSA suggest the supervisor tier was designed but never staffed, which is a
question for operations before the new platform's role model is fixed.

### 3.6 Shared views

| View                        | Volume shown |
| --------------------------- | ------------ |
| UK Open Conversations       | 2K+          |
| Open Conversation           | 1K+          |
| UAE Open Conversations      | 650          |
| UAE Unassigned Conversation | 10           |
| KSA Open Conversation       | 9            |

The volume split is roughly UK ≫ UAE ≫ KSA. Cutover order should follow the
reverse, so the smallest population is exposed to the first migration.

### 3.7 Scale

- 40 active users, 2 pages of user records
- 362K+ resolved conversations, 26K+ unresolved
- Channels configured in Freshdesk: Portals, Email, Widgets, Facebook, Phone,
  Freshchat, Feedback Form, WhatsApp

## 4. The regional model for the new platform

Each region is a separate operating unit. The platform must treat region as a
first-class dimension rather than a filter applied afterwards.

| Dimension        | Separated per region | Notes                                                          |
| ---------------- | -------------------- | -------------------------------------------------------------- |
| WhatsApp number  | Yes                  | One number per region, each its own Meta phone number id       |
| Business hours   | Yes                  | Different working days and hours, all Gulf-adjacent            |
| Groups           | Yes                  | Existing group structure already regional, preserve it         |
| Agents and roles | Yes                  | Agent sees only their region unless explicitly cross-region    |
| Assignment rules | Yes                  | Rules scoped to a number, as the current UAE rules already are |
| SLA policies     | Yes                  | Separate targets per region, measured against regional hours   |
| Auto-reply text  | Yes                  | Regional hours and language quoted correctly                   |
| Templates        | Shared, per-language | One WABA holds them; language varies by region                 |
| Contacts         | Shared               | One customer may ship from more than one region                |
| Reporting        | Both                 | Per region for supervisors, consolidated for management        |
| Escalation       | Shared               | International Escalations already spans regions                |

The two shared dimensions matter. A customer is a customer of ABC Cargo, not of a
region, so the contact record is global while the conversation is regional.
Escalations already cross regions today and must continue to.

### 4.1 SLA model

SLA must be measured against the region's own business hours, not the clock. A
15-minute first response target means fifteen working minutes, so a message arriving
after closing starts its clock at opening.

Proposed shape, to be confirmed against the current Freshworks SLA policies once
exported:

| Region | First response | Next response | Resolution  | Measured against |
| ------ | -------------- | ------------- | ----------- | ---------------- |
| UAE    | 15 min         | 30 min        | 8 working h | UAE hours        |
| UK     | 15 min         | 30 min        | 8 working h | UK hours         |
| KSA    | 30 min         | 60 min        | 1 working d | KSA hours        |

These are placeholders. The real targets are in the Freshworks SLA Policies screen
and must replace them.

## 5. What must still be exported

The IT Department cannot read the tenant, so these must be exported or captured by
someone with admin access. Items marked **blocking** stop the roadmap from being
finalised; the rest can follow.

### Blocking

1. **SLA policies** — every policy, its targets, which groups and channels it applies
   to, and its escalation steps.
2. **Business hours** — each calendar, its working days, hours, timezone and holiday
   list, per region.
3. **All chat assignment rules** — full conditions and actions, in execution order,
   not only the three WhatsApp UAE rules.
4. **`Business Classification` values** — the full permitted value list.
5. **WhatsApp channel configuration** — which numbers are connected, their phone
   number ids, and their current quality rating and messaging limit.
6. **Message templates** — every approved template, its category, language and body.

### Needed before the first cutover

7. Contact export for WhatsApp contacts, with custom fields.
8. Conversation history export for the WhatsApp channel, per region.
9. Canned responses.
10. Group membership — which agent sits in which group.
11. Role permission detail for the six roles that carry users.
12. Reporting baseline — current volumes, first response and resolution times per
    region, so the new platform can be measured against the old one.

### Useful, not urgent

13. Freddy AI bot flows, if any are live on WhatsApp.
14. CSAT survey configuration and current scores.
15. Ticket forms and ticket fields, if WhatsApp conversations convert to tickets.

## 6. Roadmap

Sequenced so that the smallest population is exposed first and each region is fully
proven before the next begins.

### Phase 0 — Baseline and decisions (no live change)

Export everything in section 5. Confirm the tracking-number format, the fate of the
HR Department group, whether the unstaffed supervisor roles are real, and whether
Freshworks is retired or retained for email and ticketing.

### Phase 1 — Platform foundation

Build the core the demo already models: signed webhook receipt, queue, per-thread
state, 24-hour window enforcement, contacts, media capture, audit. Region, group,
business hours and SLA modelled as first-class configuration from the start, because
retrofitting a region dimension later is expensive.

### Phase 2 — KSA cutover

Nine open conversations and three agents. Smallest possible blast radius. Prove
inbound, outbound, assignment, SLA measurement and reporting against a live number
before touching a larger region.

### Phase 3 — UAE cutover

650 open conversations, 13 sales agents plus tracking and domestic sales groups.
The tracking assignment rules migrate here. This is where the shipment-system
integration earns its place, because "where is my shipment" is the dominant enquiry.

### Phase 4 — UK cutover

2K+ open conversations, 12 support agents, supervisors and managers. Largest region,
migrated last, on a platform already proven twice.

### Phase 5 — Consolidation

Cross-region reporting, escalation paths, retention and export policy, SSO, and the
decision on retiring or retaining Freshworks.

## 7. Open decisions for the Head of IT

1. Does the HR Department group migrate, or stay in Freshworks as an internal tool?
2. Are the unstaffed UAE Supervisor and KSA Supervisor roles intended to be filled?
3. Is Freshworks retired entirely, or retained for email, phone and ticketing?
4. What is the real ABC Cargo tracking reference format?
5. Which system holds shipment status, and does it expose an API?
6. Is the rule named `DRAFT-DO NOT ACTIVATE` supposed to be enabled?

## 8. Status

Draft. Compiled from supplied screenshots only. No Freshworks, Meta or Cloudflare
system was accessed, modified or connected in producing it.

## 9. Next action

1. Head of IT reviews the captured baseline in section 3 for accuracy.
2. Admin exports the six blocking items in section 5.
3. Section 4.1 SLA targets are replaced with the real policies.
4. Phase 0 closes and Phase 1 begins on approval.
