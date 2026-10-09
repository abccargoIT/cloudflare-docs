# Review — "ABC Cargo Engage" design package

**Status:** Review only. Nothing in the build was changed as a result.
**Reviewed by:** ABC Cargo IT Department
**Date:** 8 October 2026

---

## 1. Executive summary

A design package was supplied: a clickable prototype, a process-flow diagram, a
nine-slide management presentation, hi-fi screen designs, wireframes, brand
assets, plus a separate concept page and a PDF.

It is a good piece of work and it is broader than the build in exactly the
places the build is thin — bots, setup, roles, team chat, dashboard. It should
drive the roadmap.

**One thing must be corrected before it goes in front of Management.** The
package states that the UK and KSA numbers are "Not yet connected". They are
connected. All three regional numbers are live in Freshchat today, each fronted
by its own 24-hour bot. This is recorded in
`docs/current-state-and-regional-roadmap.md` §44 and §194, taken from the live
Freshworks tenant.

Presented as drawn, the package tells Management that two of the three regions
are greenfield builds. They are production migrations. That understates the
work, understates the risk, and hides the single largest blocker on this
project — the three bot conversation flows that have still not been exported.

## 2. What was reviewed

| File                               | Read in full                             |
| ---------------------------------- | ---------------------------------------- |
| `README.md`                        | Yes                                      |
| `Engage_ABC_Cargo_Consept.html`    | Yes                                      |
| `Engage_ABC_Cargo_Consept_.md`     | Yes                                      |
| `1 - Application (open this).html` | Searched, not read line by line (454 KB) |
| `2 - End-to-end Process Flow.html` | Searched only                            |
| `3 - Management Presentation.html` | Searched only                            |
| `4 - Screen Designs.html`          | Searched only                            |
| `5 - Wireframes.html`              | Searched only                            |
| `Exgage_ABC_Cargo.pdf`             | **Not read** — see below                 |

**The PDF could not be read.** It carries no font objects, so it is an
image-only document, and the embedded images that extracted were blank page
backgrounds. If it contains anything that is not in the HTML files, it has not
been taken into account here. Supplying it as HTML or as plain images would fix
that.

## 3. The correction that matters

| Claim in the package          | Established position                                   | Source                             |
| ----------------------------- | ------------------------------------------------------ | ---------------------------------- |
| UAE "Live in Freshchat today" | Correct                                                | Channels screen                    |
| UK "Not yet connected"        | **Wrong.** Live in Freshchat, with its own 24-hour bot | Channels screen, all three enabled |
| KSA "Not yet connected"       | **Wrong.** Live in Freshchat, with its own 24-hour bot | Channels screen, all three enabled |

The consequence is not cosmetic. If two regions are new, the project is a build
and a launch. If all three are live, the project is three production migrations,
each needing its own cutover window, its own bot flow export, and its own
rollback. The second is what is true, and it is what the roadmap is built on.

**The phone numbers are also placeholders** — `+971 4 501 8800`,
`+44 20 0000 0000`, `+966 11 000 0000`. The real numbers are `+971800916`,
`+966548454866` and `+447388800000`. Harmless in a wireframe, misleading in a
management slide.

## 4. The package's modules, and where the build has got to

This section was written as "what the package has that the build does not",
when that was true of all of it. It is now a build-status table, and the
heading has been corrected to say so rather than left to mislead whoever reads
it next. The design package remains the UI and roadmap specification; the
"build today" column is kept current as modules land.

| Module                 | Design intent                                                                                    | Build today                                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| **Login and roles**    | Agent / Team lead / Master admin, multi-team users, agents see only their own conversations      | Built. Cloudflare Access in front of `/api/*`, roles and multi-team users enforced in `src/auth/`                |
| **Bots**               | Flows per number, AI agent templates, test preview                                               | Runtime, validator and preview built; the three live flow exports are still the blocker. See `bots-and-flows.md` |
| **Setup**              | Organisation, channels, teams, security, SLA policies, integrations, API keys, backup, audit log | Built: people, teams and the access log in `src/admin/`. Channels and keys still config-file only                |
| **Team chat**          | Internal messages between agents across regions                                                  | Built. `src/chat/` — membership-governed, crosses regions on purpose                                             |
| **Dashboard**          | Greeting, live KPIs, volume by region                                                            | Built. `src/dashboard/` — queue state and attention list, in each region's own hours. See `dashboard.md`         |
| **Reports**            | Charts plus a report library                                                                     | Regional summary API built; no charts and no report library                                                      |
| **Broadcasts**         | Template broadcasts with audience, delivered, read, replied                                      | Built, and switched off by default. Frozen audience, two-person approval, paced sending. See `broadcasts.md`     |
| **Contacts directory** | Searchable list, 360 view, notes                                                                 | Built. Directory and lifecycle board in `src/crm/contacts.ts`; no UI yet                                         |
| **Composer**           | Internal note, voice note, file, location                                                        | Built. `src/composer/` — notes in their own table so the send path cannot reach them. See `composer.md`          |
| **Email and phone**    | Named as channels alongside WhatsApp                                                             | WhatsApp only; telephony read-only via Graph                                                                     |
| **ERP lookup**         | Bot queries shipment status from the ERP                                                         | Open decision — shipment system API availability                                                                 |
| **Personalisation**    | Light/dark theme, accent colour                                                                  | Demo follows the system theme                                                                                    |

## 5. What the build has that the package does not

Worth stating so it is not lost when the design is used as the specification.

- **Quotations** as a record with their own status machine.
- **Bookings and shipment milestones**, forward-only, with stall detection
  raising a delay ticket before the customer chases.
- **Service targets counted in business minutes** on each region's own
  calendar, rather than wall-clock.
- **Rule-based intent recognition** in English and Arabic, with claims weighted
  above everything else.
- **Reference formats** that survive being read aloud and written down.
- **The 24-hour service window** enforced in the conversation itself, not drawn.
- **Signature verification** on every inbound webhook.

## 6. Conflicts to settle

| #   | Conflict                                                                                                 | Why it matters                                                                    |
| --- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| 1   | ~~Lifecycle stages~~ **Resolved, §9.** They are not two models of one thing                              | —                                                                                 |
| 2   | ~~"Payment" as a lifecycle stage~~ **Resolved, §9.3**                                                    | —                                                                                 |
| 3   | ~~Agents see only their own conversations~~ **Built and enforced** — see `identity-and-access-design.md` | —                                                                                 |
| 4   | **Bots as a module inside Engage**                                                                       | The three existing bot flows are in Freshworks. Rebuild from export, or redesign? |
| 5   | **Email and phone as channels**                                                                          | Widens the platform well beyond WhatsApp. Phase, or scope?                        |

## 7. Recommendation

1. **Correct the connection status and the phone numbers before Management
   sees the package.** One edit; without it the briefing misstates the project.
2. Adopt the package as the **UI and roadmap specification**, and keep the
   build's domain rules as the **behaviour specification**. They are
   complementary: the package is strong on what an agent sees, the build is
   strong on what the platform decides.
3. Settle the five conflicts in §6, starting with the lifecycle, because every
   screen that shows a stage depends on it.
4. Do not widen the current scope to email, phone channels or team chat yet.
   The cutover is the critical path and none of those shorten it.

## 8. What was not done

No code, schema or screen was changed on the strength of this package. The
conflicts in §6 are decisions for the Head of IT, and taking them silently in
code would bury them.

---

## 9. Lifecycle — resolved, 8 October 2026

Asked to take the most advanced design rather than choose between the two.

### 9.1 They are not two answers to one question

That was the assumption worth discarding. Picking a winner was the obvious move
and the wrong one.

|                         | **Pipeline**     | **Lifecycle**                       |
| ----------------------- | ---------------- | ----------------------------------- |
| Describes               | a _deal_         | a _relationship_                    |
| How many per customer   | several at once  | exactly one                         |
| Does it end?            | yes, won or lost | no                                  |
| Who means it by "stage" | a sales board    | a contact list, a segment, a report |

A long-standing trade account with a fresh enquiry is a Customer **and** has a
new lead. One field cannot say both, and forcing it to loses information the
business actually uses.

So both exist. The pipeline is unchanged — `new → qualified → quoted →
negotiating → won/lost`, with its transition guards.

### 9.2 The lifecycle is derived, not stored

| Stage             | Means                            | Covers the package's |
| ----------------- | -------------------------------- | -------------------- |
| `prospect`        | known, no interest shown         | —                    |
| `lead`            | an open enquiry, untouched       | New Lead             |
| `engaged`         | an enquiry actively being worked | **Hot Lead**         |
| `committed`       | won on paper, nothing shipped    | Payment              |
| `customer`        | one shipment booked              | Customer             |
| `repeat_customer` | more than one                    | —                    |
| `dormant`         | was a customer, has gone quiet   | —                    |
| `lapsed`          | only ever enquired, and lost     | —                    |

Nothing here is set by hand. Every value is computed from leads, quotations,
bookings and last contact — facts the platform already records — so it cannot
go stale, and a wrong answer is a wrong rule rather than somebody's forgotten
click. The one thing reliably true of a hand-maintained relationship stage is
that it is out of date.

**"Hot Lead" becomes observed rather than declared.** Alongside the stage there
is a temperature from 0 to 100, computed from how far the enquiry has
travelled, whether a quotation is in the customer's hands, how recently anyone
touched it, and whether they have shipped before. It ranks a queue; it is not a
forecast, and the code says so.

### 9.3 Why "Payment" is not a stage

A payment stage implies finance data, and the CRM has no finance part. Rather
than drop the idea, what it was reaching for is kept: `committed` is _won on
paper, nothing shipped yet_ — the list somebody should be chasing. Neither
"lead" nor "customer" describes it, and conflating it with either hides the
chase.

If a finance system is connected later, a settled or unsettled reading can sit
on top of `committed` without the stage list changing.

### 9.4 Two additions the package did not ask for

`repeat_customer` and `dormant`. The first is the difference between a sale and
a relationship. The second is how a quiet account surfaces before somebody
notices a year later. Both are free, because they are derived.

### 9.5 Built

`src/crm/customer-lifecycle.ts`, with 15 tests covering the awkward cases:
shipping outranks an open enquiry, an open enquiry keeps a quiet customer out
of dormancy, never-enquired differs from enquired-and-lost, and an unparseable
date neither throws nor flatters. `GET /api/customers/:id` now returns the
stage, its label and the temperature alongside the record.
