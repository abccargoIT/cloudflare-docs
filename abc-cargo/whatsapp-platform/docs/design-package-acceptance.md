# Engage — design package accepted as the specification

**Prepared by:** Head of IT, ABC Cargo IT Department
**Date:** 8 October 2026
**Status:** Accepted as the specification. Three contradictions inside the package must be settled before it goes to Management.

---

## 1. Executive summary

The package is accepted as the UI and roadmap specification. Most of what it
describes is built: roles and visibility, SLA clocks, the bot with a test
preview, the composer, team chat, contacts, setup, dashboard.

**Three things in the package contradict each other or the live business, and
one of them is serious.**

1. **The third region is wrong.** The process flow and the screen designs
   describe **Oman**. ABC Cargo's third live number is **UK**. The prototype
   gives it away: its `UK` region contains a contact whose id is `muscat`, a
   company called "Muscat Traders", and a `+968 … 7700` number. The package was
   authored around Oman and relabelled to UK incompletely.
2. **The palette is specified three different ways** — and none of them is the
   one I was told to use this afternoon.
3. **The lifecycle is specified two different ways**, in the same package.

None of these is a criticism of the design work, which is strong. They are the
sort of thing that only shows up when somebody reads all five files against
each other, which is what this is.

## 2. The third region: Oman or UK

| Source                        | Says                                                                                                             |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `README.md`                   | "Each region (UAE, KSA, UK)"                                                                                     |
| End-to-end Process Flow       | "three regions (UAE, KSA, **Oman**)"                                                                             |
| Screen Designs — Setup        | `+968 24 •• 7700` · **Oman** · Pending                                                                           |
| Screen Designs — SLA policies | "**Oman** · 15m / 8h"                                                                                            |
| Screen Designs — dashboard    | Volume by region: UAE, KSA, **Oman**; leaderboard "Hamad S. · Oman"                                              |
| Prototype data                | `UK:` region containing `id:'muscat'`, "London Freight Partners", company "Muscat Traders", number ending `7700` |
| **The business**              | **UK, +447388800000, live in Freshchat today**                                                                   |

**The build is right and the package is wrong.** The platform is configured for
UAE, KSA and UK with the real numbers.

This matters beyond tidiness. A Management pack showing an Oman region, an Oman
SLA policy and an Oman agent invites questions nobody can answer, and a reader
who notices "Muscat Traders" under the UK tab will doubt the rest of it.

**It needs one editing pass before the package is shown.** If Oman is a genuine
plan rather than a leftover, that is a different and much larger conversation —
a fourth WABA number, a fourth team and a fourth SLA policy — and it should be
said out loud rather than arrive through a prototype.

## 3. The palette: three answers, and a fourth from this afternoon

| Source                       | Says                                                                                                            |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `README.md`                  | Login is an "animated **navy/red** brand screen"                                                                |
| Screen Designs               | "graphite chrome `#22262D`, **steel** `#3D4A5C` accent, **amber** `#E8A33D` for SLA, brick red for breach only" |
| Screen Designs, explicitly   | "The ABC Cargo red appears **once**, as a dimmed logo mark — **no other UI element is red**"                    |
| Instruction to me, 8 October | "change theme" → applied ABC Cargo **red, black, white and grey**                                               |
| ABC Cargo branding standard  | Red, black, white and grey                                                                                      |

The demonstration currently uses brand red as its accent, which is what I was
asked for and what the corporate branding standard says — and which the screen
designs specifically rule out.

**One answer is needed.** My recommendation: **follow the screen designs**
(graphite / steel / amber, red for the logo and for breach only). Not because
the branding standard is wrong, but because a console is not a document. On a
screen whose job is to make a breach jump out, red has to mean "something is
wrong" and nothing else. If red is also the colour of buttons, tabs and the
active region, a breach stops being visible — which is the one thing this
screen exists for.

That is a recommendation, not a decision. Say which and I will apply it.

## 4. The lifecycle: two models in one package

| Source                         | Stages                                          |
| ------------------------------ | ----------------------------------------------- |
| `README.md` and the prototype  | New Lead → Hot Lead → **Payment** → Customer    |
| Screen Designs — Deal pipeline | New enquiry → Quoted → Negotiation → Won → Lost |

These are not the same thing, and the build deliberately has both: a **deal
pipeline** (what stage is this sale at) and a **relationship lifecycle** (what
is this customer to us), with the second **derived** from leads, quotations and
shipments so it cannot go stale.

The build's pipeline is New → Quoted → Negotiation → Won → Lost in all but
name, which matches the screen designs. The relationship lifecycle is derived
and has eight stages rather than four.

**"Payment" remains the odd one.** Whether an invoice is paid is a finance
fact, and you have told me the CRM has no finance part. A lifecycle stage the
platform cannot observe is one somebody has to maintain by hand, and it will be
wrong within a month. I would keep it out until there is a system that knows.

## 5. What the package specifies that is already built

| Specified                                               | Built                                                      |
| ------------------------------------------------------- | ---------------------------------------------------------- |
| Agent sees own conversations only, own region           | Yes, enforced in `src/auth/policy.ts` and verified         |
| Team lead: all queues in region, reassign, escalate     | Yes                                                        |
| Master admin: all regions, channels, users, keys, audit | Partly — people, teams and access log built                |
| Multi-team users                                        | Yes                                                        |
| First-response and resolution SLA clocks                | Yes, counted in business minutes on each region's calendar |
| Bot flow per number: language, menu, handover           | Yes, with publish-time validation                          |
| Bot test conversation preview                           | Yes — runs the real runtime, not a copy                    |
| Reply / internal note / voice note / file / location    | Yes                                                        |
| Team chat across regions                                | Yes                                                        |
| Contacts: searchable list, 360 view, notes              | Yes                                                        |
| Lifecycle stages, clickable pipeline                    | Yes                                                        |
| Dashboard: greeting, live KPIs, volume by region        | Yes                                                        |
| Setup: teams, roles, audit log                          | Yes                                                        |

## 6. What the package specifies that is NOT built

In the order I would do them. Items struck through were built on
8 October 2026 and are left in place with what changed, so the list stays
readable as a record rather than quietly shrinking.

1. **Email and phone as conversation channels.** The inbox in the designs
   counts "WhatsApp 8 · Email 3 · Calls 1" in one list. The build is WhatsApp
   only, with telephony read-only through Graph. This is the single largest
   piece of unbuilt scope in the package.
2. **ERP API lookup from the bot.** The designs show `GET /shipment/{awb}`
   answering a tracking question without an agent. The bot has the branch for
   it; what is missing is the shipment system's API, which is still an open
   decision.
3. **Reports: charts and a report library.** ~~No charts, no library, no
   export.~~ **Built on 8 October 2026** — `src/crm/report-library.ts`: four
   named reports, small multiples on a shared scale, a column chart, and a CSV
   export that defuses spreadsheet formula injection. Not persisted, not
   exposed over HTTP, no saved or scheduled reports. See
   `docs/palette-and-reporting.md` §6 and §7.
4. **CSAT and bot deflection.** ~~Neither is measured by anything today.~~
   **Measurement built on 8 October 2026** — `src/crm/csat.ts` and
   `src/crm/deflection.ts`, shown on the Reports screen. Deflection is defined
   from the bot's own recorded end reasons, with abandonment counted in the
   denominator and the kinder figure published beside it; CSAT refuses to
   publish a mean below ten responses per region. **No survey is sent yet** —
   eligibility and scoring exist, nothing dispatches them. See
   `docs/targets-transfer-and-measurement.md` §4, §5 and §8.
5. **Voice note transcription.** "Voice note · view transcript" in the designs.
   Inbound voice notes are stored; nothing transcribes them.
6. **Cross-region transfer.** ~~Assignment today is within a region.~~
   **Built on 8 October 2026** — `src/crm/transfer.ts`, on the Inbox. Turned
   up a constraint the designs do not show: a conversation cannot change its
   WhatsApp number, so a transfer moves ownership and the reply still leaves
   from the number the customer wrote to. The service clock is carried over
   rather than restarted. Not persisted and not exposed over HTTP. See
   `docs/targets-transfer-and-measurement.md` §2, §3 and §8.
7. **Per-team SLA policies.** ~~The build sets them per region and per ticket
   type.~~ **Built on 8 October 2026** — `src/crm/sla-policy.ts`, on the Setup
   screen, resolving team type → team default → region type → region default →
   platform default and showing the provenance of every row. A malformed
   policy is ignored and reported rather than obeyed. Display only; not
   editable and not persisted. See
   `docs/targets-transfer-and-measurement.md` §6 and §8.
8. **Bot builder screen** with blocks, "fallback after 10m" and "clone flow to
   another region". The runtime takes all of this; there is no builder UI, and
   the fallback-to-Tier-2 escalation is not in the runtime yet.
9. **Branded login screen.** The build puts Cloudflare Access in front
   instead — stronger, but there is no ABC Cargo-branded sign-in page.
10. **Security, backup, API keys, personalisation, mobile layout.** All in the
    Setup module as designed; none built.

## 7. What the build has that the package does not

Worth keeping when the package is used as the specification:

- **Broadcasts** with a frozen audience and a two-person approval.
- **Quotations** as a record with their own status machine.
- **Shipment milestones** with stall detection, raising a delay ticket before
  the customer chases.
- **Intent recognition in English and Arabic**, claims weighted above all else.
- **The 24-hour service window** enforced, not drawn.
- **Signature verification** on every inbound webhook.
- **Derived lifecycle**, which cannot go stale.

## 8. Decisions needed

1. **Third region — UK, as the business has, or is Oman real?** The package
   needs one editing pass either way.
2. ~~**Palette**~~ — **DECIDED 8 October 2026 by the Head of IT: red, white
   and black only.** The red is `#e64a3c`, read off ABC Cargo's own live sites
   rather than chosen. Applied to the demonstration; green and amber are gone,
   status is a weight ladder in one hue, and region identity is now shape
   rather than colour. See `docs/palette-and-reporting.md`.
3. **"Payment" as a lifecycle stage** — keep it out until a system knows, or
   maintain it by hand?
4. **Email and phone channels** — in scope now, or after the three WhatsApp
   numbers are cut over? They are not on the cutover's critical path.

## 9. Status

Nothing has been changed on the strength of this reading. The contradictions in
§2 to §4 are decisions for the Head of IT, and taking them silently in code
would bury them.

The standing hold remains in force.
