# Engage — Dashboard

**Prepared by:** Head of IT, ABC Cargo IT Department
**Date:** 8 October 2026
**Status:** Built and verified against a local database. Nothing deployed. No live system changed.

---

## 1. Executive summary

The dashboard is built: a greeting in the region's own hours, the live queue
state for each of the three numbers, an ordered list of what needs somebody
now, and the signed-in person's own work. It is open to agents, which reports
are not, and that division is the point of the module.

**Two defects were found and fixed while building it.** Both would have shown
in production as the platform being wrong about whether anyone was at a desk:

1. `countOnlineAgents` joined the old `agents` table, so once the console was
   behind Cloudflare Access — where presence is posted under a `users.id` — it
   would have returned **zero at all times**. The automated reply would then
   have told every customer who messaged during working hours that "all our
   agents are currently assisting other customers". Demonstrated below.
2. Presence never expired. A browser closed without signing out left an
   "online" row behind for ever, so an agent who went home at six would have
   gone on suppressing the automated reply all night — the customer getting
   neither a person nor an acknowledgement.

A third, smaller one: any authenticated caller could set anybody's presence,
because the endpoint took the id from the URL and never compared it to the
caller. A person now sets their own; a supervisor may mark a colleague away.

## 2. Business requirement

Three numbers, three operations, three working weeks. The question a supervisor
opens in the morning — _is anyone waiting, is anyone here, is the office even
open_ — currently has no answer anywhere in the platform. The reports module
answers a different question, over a fortnight, and is deliberately closed to
agents.

## 3. Scope

| In scope                                             | Not in scope                                 |
| ---------------------------------------------------- | -------------------------------------------- |
| Greeting and office state in each region's own hours | Charts and a report library (reports module) |
| Live queue counts and the longest wait               | Satisfaction scores, average handling time   |
| An ordered list of what needs attention              | A UI — this is the API that one would read   |
| The signed-in person's own queue                     | Broadcast or campaign figures                |
| Presence as a single source of truth                 | Per-agent performance comparison             |

## 4. The dashboard is not the reports

This is the decision the whole module rests on, so it is worth stating plainly.

|               | Dashboard                                  | Reports                                    |
| ------------- | ------------------------------------------ | ------------------------------------------ |
| Question      | What needs doing now                       | How did we do                              |
| Period        | This moment; "today" in the region's hours | A window, in UTC, the same in every region |
| Audience      | Everyone with a desk, agents included      | Supervisors and above                      |
| Per colleague | Presence only (who is about)               | Workload and comparison                    |

An agent must see that twelve customers are waiting — it is their work. How
their first-response time compares with a colleague's is a management view, and
the design puts it behind a supervisor. `canViewDashboard` allows agents;
`canViewReports` does not; and `canSeeAgentWorkload` is the line between the
two inside this module.

The two modules therefore **disagree about "today"**, and that is correct. A
figure being compared across three regions has to be measured identically in
each, so reports use UTC windows. A figure answering "what is happening in
Riyadh now" has to use Riyadh's day. Either choice alone would be wrong for the
other question.

## 5. What was built

| File                                   | What it holds                                               |
| -------------------------------------- | ----------------------------------------------------------- |
| `src/dashboard/clock.ts`               | The region's day, hours and greeting. Pure                  |
| `src/dashboard/presence.ts`            | Who is at a desk — the single source of truth               |
| `src/dashboard/service.ts`             | The queries behind the dashboard                            |
| `src/auth/policy.ts`                   | `canViewDashboard`, `canSeeAgentWorkload`, `canSeeOwnQueue` |
| `src/db/migrations/0008_dashboard.sql` | The indexes the polled queries need                         |

### An agent's dashboard is narrowed twice

Once by region, as every listing is. Then again, for the attention list only,
to the conversations an agent may actually read — their own and the unclaimed
ones, exactly as `canReadConversation` allows. Without that second narrowing
the dashboard would hand an agent a list of every colleague's open
conversation, which is precisely what that rule exists to prevent. It was
verified rather than assumed: see §6.

The rule is stated once, as `seesEveryConversationInRegion`, and deliberately
kept separate from `canSeeAgentWorkload` even though the two agree on who
today. Tying them together would mean a future change to what a supervisor may
_measure_ silently changing what an agent may _read_.

## 6. Evidence

Verified on 8 October 2026 against a **local** database, with a local-only
service key in a gitignored `.dev.vars` that was deleted afterwards. The
fixture rows were invented and were deleted afterwards. No remote database, no
deployment, no live system.

| Check                                         | Result                                      |
| --------------------------------------------- | ------------------------------------------- |
| `npm run test`                                | **232 passed, 0 failed** (22 new)           |
| `npm run typecheck` / `lint` / `format:check` | Clean                                       |
| `wrangler deploy --dry-run`                   | 343.27 KiB / 84.47 KiB gzip                 |
| `wrangler d1 migrations apply --local`        | `0008_dashboard.sql`, 6 commands            |
| `GET /api/dashboard`                          | 200, figures matched the fixture row by row |

### 6.1 The figures were checked against the fixture, not just rendered

Three UAE conversations were seeded: one assigned and unanswered since 09:00,
one assigned and answered, one unclaimed and unanswered since 11:30. Plus one
inbound message timestamped the previous day in Dubai.

The dashboard returned `waiting: 3`, `unassigned: 1`, `unanswered: 2`,
`longestWait: "6 hours 47 minutes"`, `today: { inbound: 2, outbound: 1 }`.
Every one of those is the right answer, and the previous day's message was
correctly outside the Dubai day. The UK strip read `closes in 43 minutes` at
16:47 London against a 17:30 close.

### 6.2 The agent narrowing was verified, not assumed

The narrowed query was run for a second agent who owns none of those
conversations. It returned **only the unclaimed one** — not the conversation
assigned to a colleague. That is the leak the narrowing exists to prevent, and
it is closed.

### 6.3 The presence defect was demonstrated, not asserted

With one fresh presence row for a person who exists in `users` and not in
`agents` — which is what every signed-in console user will be — run against the
same database at the same moment:

| Query                            | Result |
| -------------------------------- | ------ |
| The original `countOnlineAgents` | **0**  |
| The replacement                  | **1**  |

Zero is what the automated reply would have acted on. Separately, a presence
row three hours old was correctly **not** counted, which is the staleness rule
working.

### 6.4 A pre-existing finding, not caused by this change

Every `/api/*` route returns **500** against the committed configuration,
because `REGION_NUMBERS` in `wrangler.jsonc` carries three regions whose
`phoneNumberId` is the same placeholder `REPLACE_ME`, and `parseRegionConfig`
correctly refuses duplicates. This is expected before the real Meta phone
number ids are supplied, and it is the right failure — a platform that cannot
tell which number a message arrived on must not guess. It is recorded here only
so it is not mistaken for a fault in this module when somebody first runs the
API. The local verification above used a valid configuration supplied through
`.dev.vars`.

## 7. API

`GET /api/dashboard?region=&attention=`

| Caller       | Gets                                                                                |
| ------------ | ----------------------------------------------------------------------------------- |
| Agent        | Greeting, their regions, their own queue, their own attention list                  |
| Team lead    | The above, plus every conversation in their regions and the per-colleague breakdown |
| Master admin | The above across all three regions                                                  |
| Service key  | Queue state only — no greeting by name, no personal queue                           |

A service key is allowed so an office wallboard can poll it. It has no desk, so
there is nothing personal to show it.

`region=` is intersected with the caller's own scope, as elsewhere: ask for
everything and you get your own regions, ask for somebody else's and you get
nothing.

## 8. Risk

| Risk                                            | Mitigation                                                                   |
| ----------------------------------------------- | ---------------------------------------------------------------------------- |
| A stale tab read as live                        | `generatedAt` is on every response                                           |
| Presence believed after somebody has gone home  | A row is believed for 15 minutes; the console must refresh inside that       |
| An agent seeing colleagues' conversations       | Narrowed in SQL and verified; see §6.2                                       |
| Polling cost on D1                              | Five queries per region in one batch, all aggregated in SQL; indexes in 0008 |
| "Today" meaning different things in two modules | Deliberate and documented; see §4                                            |

## 9. What is still required from the business

1. **How often the console should refresh presence.** Fifteen minutes is the
   current window; the console must post inside it or people will drop off the
   dashboard while sitting at their desks.
2. **Whether a supervisor may mark a colleague offline**, or only away. Today
   they may set either.
3. **The real `REGION_NUMBERS`**, without which no API route runs at all.

## 10. Rollback

Nothing deployed, so nothing to roll back. `0008_dashboard.sql` adds indexes
only — no table, no column, no data — so applying it to the remote database,
when that is authorised, is reversible with `DROP INDEX` and changes no row.

The presence change alters behaviour rather than data: it makes the platform
_more_ likely to send an automated acknowledgement, which is the safe
direction. Reverting it would restore the defect in §6.3.

## 11. Approval

No approval is required for what has been done, which is preparation and local
verification only.

**`APPROVE LIVE CHANGE` would be required before** applying `0008_dashboard.sql`
to the remote database or deploying the Worker.

The standing hold of 8 October 2026 — _"dont change any live"_ — remains in
force and neither has been requested.

## 12. Next action

From the design package this leaves **Broadcasts** and the **Composer**
additions (internal note, voice note, file, location) as the modules with
nothing built. Neither is on the cutover's critical path.
