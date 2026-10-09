# Wiring the seven newest modules into the platform

**Prepared by:** ABC Cargo IT Department
**Date:** 9 October 2026
**Classification:** ABC Cargo Official — internal
**Status:** Code complete and verified locally. Nothing deployed. Nothing live changed.

---

## 1. Executive summary

Per-team service targets, conversation transfer, satisfaction surveys,
deflection measurement, the report library, the bot fallback and flow cloning
were tested rules with no tables, no routes and nothing running them. They are
now part of the platform: three migrations, eleven API routes, two scheduled
sweeps and the inbound path that catches a survey answer before anything else
reads it.

The work also found and fixed **two defects that would have affected the live
service**, both older than this change:

1. **Every WhatsApp send would have failed in production.** The WhatsApp
   client stored the global `fetch` and called it as a method, which the
   Workers runtime refuses with "Illegal invocation". Replies, the automated
   reply, bot messages and templates would all have failed before reaching
   Meta. The unit tests did not catch it because they inject their own fetch.
   It was found by running the platform locally against a real message.
2. **After a bot handover, the next customer message restarted the bot.** A
   customer halfway through explaining a claim to a colleague would have been
   sent the welcome menu. The bot now stays out of a handed-over conversation
   until it is resolved, or for 24 hours.

Everything that sends to customers on its own stays **off by default**:
satisfaction surveys need `CSAT_SURVEYS_ENABLED` set to `"true"`. The bot
fallback sweep sends the customer nothing.

## 2. Scope

| Item | In scope                                                                         |
| ---- | -------------------------------------------------------------------------------- |
| B1   | Migrations for team targets, transfers and surveys                               |
| B2   | HTTP routes for targets, transfer, reports, survey and deflection figures, clone |
| B3   | Scheduled bot fallback sweep                                                     |
| —    | Survey send sweep (off by default) and survey answer capture                     |

Out of scope, unchanged: deployment, Cloudflare configuration, Meta
configuration, the demonstration Worker.

## 3. What was built

### 3.1 Database (`src/db/migrations/`)

| Migration           | Adds                                                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `0011_sla_policies` | `team_sla_policies`, `region_sla_policies` — targets stored as JSON per team and per region                                           |
| `0012_transfers`    | `conversations.assigned_team_id`; `conversation_transfers` — who moved what, from where, to where, why, and which warnings were shown |
| `0013_csat`         | `csat_surveys` — one row per conversation, score constrained to 1–5, channel to `free_text` or `template`                             |

All three are additive. No existing column changes meaning; no data is
rewritten.

### 3.2 API routes (`src/index.ts`)

| Route                                       | Who                                     | Notes                                                                                               |
| ------------------------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `POST /api/conversations/:id/transfer`      | People only; agents within their region | Region taken from the team, never the body. Named recipient must be an active team member           |
| `GET /api/conversations/:id/transfers`      | Anyone who can read the conversation    | The audit trail                                                                                     |
| `GET /api/sla/teams`                        | Team leads and admins, own regions      | Each team's effective target per ticket type and which level supplied it                            |
| `PUT` / `DELETE /api/sla/teams/:teamId`     | Master admin                            | Validated before saving; a bad policy is refused with the reason                                    |
| `GET /api/reports/library`                  | Team leads and admins                   | The named reports                                                                                   |
| `GET /api/reports/library/:id[?format=csv]` | Team leads and admins, own regions      | Rows, chart series, or a CSV with formula-injection defence. Window capped at 92 days               |
| `GET /api/reports/csat`                     | Team leads and admins, own regions      | Mean withheld below 10 responses, per region as well as overall                                     |
| `GET /api/reports/deflection`               | Team leads and admins, own regions      | Deflected, escalated and abandoned side by side, per flow, and where customers stopped              |
| `POST /api/bots/flows/:id/clone`            | Master admin                            | Saved as a **draft** with the next version in the target region; warnings returned, never published |

### 3.3 Ticket targets now follow the team

When a ticket opens, its due dates come from the owning team's policy if it
has one, then the region's, then the platform default. If the policy tables
cannot be read the ticket still opens, on the defaults — a supervisor setting
must never stop a claim being logged.

### 3.4 Scheduled work (every minute)

| Sweep           | Does                                                                                                                                                      | Sends to customers                         |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| Broadcast pacer | Unchanged                                                                                                                                                 | Only if `BROADCASTS_ENABLED` is `"true"`   |
| Bot fallback    | A bot session silent past its step's threshold, in **business** minutes, ends as a handover to the regional queue. Past 24 hours it ends as expired       | **Never**                                  |
| Survey pass     | Asks a resolved conversation for a 1–5 score once it has stayed resolved for 10 minutes, inside the 24-hour window, at most once per customer per 30 days | Only if `CSAT_SURVEYS_ENABLED` is `"true"` |

Each sweep runs independently; one failing does not stop the others. The
fallback write is conditional on the session not having changed since it was
read, so a customer who replies during the sweep wins.

### 3.5 Survey answers

An answer is recognised before the bot, the classifier or the automated reply
sees the message. Without that, "5" would be read as menu option five, and a
customer who had just rated the service at night would be told the office is
closed. A survey answer does not reopen the resolved conversation and does
not open a ticket. Only the first answer counts.

## 4. Verification

| Check                                                  | Result                                                                                                                                               |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Type check (`tsc --noEmit`)                            | Clean                                                                                                                                                |
| ESLint                                                 | Clean                                                                                                                                                |
| Prettier                                               | Clean                                                                                                                                                |
| Unit tests                                             | 451 pass, 0 fail (18 new, including a regression test for the send defect that fails without the fix)                                                |
| Migrations on a fresh local database                   | 13 of 13 applied                                                                                                                                     |
| Report, survey, deflection and target routes over HTTP | Correct figures; CSV has BOM, CRLF and a Windows-safe name                                                                                           |
| Transfer, target save and clone as a service key       | Refused 403, as designed                                                                                                                             |
| Survey answer "5 - very helpful, thank you"            | Score 5 and comment stored; conversation stayed resolved; no automated reply; no ticket                                                              |
| Fallback sweep via the cron handler                    | 3 sessions: one expired, one handed over after 60 business minutes, one correctly left alone because the desk was closed. Second run changed nothing |
| Transfer UAE → KSA as a team lead (storage harness)    | Region and team moved, **WhatsApp number unchanged**, audit row with "receiving region closed" warning                                               |
| Team target for KSA claims set to 15 minutes           | New ticket due 15 minutes after opening instead of 30                                                                                                |
| Unreadable stored policy                               | Skipped, logged, ticket falls back to the default                                                                                                    |
| Clone UAE → KSA                                        | Saved as KSA draft v1, a second clone as v2; never published                                                                                         |

**Not verified over HTTP:** the routes that require a signed-in person —
transfer, target save and clone. Locally there is no way to obtain a
Cloudflare Access token, so their storage and decision logic was exercised
directly against the same database, and the route code is covered by the type
check only. They should be exercised once from the browser on the demo
hostname before anyone relies on them.

## 5. Risk

| Risk                                                                                | Treatment                                                                                               |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Survey wording is a draft                                                           | Sending is off. The wording in `src/crm/csat-sweep.ts` needs approval before it is switched on          |
| Surveys cannot be sent after the 24-hour window                                     | By design until a survey template is approved by Meta                                                   |
| Out-of-hours replies after a transfer still follow the receiving **number's** hours | Known; a transfer moves ownership, not the channel. Documented in `targets-transfer-and-measurement.md` |
| "Resolved at" for surveys is the conversation's last update                         | Affects only whether a survey is sent, never a score. A dedicated column is the better fix later        |
| Tier 2 escalation is not acted on                                                   | No Tier 2 queue exists in the data model. Needs a decision on who Tier 2 is                             |

## 6. Rollback

All changes are in this branch and not deployed. If deployed later and a
problem appears: set `CSAT_SURVEYS_ENABLED` to `"false"`; redeploy the
previous Worker version from the Cloudflare dashboard. The three migrations
are additive and can stay in place under the previous code.

## 7. Next action

1. Approve or amend the survey wording before `CSAT_SURVEYS_ENABLED` is ever
   set to `"true"`.
2. Redeploy the demo Worker when convenient so the hosted page matches the
   repository (one report description changed). This needs `APPROVE LIVE
CHANGE for DEMO`.
3. Decisions already open: own repository (A1), the three Freshchat bot flow
   exports (A3), third region, and who Tier 2 is.
