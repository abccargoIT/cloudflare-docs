# Deployment runbook — ABC Cargo Engage

**Status:** **Stage A approved by the Head of IT, 7 October 2026**
("UK DEMO APPROVE LIVE CHANGE"). Not yet executed — see §9.
Stage B remains unapproved and has no change note.
**Prepared by:** ABC Cargo IT Department
**Date:** 7 October 2026

---

## 1. Executive summary

`engage.abccargosupport.com` resolves through Cloudflare and returns an error
page, because nothing is deployed behind it. This runbook takes it from there to
a Worker answering on that hostname.

The work splits into two stages, and the split is the point of this document.

**Stage A touches nothing live.** It creates four empty resources in a new,
empty Cloudflare account and deploys a Worker that no customer can reach,
because Meta still points at Freshworks and will continue to. At the end of
Stage A the hostname answers, TLS is valid and the Custom Domain is attached.
Nothing about ABC Cargo's live WhatsApp service changes.

**Stage B is the cutover**, and it is the step that moves live customer
traffic. It is out of scope here and needs its own approval, its own window and
its own rollback rehearsal.

Running Stage A does not commit ABC Cargo to Stage B. If the platform is never
deployed further, deleting four resources removes every trace.

## 2. Scope

| In scope (Stage A)                               | Out of scope (Stage B)                      |
| ------------------------------------------------ | ------------------------------------------- |
| Create D1 database `abc-whatsapp`                | Changing the Meta callback URL              |
| Create R2 bucket `abc-whatsapp-media`            | Moving any number off Freshworks            |
| Create queues `abc-whatsapp-webhooks` and `-dlq` | Granting Microsoft Graph tenant permissions |
| Apply the database schema                        | Any CRM connection                          |
| Record the database id in `wrangler.jsonc`       | Agent console exposure                      |
| Deploy the Worker and attach the Custom Domain   | Workers Paid upgrade                        |

## 3. Prerequisites

1. A machine signed in to the ABC Cargo Cloudflare account — `wrangler login`,
   then `npx wrangler whoami` showing `abc-cargo-whatsapp-platform`.
2. Node.js 22 or newer.
3. **R2 enabled on the account.** It is not enabled today. It is switched on
   once, in the dashboard under R2, and the script stops with a clear message
   if it is still off.
4. Written approval for Stage A.

Not required for Stage A, and deliberately so: the Meta phone number IDs, the
Meta secrets, and any decision about the CRM. The Worker deploys and answers
without them.

## 4. Stage A — procedure

### 4.1 Dry run

```powershell
.\tools\provision-cloudflare.ps1 -WhatIf
```

Changes nothing. It prints the signed-in account and stops. **Read that
account name.** If it is not `abc-cargo-whatsapp-platform`, stop here.

### 4.2 Provision

```powershell
.\tools\provision-cloudflare.ps1
```

Creates the database, bucket and both queues, writes the new database id into
`wrangler.jsonc` keeping a `.bak`, applies the schema, then re-reads everything
and prints a present/missing table. It is safe to run more than once: each step
checks first and skips rather than failing, so an interrupted run is simply
repeated.

Commit the `wrangler.jsonc` change. The database id is configuration, not a
secret.

### 4.3 Deploy

```powershell
npx wrangler deploy --dry-run
npx wrangler deploy
```

The dry run must pass first. The real deploy creates the Worker and, because
`wrangler.jsonc` carries the `routes` block, attaches
`engage.abccargosupport.com` as its Custom Domain. Cloudflare takes over the
DNS record and issues the certificate.

### 4.4 Verify

```powershell
curl.exe -s https://engage.abccargosupport.com/health
```

Expect `{"ok":true}`.

```powershell
curl.exe -s -o NUL -w "%{http_code}`n" https://engage.abccargosupport.com/webhooks/whatsapp
```

Expect **403**. That is the signature check refusing an unsigned request, and
it is the single most important result in this runbook: it proves the endpoint
is live _and_ that it rejects anything not signed by Meta.

Then confirm, in the dashboard: the certificate is issued and valid; the
placeholder A record has been replaced by the Custom Domain; and the three
pre-existing records on `abccargosupport.com` are untouched.

## 5. What is deliberately deferred

| Item                  | Why it waits                                                                                                                     |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| The four secrets      | Not needed to prove the hostname. Set them when the cutover is scheduled                                                         |
| Real phone number IDs | Still outstanding from Meta WhatsApp Manager                                                                                     |
| Meta callback URL     | Stage B. This is the step that moves customer traffic                                                                            |
| Workers Paid upgrade  | Nothing to pay for until traffic exists. Settle before cutover, because the Free plan's 24-hour queue retention cannot be raised |

A Worker deployed without secrets and with placeholder phone numbers answers
`/health`, rejects unsigned webhooks, and does nothing else. That is exactly
what Stage A is for.

## 6. Risk

| Risk                                          | Severity | Mitigation                                          |
| --------------------------------------------- | -------- | --------------------------------------------------- |
| Provisioned into the wrong Cloudflare account | High     | §4.1 prints the account and stops                   |
| Live WhatsApp service interrupted             | **None** | Meta still points at Freshworks throughout          |
| Existing DNS records on the zone disturbed    | Low      | Only the `engage` hostname is touched               |
| Schema applied to the wrong database          | Low      | The script applies it by name to the one it created |
| Cost                                          | Low      | Free plan; the resources are empty                  |

## 7. Rollback

Reversible at every point, and nothing depends on the order.

| To undo                   | Action                                                             |
| ------------------------- | ------------------------------------------------------------------ |
| The deployment            | `npx wrangler delete`, or remove the Custom Domain from the Worker |
| The hostname              | Removing the Custom Domain removes the DNS record with it          |
| The configuration         | Restore `wrangler.jsonc` from the `.bak` the script wrote          |
| The resources             | Delete the database, bucket and queues in the dashboard            |
| **Live WhatsApp service** | **Nothing to undo. It was never changed.**                         |

## 8. Approval

Stage A changes the ABC Cargo Cloudflare account and therefore needs
`APPROVE LIVE CHANGE` from the Head of IT before §4.2 is run.

Stage B — the Meta callback URL, and the per-region cutover behind it — is a
separate change with its own note, its own approval and its own window. It is
not authorised by approving this one.

---

## 9. Approval record and scope — 7 October 2026

The Head of IT gave `APPROVE LIVE CHANGE`, prefixed "UK DEMO".

### 9.1 What this is taken to authorise

**Stage A, in full**, as set out in §2 and §4: creating the D1 database, the R2
bucket and the two queues in the `abc-cargo-whatsapp-platform` account,
applying the schema, recording the database id, deploying the Worker, and
attaching `engage.abccargosupport.com` as its Custom Domain.

### 9.2 What it is NOT taken to authorise

**Changing the Meta callback URL, for the UK number or any other.** That is
Stage B. It is the step that moves live customer traffic, and it has no change
note yet — so there is nothing describing its risk, rollback or verification
for an approval to attach to. ABC Cargo's own rule is that the change note
comes before the approval, not after.

The UK number `+447388800000` is live in Freshchat today and stays there.

This reading is deliberately the narrow one. "UK DEMO" reads as _deploy so the
UK can be demonstrated_, not _cut the live UK number over_, and the difference
between those two is an interruption to UK customer service. If the intent was
the wider one, it needs a Stage B note first; approving this one does not
reach it.

### 9.3 A demonstration does not need the live number

Worth settling before anyone assumes otherwise. There are three ways to show
the UK working, in increasing order of risk:

| Option                                                   | Touches live service | What it proves                                  |
| -------------------------------------------------------- | -------------------- | ----------------------------------------------- |
| `demo/app.html`                                          | No                   | The whole product, offline, on any laptop       |
| Stage A deployment + a **test** number added to the WABA | No                   | The real Worker, real Meta delivery, end to end |
| Moving `+447388800000`                                   | **Yes**              | Nothing the test number has not already proven  |

The middle option is the one to use for a live demonstration. A test number
added to the WABA receives real WhatsApp messages through the real pipeline,
while the three business numbers stay on Freshworks untouched. It proves
everything the cutover would, and costs nothing if it fails.

Recommendation: do not move `+447388800000` to demonstrate it. Move it when the
bot conversation flows have been exported and the cutover has been rehearsed —
not to satisfy a demonstration.

### 9.4 Execution

Stage A cannot be run from the preparation environment: there is no Cloudflare
credential here and no deployment capability, as recorded in the subdomain
change note §4.5. It runs on a machine signed in to the ABC Cargo account,
following §4.

Before §4.2, R2 must be enabled once on the account. It is not enabled today.
