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

### 4.2 The Cloudflare account appears to be the wrong one

The account reachable from this session holds the three Workers named above.
That is not an "ABC Cargo Engage" account. Under ABC Cargo's own data-control
rules, a corporate production service must not be deployed into a personal or
unrelated account, and corporate systems must not be connected to a personal
Claude account.

**Required before proceeding:** confirmation of which Cloudflare account owns
`abccargosupport.com`, and that the Worker will be deployed into that same
account. A Worker in one account cannot take a route on a zone in another.

### 4.3 The zone status is unconfirmed

It is not established that `abccargosupport.com` is an active zone in
Cloudflare. If the domain's nameservers are elsewhere, the first change is a
nameserver migration for the entire domain — a materially larger and riskier
change than adding one subdomain, affecting website, email and any existing
records. That would need its own change note and its own approval.

### 4.4 The account is not provisioned for this platform

Read-only inspection of the Cloudflare account reachable from this session:

| Resource required by the Worker      | State in that account                   |
| ------------------------------------ | --------------------------------------- |
| D1 database                          | None exist                              |
| R2 bucket                            | R2 is not enabled on the account at all |
| Queue                                | Not created                             |
| Durable Object namespace             | Not created (comes with the deployment) |
| Worker `abc-cargo-whatsapp-platform` | Does not exist                          |

An account with R2 switched off and no D1 database is not an account that has
been prepared for this platform. Provisioning those is a separate set of live
changes to the Cloudflare account, each needing its own approval; the approval
held covers the hostname only.

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

1. Which Cloudflare account owns `abccargosupport.com`, and is
   `abccargosupport.com` already an active zone in it?
2. Is "ABC Cargo Engage" a new Cloudflare account, or the intended Worker
   name? If it is a new account, which account holds the domain?
3. Confirm `engage.abccargosupport.com`, or name a different hostname.

With those, the remaining work is to deploy the Worker and uncomment the
`routes` block. The approval already given covers this change as scoped above;
it does not cover a nameserver migration, deploying into an unrelated
Cloudflare account, or changing the Meta callback URL.
