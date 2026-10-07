# Change note — webhook hostname for ABC Cargo Engage

**Status:** Prepared. Not executed. Blocked on prerequisites listed in §4.
Cannot be executed from the preparing session at all — see §4.5.
**Prepared by:** ABC Cargo IT Department
**Approval held:** `APPROVE LIVE CHANGE` given by the Head of IT, 7 October 2026.
**Date prepared:** 7 October 2026

---

## 1. Executive summary

ABC Cargo Engage needs one stable public hostname. Meta stores a single
callback URL per WhatsApp Business Account and re-verifies it continuously; if
that URL moves, inbound messages on all three numbers stop arriving. The
proposal is a single proxied hostname, `engage.abccargosupport.com`, attached
directly to the Cloudflare Worker.

The approval to make this change is held. The change has **not** been made,
because three prerequisites are unmet — see §4. Executing it today would create
a public hostname resolving to nothing, on a domain that is already live.

## 2. Business requirement

| Requirement                       | Why                                                                   |
| --------------------------------- | --------------------------------------------------------------------- |
| One hostname, never changing      | Meta allows one callback URL per WABA and re-verifies it continuously |
| Owned by ABC Cargo, not a vendor  | Freshworks currently owns the endpoint; that is what we are ending    |
| TLS terminated by Cloudflare      | Meta refuses a callback URL without a valid certificate               |
| Separable from the public website | A fault on the website must not take WhatsApp down, and the reverse   |

## 3. Proposed change

| Item         | Value                                                           |
| ------------ | --------------------------------------------------------------- |
| Hostname     | `engage.abccargosupport.com`                                    |
| Record type  | Managed by Cloudflare as a Worker custom domain (proxied)       |
| Target       | Worker `abc-cargo-whatsapp-platform`                            |
| Zone         | `abccargosupport.com`                                           |
| Callback URL | `https://engage.abccargosupport.com/webhook`                    |
| Method       | `wrangler deploy`, using the `routes` block in `wrangler.jsonc` |

The `routes` block is already written into `wrangler.jsonc`, commented out,
with the reason for the comment stated inline. Uncommenting it and deploying
is the whole change: Cloudflare creates the DNS record and attaches the Worker
in one step, so the hostname never exists without something behind it.

Creating the record by hand in the Cloudflare dashboard is **not**
recommended. A hand-made record and a Worker route are two things that can
disagree; the `routes` block is one thing that cannot.

## 4. Prerequisites — why this is not executed yet

### 4.1 No Worker is deployed

The hostname's only purpose is to point at the Worker. Nothing named
`abc-cargo-whatsapp-platform` exists in any Cloudflare account reachable from
this session. The Workers visible are `keembridge-api-review`,
`flyanywhere-keembridge` and `digitalhak` — unrelated to ABC Cargo.

A hostname created now would resolve to an error page on a live ABC Cargo
domain, and would have to be removed and recreated later.

### 4.2 Account identified — and it is not the one this session can read

**Correction.** An earlier revision of this note recorded three unrelated
Workers (`keembridge-api-review`, `flyanywhere-keembridge`, `digitalhak`) and
raised the possibility that the intended account was a personal or mixed one.
Those Workers are in a _different_ account — the one the Claude Cloudflare
connector happens to be authorised for. They say nothing about ABC Cargo's
account, and the concern they raised is withdrawn.

The Head of IT has since identified the intended account directly:

| Property              | Value                                                      |
| --------------------- | ---------------------------------------------------------- |
| Account name          | `abc-cargo-whatsapp-platform`                              |
| workers.dev subdomain | `abc-cargo-whatsapp-platfor…`                              |
| Workers & Pages       | empty — "You have not created any projects yet"            |
| Plan                  | Workers Free (0 / 100,000 requests today, Upgrade offered) |

This is a dedicated ABC Cargo account, not a mixed one. That resolves the
data-control question: deploying here does not put a corporate service into a
personal account.

**It also means every read-only finding in this session describes the wrong
account.** The connector cannot see this account, so nothing here can be
verified from the preparing session — only from the dashboard or an
authenticated machine.

### 4.3 The zone status is unconfirmed

It is not established that `abccargosupport.com` is an active zone in
Cloudflare. If the domain's nameservers are elsewhere, the first change is a
nameserver migration for the entire domain — a materially larger and riskier
change than adding one subdomain, affecting website, email and any existing
records. That would need its own change note and its own approval.

### 4.4 The account is empty, and on the Free plan

Workers & Pages reports no projects, so the Worker, the D1 database, the queue
and the R2 bucket all still have to be created. Each is its own live change to
the Cloudflare account; the approval held covers the hostname only.

The account is on **Workers Free**. Checked against the Cloudflare
documentation, that is workable for a pilot but not for live customer traffic:

| Component       | On Workers Free                                                   | Verdict                                                       |
| --------------- | ----------------------------------------------------------------- | ------------------------------------------------------------- |
| Durable Objects | Available, **SQLite storage backend only**                        | Fine — `wrangler.jsonc` already declares `new_sqlite_classes` |
| Queues          | Available: 10,000 operations/day; **retention fixed at 24 hours** | Pilot only — see below                                        |
| D1              | Available on the free tier                                        | Fine for a pilot                                              |
| R2              | Free tier available, but R2 must be enabled on the account        | Needs enabling before first deploy                            |
| Requests        | 100,000 per day                                                   | Adequate for a pilot                                          |

**The queue retention limit is the one to watch at go-live.** On the Free plan
a message is held for 24 hours and the period cannot be raised. It takes three
operations to deliver one message, so 10,000 operations per day is roughly
3,300 inbound messages per day across all three numbers. If the consumer is
down for longer than 24 hours, queued customer messages are discarded rather
than delayed — acceptable while demonstrating, not acceptable once real
customers are on the platform.

The Workers Paid plan ($5/month minimum) raises retention to a configurable
4–14 days and the allowance to 1,000,000 operations a month. Moving to it
should be settled before cutover, not after.

### 4.5 Tooling limitation

Two independent limits apply:

- **No DNS capability.** The Cloudflare tools available in this session cover
  D1, KV, R2, Hyperdrive and Workers only. There is no zone or DNS record
  tool, so the record cannot be created from here under any approval.
- **No credential.** `wrangler whoami` in this environment reports no
  authenticated account, so `wrangler deploy` cannot run from here either. No
  API token has been requested and none should be pasted into this session.

The change must therefore be executed by the Head of IT, either by
`wrangler deploy` from an authenticated ABC Cargo machine or by hand in the
Cloudflare dashboard, following §3 and §8.

## 5. Risk and business impact

| Risk                                                      | Severity | Mitigation                                                       |
| --------------------------------------------------------- | -------- | ---------------------------------------------------------------- |
| Hostname created with no Worker behind it                 | Low      | Do not create it separately; let `wrangler deploy` create both   |
| Deployment into the wrong Cloudflare account              | High     | Confirm account ownership first (§4.2)                           |
| Nameserver migration attempted as if it were a small edit | High     | Treat as a separate change with its own note and approval        |
| Typo in the hostname                                      | Medium   | Hostname is held in version control, not typed at execution time |
| Existing records on the zone disturbed                    | Low      | A new subdomain; no existing record is read, changed or removed  |

**No impact on live WhatsApp service.** Freshworks continues to hold the Meta
callback URL until it is deliberately changed. Creating this hostname does not
move it, and does not interrupt the UAE, KSA or UK numbers.

## 6. Rollback

| Step                                | Action                                                                      |
| ----------------------------------- | --------------------------------------------------------------------------- |
| Undo the hostname                   | Remove the custom domain from the Worker; Cloudflare removes the DNS record |
| Undo the deployment                 | `wrangler rollback`, or delete the Worker                                   |
| Undo the configuration              | Re-comment the `routes` block and redeploy                                  |
| Time to roll back                   | Minutes; DNS propagation of a proxied record is immediate                   |
| Effect of rollback on live WhatsApp | None — the live service never depended on this hostname                     |

## 7. Security

- The hostname is proxied, so the Cloudflare origin is never exposed.
- TLS is issued and renewed by Cloudflare; no certificate is held locally.
- `/webhook` verifies Meta's HMAC-SHA256 signature on every POST
  (`src/index.ts`); an unsigned request is rejected before it reaches any
  handler.
- The Meta app secret and access token are Worker secrets, never committed and
  never printed.
- Cloudflare Access should be placed in front of `/api/*` before any agent
  console is exposed. That is a separate change.

## 8. Verification and testing

Run in order after deploying, before the Meta callback URL is touched:

1. `curl -sS -o /dev/null -w '%{http_code}\n' https://engage.abccargosupport.com/webhook`
   — expect `403`, proving the signature check is live and the route resolves.
2. Repeat the Meta GET verification handshake with the correct verify token —
   expect the challenge echoed back.
3. Send an unsigned POST — expect it rejected, and expect no queue message.
4. Confirm the certificate's issuer and expiry on the hostname.
5. Confirm the three previously existing records on `abccargosupport.com` are
   unchanged, by comparing against a record list taken before the change.

Only once all five pass should the Meta callback URL be considered for change —
and that is a separate live change, with its own approval, because it is the
step that moves live customer traffic off Freshworks.

## 9. Next action

Three answers are needed from the Head of IT before this can be executed:

1. Does `abccargosupport.com` appear under **Domains** in the
   `abc-cargo-whatsapp-platform` account? If it does not, the first change is
   a nameserver migration for the whole domain, which is not covered by the
   approval held.
2. Confirm `engage.abccargosupport.com`, or name a different hostname.
3. Should the account move to Workers Paid before cutover, given the 24-hour
   queue retention limit in §4.4?

With those, the remaining work is to deploy the Worker and uncomment the
`routes` block. The approval already given covers this change as scoped above;
it does not cover a nameserver migration, deploying into an unrelated
Cloudflare account, or changing the Meta callback URL.
