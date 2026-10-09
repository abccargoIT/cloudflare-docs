# ABC Cargo Engage — what to host, and what to do

**Prepared by:** ABC Cargo IT Department
**Date:** 9 October 2026
**For:** Head of IT
**Status:** Plan. Nothing in Part C has been executed. The standing hold of
8 October 2026 is in force.

---

# PART 0 — The demonstration, live (what was actually asked)

The Head of IT clarified on 9 October 2026: "live" here means **the
demonstration, hosted**. The production values — phone number IDs, Meta
credentials — will be supplied separately at go-live. Parts A to C below cover
production and can wait.

## 0.1 It is hosted — and as of 9 October 2026, current

> **Update, 9 October 2026:** the Head of IT redeployed the demonstration and
> switched the hostname to `abc-cargo-engage-demo`. The table below describes
> the state _before_ that redeploy and is kept as the record of why it was
> needed. See `docs/demo-deployment.md` §9.

### Before the redeploy

The demonstration Worker `abc-cargo-engage-demo` is deployed on
`engage.abccargosupport.com`, behind Cloudflare Access. It was deployed from
commit `c0bb19c` on 8 October.

**Five commits have landed since, and none of them is on the hosted demo:**

| Commit    | What the hosted demo is missing                                          |
| --------- | ------------------------------------------------------------------------ |
| `0fc94ed` | Access exemption procedure (document only)                               |
| `91dfd0e` | Per-team service targets, cross-region transfer, CSAT, bot deflection    |
| `c9d3ed4` | **The red, white and black palette**, charts, report library, CSV export |
| `6a0075c` | Bot fallback, flow cloning, **the service-clock fix**                    |
| `3a88c08` | This plan (document only)                                                |

So anyone opening the hosted demo today sees the old colours, no charts, and
the service clock that marks tickets late too early. That is very probably why
the work has looked unfinished from the outside: the repository has moved on
and the hosted page has not.

## 0.2 What to host — nothing new

No new resource, no new cost, no plan change. The same demo-only Worker is
redeployed with the current page. Verified by a dry run on 9 October 2026:

|                          |                                                               |
| ------------------------ | ------------------------------------------------------------- |
| Worker                   | `abc-cargo-engage-demo` (unchanged)                           |
| Upload                   | 330 KiB, 86 KiB gzipped (was 246 / 62)                        |
| Bindings                 | **One** — `DEPLOY_NOTE`. No database, bucket, queue or secret |
| Can it reach a customer? | **No.** It holds no credentials of any kind                   |

## 0.3 What to do

Run `tools/deploy-demo.ps1` from the project folder, in a Windows PowerShell
console (not ISE):

```txt
cd <your clone>\abc-cargo\whatsapp-platform
powershell.exe -ExecutionPolicy Bypass -File .\tools\deploy-demo.ps1
```

It checks the folder, the branch and that you have no uncommitted work; pulls
the latest with `--ff-only`; refuses to deploy anything older than `6a0075c`;
dry-runs; shows what is live now so it can be put back; and deploys only after
you type `DEPLOY DEMO`. It touches nothing but the demo page.

**Rollback**, if the new page looks wrong:

```txt
npx wrangler rollback --name abc-cargo-engage-demo -m "Revert demo"
```

With no version id it returns to the version that was live before.

The script was written to Windows PowerShell 5.1 rules and checked for
5.1-incompatible syntax and non-ASCII characters, but **it has not been
executed** — there is no PowerShell in the environment it was written in. If
any step stops, send IT the output.

## 0.4 Letting management see it

The demo sits behind Cloudflare Access, so a viewer must be allowed by its
policy. To show it to management, add their email addresses (or an
`@abccargo.ae` rule, if everyone should see it) to the Allow policy on the
`engage.abccargosupport.com` Access application, in **Zero Trust → Access
controls → Applications**.

That is a change to a production access policy, so it is the Head of IT's to
make. It does not need the webhook exemption in Part C — that is for Meta's
servers at cutover, not for people.

---

## 1. Executive summary

Engage needs **one Cloudflare account on the Workers Paid plan**, costing a
minimum of **USD 5 per month**, plus six account resources and four secrets.
There is no server to buy, no operating system to patch and no backup agent to
licence — the platform is a Cloudflare Worker.

The work splits into three parts, and they are not equally urgent:

- **Part A — decisions only you can make.** Four of them. Two block everything
  else.
- **Part B — code still to write.** Three items, none blocked, roughly the
  next working week.
- **Part C — hosting and cutover.** The procedure below, which needs
  `APPROVE LIVE CHANGE` and a window.

The honest position: the platform's rules are built and tested — 58 modules,
433 tests — and a demonstration runs the real decision logic offline. What
does not yet exist is the wiring that makes the newest seven modules reachable
by a browser, and the live Meta credentials. Neither is a research problem;
both are a few days of ordinary work plus your inputs.

---

# PART A — Decisions only you can make

These are listed first because two of them change what gets hosted.

## A1. Which repository — and this one is urgent

Engage currently lives inside a **fork of Cloudflare's documentation
repository** (`abccargoIT/cloudflare-docs`), in `abc-cargo/whatsapp-platform/`.

That has one hard consequence: **the pull request can never show green.** That
repository's CI runs the full documentation-site build, which fetches
`gh-code.developers.cloudflare.com`. That hostname has **no public DNS
record** — it is internal to Cloudflare — so the build cannot complete on any
machine outside Cloudflare's own network. Nothing written in `abc-cargo/` will
change that.

Consequences beyond the red tick:

- Anyone reviewing the pull request sees a failing build and reasonably
  assumes ABC Cargo's code is broken. It is not.
- ABC Cargo's platform source sits in a tree containing 5,400 pages of
  Cloudflare's documentation, which has to be cloned to work on it.
- There is no CI that actually tests Engage. The 433 tests are run by hand.

**Recommendation:** create `abccargoIT/abc-cargo-engage` and move
`abc-cargo/whatsapp-platform/` into it as the repository root. A short CI
workflow then runs the real checks — typecheck, lint, format, 433 tests — in
about two minutes, and a green tick means something.

**What it costs:** nothing. **Who:** you create the repository; I can do the
move and write the workflow.

## A2. The third region — Oman or UK?

The accepted design package describes **Oman** (its prototype carries Muscat
addresses and a `+968` number). The business runs **UK** (`+447388800000`),
and the build uses UK throughout.

One of the two is wrong and it affects the hosting plan: a region is a
WhatsApp number, a timezone, a language and a desk. **Blocks:** the Management
pack, and the third cutover.

## A3. The three Freshchat bot flow exports

Still the largest single blocker to replacing the live service. The bot
runtime, the validator, the preview, the timed fallback and the region clone
are all built and tested — against a **starter flow I wrote**, not ABC Cargo's
live flows. Until the three exports arrive, nobody can say whether the real
flows will behave the same.

**What is needed:** from Freshchat, for each of the three numbers, the bot
flow export (JSON or the admin screens, either will do).

## A4. Two smaller ones

- **"Payment" as a lifecycle stage** — keep it out until a system knows, or
  maintain it by hand?
- **Email and phone as channels** — now, or after the three WhatsApp
  cutovers? They are not on the cutover's critical path.

---

# PART B — Code still to write

None of this needs a decision or touches anything live. It is what turns
tested rules into a product.

| #   | Work                                            | Why it matters                                                                                                                                                                                               | Rough size |
| --- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- |
| B1  | Migrations `0011`+ for the seven newest modules | Per-team targets, transfers, surveys, survey responses, bot session outcomes and cloned flows have **no tables**. Today they exist only as logic and in the demonstration's browser storage                  | 1 day      |
| B2  | HTTP routes for those modules                   | `src/index.ts` already serves conversations, customers, leads, quotations, bookings, tickets, calls, admin, broadcasts, dashboard, bots and chat. The seven newest are **not reachable by a browser at all** | 2 days     |
| B3  | A cron sweep that runs the bot fallback         | `checkFallback` decides and `applyFallback` produces the effects; **nothing calls them on a schedule**, so no conversation is actually rescued yet                                                           | ½ day      |

A fourth item is worth naming as deliberately _not_ done: **"Assign to
group"** from the wireframe. The runtime hands over to a queue but does not
choose a group inside it, because who gets what is a routing rule ABC Cargo
has not written down. A button that picks arbitrarily is worse than no button.

**Recommendation:** do B1–B3 next, before adding any further modules. The
platform currently knows how to do more than it can actually do.

---

# PART C — Hosting

## C1. What has to exist in Cloudflare

One account, on **Workers Paid**. Inside it:

| #   | Resource       | Name                          | Purpose                                                                     |
| --- | -------------- | ----------------------------- | --------------------------------------------------------------------------- |
| 1   | Worker         | `abc-cargo-whatsapp-platform` | The whole application                                                       |
| 2   | D1 database    | `abc-whatsapp`                | Customers, conversations, tickets, leads, bookings, calls, bots, broadcasts |
| 3   | R2 bucket      | `abc-whatsapp-media`          | Images, documents and voice notes customers send                            |
| 4   | Queue          | `abc-whatsapp-webhooks`       | Inbound webhooks, so Meta gets a fast 200 and the work happens after        |
| 5   | Queue          | `abc-whatsapp-webhooks-dlq`   | Dead letters, after 5 failed attempts                                       |
| 6   | Durable Object | `Conversation` (SQLite)       | One per customer conversation; serialises concurrent webhooks               |
| 7   | Custom Domain  | `engage.abccargosupport.com`  | The stable webhook callback URL                                             |
| 8   | Cron trigger   | every minute                  | The broadcast pacer, and (after B3) the bot fallback sweep                  |

The zone is already active in the ABC Cargo Cloudflare account and
`engage.abccargosupport.com` already resolves through the Cloudflare proxy,
held open by a placeholder `A` record to `192.0.2.0`. On deploy, Cloudflare
attaches the Worker as the Custom Domain and manages the DNS record and the
certificate itself.

**Currently deployed on that hostname:** `abc-cargo-engage-demo`, a
demonstration-only Worker with no database, no bucket, no queue and no
credentials. Deploying the full platform **replaces it**.

## C2. Why Workers Paid, and what it costs

Verified against Cloudflare's pricing documentation on 9 October 2026:

|                              | Free                           | Paid                                     |
| ---------------------------- | ------------------------------ | ---------------------------------------- |
| **Plan minimum**             | —                              | **USD 5 / month per account**            |
| Workers requests             | 100,000 / day                  | 10 million / month, then $0.30 / million |
| Queues operations            | 10,000 / day                   | 1 million / month, then $0.40 / million  |
| **Queues message retention** | **24 hours, not configurable** | **4 days, configurable to 14**           |
| D1 rows read                 | 5 million / day                | 25 billion / month included              |
| D1 rows written              | 100,000 / day                  | 50 million / month included              |
| Durable Objects              | available (SQLite only)        | available                                |

**The line that matters is queue retention.** On the Free plan a message that
cannot be processed is discarded after 24 hours and cannot be recovered. For a
pipeline carrying customer messages that is not acceptable: one bad deploy on
a Friday loses a weekend of inbound WhatsApp traffic with no way to replay it.
Paid raises it to 4 days and allows up to 14.

**Realistic monthly cost at ABC Cargo's volume.** Three numbers, even at a
busy few thousand conversations a month, sit inside every included allowance.
Expect **USD 5 per month**, plus R2 storage for media, which is pennies until
the bucket holds many gigabytes. This is not a material cost; the reason to
settle it before cutover is the retention limit, not the money.

## C3. The four secrets

Set with `wrangler secret put <NAME>`. **Never** in `wrangler.jsonc`, never in
git, never in a chat message or a ticket.

| Secret                  | What it is                                                                                           | Where it comes from                                    |
| ----------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `WHATSAPP_ACCESS_TOKEN` | Permanent System User token, scopes `whatsapp_business_messaging` and `whatsapp_business_management` | Meta Business Suite → Business settings → System users |
| `WHATSAPP_APP_SECRET`   | Meta App secret. Verifies `X-Hub-Signature-256` on every inbound webhook                             | Meta for Developers → your App → Settings → Basic      |
| `WHATSAPP_VERIFY_TOKEN` | A random string **you choose**, entered identically in the Meta webhook configuration                | Generate one; 32+ random characters                    |
| `INTERNAL_API_KEY`      | Bearer key for the `/api/*` agent endpoints                                                          | Generate one                                           |

Generate the two you choose with a cryptographic source, not by typing.

## C4. The Meta side

Not Cloudflare, and it is the part with a waiting period.

1. **Meta App** with the WhatsApp product added.
2. **System User** with a permanent token, scoped as above. A user token
   expires; a System User token does not.
3. **The three phone number IDs**, from WhatsApp Manager → Phone numbers.
   These are identifiers, not secrets. You have said they come at go-live;
   `wrangler.jsonc` carries three distinct placeholders until then. They must
   be three _different_ values — three identical ones are refused as
   duplicates, and that refusal makes every `/api/*` route return 500.
4. **Approved message templates**, per language, for anything sent outside the
   24-hour service window. Template approval is Meta's queue, not ours, and it
   takes time. Submit early.
5. **The callback URL**, saved last: `https://engage.abccargosupport.com/webhooks/whatsapp`,
   with the verify token from C3.

## C5. The Cloudflare Access exemption

`engage.abccargosupport.com` sits behind Cloudflare Access. Meta's servers
cannot sign in, so webhook POSTs are answered with a redirect to the login
page, which Meta does not follow — and after repeated failures Meta
**disables the webhook subscription**.

The exemption is therefore mandatory at cutover and premature before it. The
procedure is prepared in `docs/access-webhook-exemption.md`: a separate Access
application scoped to `webhooks/*` with a single Bypass policy, leaving the
console's protection untouched. It needs its own `APPROVE LIVE CHANGE`, and
the verification step that matters is proving `/` still redirects to login
afterwards.

## C6. Order of work

Steps 1–6 touch nothing live. Step 7 is the cutover.

| Step | What                                                                                                                                                                          | Live risk                                                                                 | Who                             |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------- |
| 1    | Create the repository (A1) and move the project                                                                                                                               | None                                                                                      | You, then me                    |
| 2    | B1–B3: migrations, routes, fallback sweep                                                                                                                                     | None                                                                                      | Me                              |
| 3    | Confirm the account is on Workers Paid                                                                                                                                        | None                                                                                      | You                             |
| 4    | Create D1, R2 and both queues; fill the D1 id into `wrangler.jsonc`                                                                                                           | None                                                                                      | Either                          |
| 5    | Apply migrations to the remote D1                                                                                                                                             | None — empty database                                                                     | Either                          |
| 6    | Set the four secrets; deploy with `SERVE_DEMO=false`, `BROADCASTS_ENABLED=false`, placeholder phone number IDs. Verify `/health`, verify an unsigned webhook POST returns 401 | **None — Meta still points at Freshworks.** The Worker answers but no customer reaches it | Either                          |
| 7    | **Cutover, one region at a time.** Real phone number ID, Access exemption, then save the callback URL in Meta                                                                 | **This is the step that moves customer traffic**                                          | You, with `APPROVE LIVE CHANGE` |

Keep `BROADCASTS_ENABLED=false` through all of it. Broadcasts are the one
action that reaches thousands of customers at once, and switching them on is a
separate decision from deploying the platform.

Set `SERVE_DEMO=false` before the first cutover. The demonstration carries
invented customer data and has no place on a production endpoint.

## C7. Rollback

Per region, and it is the reason to cut over one number at a time: **in the
Meta App dashboard, point the callback URL back at Freshworks.** Inbound
messages return to the old system within seconds. Nothing in Cloudflare needs
to be undone, and no customer data is lost — Engage keeps what it received.

That is the whole rollback. It is quick and complete, which is what makes a
staged cutover safe.

---

## 2. What is NOT in this plan

- **No disaster-recovery plan for D1.** Cloudflare offers time-travel
  restore; ABC Cargo has no stated retention requirement for conversation
  history, and that decision has not been taken. Worth a separate note before
  the platform holds months of real customer data.
- **No data-retention policy.** How long conversations, media and transcripts
  are kept is an open question with privacy implications in three
  jurisdictions.
- **No agent training or runbook for the desk.** The platform replaces the
  tool agents use every day; that is a change-management task, not a technical
  one.
- **No load testing.** The architecture handles it on paper; nothing has been
  measured.
- **No email or phone channels** (A4).

## 3. Approval

Steps 1–5 of §C6 are preparation and need no live-change approval. Step 6
creates resources in a new, empty account and deploys a Worker no customer can
reach; it changes nothing live but does spend money, so it needs your go-ahead
rather than a formal approval. **Step 7 needs `APPROVE LIVE CHANGE`**, once per
region, with its own window.

The standing hold of 8 October 2026 remains in force until you lift it in
writing.

## 4. Next action

Answer **A1** (the repository) and **A3** (the Freshchat exports). A1 unblocks
meaningful CI and a sane working tree; A3 unblocks everything about replacing
the live service.

Meanwhile, say the word and I will do **B1–B3**, which needs nothing from you
and touches nothing live.
