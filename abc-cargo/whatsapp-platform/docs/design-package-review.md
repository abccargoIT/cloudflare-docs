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

## 4. What the package has that the build does not

This is the useful half, and it is substantial. None of it is built today.

| Module                 | Design intent                                                                                    | Build today                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| **Login and roles**    | Agent / Team lead / Master admin, multi-team users, agents see only their own conversations      | None. The plan assumed Cloudflare Access in front of `/api/*`   |
| **Bots**               | Flows per number, AI agent templates, test preview                                               | None — and this is the blocking export                          |
| **Setup**              | Organisation, channels, teams, security, SLA policies, integrations, API keys, backup, audit log | Partly: SLA and regions in config, audit in the activity stream |
| **Team chat**          | Internal messages between agents across regions                                                  | None                                                            |
| **Dashboard**          | Greeting, live KPIs, volume by region                                                            | None                                                            |
| **Reports**            | Charts plus a report library                                                                     | None                                                            |
| **Broadcasts**         | Template broadcasts with audience, delivered, read, replied                                      | None                                                            |
| **Contacts directory** | Searchable list, 360 view, notes                                                                 | Customer 360 exists in the API; no directory UI                 |
| **Composer**           | Internal note, voice note, file, location                                                        | Text and template only                                          |
| **Email and phone**    | Named as channels alongside WhatsApp                                                             | WhatsApp only; telephony read-only via Graph                    |
| **ERP lookup**         | Bot queries shipment status from the ERP                                                         | Open decision — shipment system API availability                |
| **Personalisation**    | Light/dark theme, accent colour                                                                  | Demo follows the system theme                                   |

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

| #   | Conflict                                                                                                                          | Why it matters                                                                                   |
| --- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 1   | **Lifecycle stages.** Package: New Lead → Hot Lead → Payment → Customer. Build: new → qualified → quoted → negotiating → won/lost | Two different models of the same thing. One has to win, and the transition rules follow from it  |
| 2   | **"Payment" as a lifecycle stage** versus "the CRM has no finance part"                                                           | A payment stage implies finance data. Which is it?                                               |
| 3   | **Agents see only their own conversations**                                                                                       | A visibility rule, not a screen. It has to be enforced in the API, and nothing enforces it today |
| 4   | **Bots as a module inside Engage**                                                                                                | The three existing bot flows are in Freshworks. Rebuild from export, or redesign?                |
| 5   | **Email and phone as channels**                                                                                                   | Widens the platform well beyond WhatsApp. Phase, or scope?                                       |

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
