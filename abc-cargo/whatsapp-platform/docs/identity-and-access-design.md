# Identity and access — ABC Cargo Engage

**Status:** Built, wired and enforced. Option A approved by the Head of IT on
8 October 2026. Awaiting Access configuration on the account — see §6.
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

**Approved by the Head of IT on 8 October 2026.** Option A is what is built.

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

## 6. What is built and enforced

`/api/*` no longer accepts a single shared key for everything. Two kinds of
caller, deliberately not the same thing:

| Caller      | Proves itself with                                | Reach                                      |
| ----------- | ------------------------------------------------- | ------------------------------------------ |
| **Person**  | A Cloudflare Access assertion, signature verified | Their teams' regions, and the policy in §4 |
| **Service** | The shared bearer key                             | All regions, but **cannot administer**     |

### 6.1 The header that must never be trusted

Access sets two headers. `Cf-Access-Authenticated-User-Email` is the tempting
one and reading it would be a hole: this Worker answers on a public hostname,
so anyone who knows the address can set that header themselves and become
whoever they like.

Only `Cf-Access-Jwt-Assertion` is read, and only after its signature has been
verified against the account's own published keys. A test asserts that
`access.ts` never reads the email header, so the mistake cannot be made later
by someone who did not know.

### 6.2 What the verifier checks

Sixteen tests, against real RSA keys and real signatures rather than fixtures:

- `alg` must be RS256. `none` and `HS256` are refused by name — the two
  classic ways into a JWT verifier.
- The signing key must be one the account published, by `kid`.
- The signature must match, so a tampered payload fails.
- The issuer must be this account's, and the **audience must be this
  application's** — a token minted for another Access application is signed by
  the same key and must not open this one.
- Expiry, with sixty seconds of clock skew allowed in each direction.
- An email and a subject must both be present.
- Unconfigured, unreachable keys, or no usable keys: refuse.

### 6.3 Being signed in is not enough

A verified identity is then looked up here. They must exist, be active, and be
in at least one team. Three distinct refusal reasons are recorded — never set
up, suspended, in no team — because an auditor wants to tell them apart, while
the caller gets the same bare `403` either way: a signed-in stranger learns
nothing about who else exists.

### 6.4 Enforced on the conversation routes

- **Listing** intersects the requested region with the caller's scope, then
  filters each row through the same `canReadConversation` used for a direct
  fetch, so a list and a fetch can never disagree.
- **Fetch by id** refuses with the policy's own reason.
- **Reply** additionally refuses posting as somebody else: the reply is
  attributed to whoever is signed in, not to whoever the body names.
- **Assign** records the signed-in person as the actor rather than trusting
  the body.

Verified against a running Worker: no credential, a forged email header, a
garbage assertion and a wrong bearer key are all refused `401`, while `/health`
and the demonstration stay public.

### 6.5 Still to do

The commercial routes — leads, quotations, bookings, tickets, calls — are not
yet scoped. They are regional rather than personal, so `canReadRegionalRecord`
applies to each, and that is mechanical rather than a design question.

Not built: the login screen (Access provides it), dashboard, team chat,
broadcasts, contact directory, bot editor.

## 7. Before this can be switched on

1. Create the Access application for `engage.abccargosupport.com` in Zero
   Trust, with Entra as the identity provider.
2. Set `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`. **With either unset every
   console request is refused** — a platform that cannot tell who is asking
   must not guess.
3. Seed the first `master_admin` and one team per region. This is a live change
   and needs its own note.
4. Scope the commercial routes, per §6.5.

## 8. Approval

The design decision in §3 is approved. Nothing in the Cloudflare or Entra
account has been touched: no Access application created, no variable set, no
user seeded.

Steps 1 to 3 of §7 are live changes and each needs `APPROVE LIVE CHANGE` with
its own note. Step 3 in particular — seeding the first administrator — decides
who can subsequently grant everyone else, and should name that person
explicitly rather than being done in passing.
