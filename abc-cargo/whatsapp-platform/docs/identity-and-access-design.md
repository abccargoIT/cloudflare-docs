# Identity and access — ABC Cargo Engage

**Status:** Authorisation built and tested. Authentication awaiting a decision
in §3. Nothing is enforced at runtime yet — see §6.
**Prepared by:** ABC Cargo IT Department
**Date:** 8 October 2026

---

## 1. Why this comes first

Engage is one application serving UAE, KSA and UK. Today every caller of
`/api/*` presents a single shared key and, having presented it, sees every
conversation in every region. For a centralised multi-region platform that is
the wrong shape, and the design package says so plainly: _an agent sees only
their own conversations_.

Nothing else in the design can be built correctly on top of a system that
cannot tell one person from another. A dashboard, a report, a team chat and a
contact directory all need the same question answered first: who is asking.

## 2. The split

Two different questions, deliberately answered by two different things.

| Question              | Answered by                                  | Why there                                                                                        |
| --------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| **Who are you?**      | Cloudflare Access, backed by Microsoft Entra | ABC Cargo already runs Microsoft 365. Staff already have an account, a password policy and MFA   |
| **What may you see?** | This platform                                | Region, team and assignment are the platform's own concepts, and no identity provider knows them |

**Recommendation: do not build password login into Engage.** The design package
shows a sign-in screen, and a prototype needs one. A production platform
holding customer conversations does not need its own password database, its own
reset flow, its own lockout policy and its own breach exposure, when the company
already has Entra and the Worker already sits behind Cloudflare Access.

That is a recommendation, not a decision taken. See §3.

## 3. The decision needed

| Option                                             | What it costs                                                     | What it gets                                                                                                   |
| -------------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| **A. Cloudflare Access + Entra SSO** (recommended) | Zero Trust configured once on the account                         | No passwords held by ABC Cargo. MFA and leaver handling already exist. Sign-in is the Microsoft one staff know |
| **B. Passwords in Engage**                         | Hashing, resets, lockout, MFA, rotation, and the breach liability | A login screen matching the prototype exactly                                                                  |
| **C. Both**                                        | All of B, plus two places to remove a leaver from                 | Nothing                                                                                                        |

Option C is the one to avoid. Two identity systems means a departing employee
has to be removed from both, and the one that gets forgotten is the one that
still works.

## 4. Roles

Taken from the design package, unchanged.

| Role           | Conversations                                 | Commercial records | Reports     | Setup |
| -------------- | --------------------------------------------- | ------------------ | ----------- | ----- |
| `agent`        | Own, plus the unclaimed queue, in own regions | Own regions        | No          | No    |
| `team_lead`    | All, in own regions                           | Own regions        | Own regions | No    |
| `master_admin` | All, all regions                              | All regions        | All regions | Yes   |

Regional reach comes from **team membership only**. A person is in one or more
teams, each team belongs to a region, and that is the whole of how someone
reaches a region. Removing them from the team removes the access, with nothing
else to remember.

### 4.1 Two rules that are not quite what the design says

**The unclaimed queue is visible to agents.** Read literally, "an agent sees
only their own conversations" hides a conversation nobody has taken from
everybody, and an inbox nobody can see is an inbox nobody answers. So: own
conversations plus unclaimed ones, within their own regions. Another agent's
open case stays hidden.

**Replying is stricter than reading.** An agent may read an unclaimed
conversation — that is how they decide to take it — but not reply to it until
they have. Two agents answering one customer differently is visible to the
customer and cannot be untangled afterwards. Claim it, then reply.

Both are implemented as written here. If the intent was stricter, say so and
the rules change in one file.

## 5. What is built

`src/auth/policy.ts` — every authorisation rule, as pure functions over a
caller and a record. No database, no request, no clock. An authorisation rule
that can only be exercised by standing up a Worker is one nobody tests; these
have 14 tests covering the awkward cases rather than the obvious ones.

Everything fails closed. Unknown role, suspended account, empty team list: the
answer is no. The specific trap guarded is an empty region scope being read as
"no filter" and therefore as "everything" — the test for it is called out by
name.

`src/db/migrations/0005_identity.sql` — users, teams, multi-team membership,
and an access log that records denials as well as grants, because a run of
denials is the thing worth noticing. It is separate from `activities`: an
auditor asking "who read this customer's conversation" is asking a different
question from "what happened to this customer".

A **service caller** is modelled separately from a user, for the shipment
system and scheduled sweeps. It has no region and no person behind it, and
explicitly **cannot administer**: a machine credential must not be able to add
users or rotate keys.

## 6. What is NOT built, and why

**Nothing is enforced at runtime yet.** `/api/*` still checks only the shared
bearer key. The policy module exists and is tested, but it is not wired in.

That is deliberate. Wiring it requires knowing how a request proves who it is,
and that is the §3 decision. Building authentication one way and then the other
would mean two attempts at the one part of this system where a mistake is
worth something to an attacker.

Also not built: the login screen, the dashboard, team chat, broadcasts, the
contact directory and the bot editor. All are in the design package and none
can be done properly before this.

## 7. Next, once §3 is decided

1. Resolve the caller from the Access assertion — and **verify the JWT**, not
   just read the email header. The Worker is reachable directly at its
   hostname, so an unverified header is a forged header.
2. Wire `resolveRegionFilter` into every listing, and the `canRead*` functions
   into every fetch by id.
3. Record each decision in `access_log`.
4. Seed the first `master_admin`, which is a live change with its own note.

## 8. Approval

Nothing here needs approval: no account was touched, no permission granted, no
code path enabled. §3 is a design decision for the Head of IT, and §7 step 4 is
the first part of this that will need `APPROVE LIVE CHANGE`.
