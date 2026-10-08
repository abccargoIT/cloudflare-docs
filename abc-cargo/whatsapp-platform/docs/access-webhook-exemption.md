# Exempting the Meta webhook from Cloudflare Access — prepared procedure

**Status:** **PREPARED, NOT EXECUTED.** This is a plan. Nothing in Cloudflare
has been changed. Execution needs its own `APPROVE LIVE CHANGE` and belongs in
the cutover window, not before it. See §12.
**Prepared by:** ABC Cargo IT Department
**Date:** 8 October 2026
**Requested by:** Head of IT — "exclude /webhooks/whatsapp from Access"

---

## 1. Executive summary

The request is correct in substance and premature in timing.

It is correct because Meta's servers cannot log in. Cloudflare Access puts an
identity check in front of `engage.abccargosupport.com`, and every request to
that hostname — including a webhook POST from Meta — is answered with a 302 to
`white-rice-9a5e.cloudflareaccess.com`. Meta does not follow that redirect. It
sees a non-200 response, retries, and after repeated failures Meta disables the
webhook subscription on the WhatsApp Business Account. So on the day a number is
cut over, the exemption is mandatory.

It is premature because the Worker currently deployed on that hostname is the
demonstration Worker, and the demonstration Worker has no webhook route at all.
`abc-cargo-engage-demo` answers exactly three paths — `/`, `/demo` and
`/health` — and returns 404 for everything else. Opening `/webhooks/whatsapp`
to the public internet today therefore protects no traffic, enables no
integration and fixes no fault. It only removes an authentication control from
a path that does not exist.

The recommendation is to prepare the change now, in this document, and apply it
as a numbered step inside the cutover runbook — immediately before the callback
URL is saved in the Meta App dashboard, not weeks ahead of it.

## 2. Business requirement

WhatsApp message delivery for a cut-over number depends on Meta being able to
POST to ABC Cargo's callback URL. Without the exemption the first cut-over
attempt fails, and it fails in a way that is invisible until a customer
complains that nobody answered.

## 3. Scope

In scope: the Cloudflare Access configuration for the single hostname
`engage.abccargosupport.com`, and two paths beneath it.

Out of scope: the Access policy protecting the agent application itself, which
must remain unchanged; DNS; the Worker code; any Meta configuration.

## 4. Environment

| Item                            | Value                                        |
| ------------------------------- | -------------------------------------------- |
| Hostname                        | `engage.abccargosupport.com`                 |
| Access team domain              | `white-rice-9a5e.cloudflareaccess.com`       |
| Currently deployed Worker       | `abc-cargo-engage-demo` (demonstration only) |
| Worker that needs the exemption | `abc-cargo-whatsapp` (not yet deployed)      |
| Paths to exempt                 | `/webhooks/whatsapp`, `/webhooks/teams`      |

## 5. Findings

**5.1 — There are two webhook paths, not one.** `src/index.ts` declares
`WEBHOOK_PATH = "/webhooks/whatsapp"` and `TELEPHONY_PATH = "/webhooks/teams"`.
The second is the Microsoft Graph receiver for Teams call notifications. Graph
cannot log in to Access either. Exempting only the WhatsApp path leaves the
telephony integration broken in exactly the same way, so the exemption should
cover `/webhooks/*` and be done once.

**5.2 — Neither path is unauthenticated once exempted.** Removing Access does
not make these endpoints open. Both carry their own authentication, in the
Worker, ahead of any write:

- WhatsApp POST — `verifyMetaSignature` checks the `X-Hub-Signature-256`
  HMAC-SHA256 against the app secret, with a timing-safe comparison. A request
  without a valid signature gets `401 Invalid signature` and is not parsed.
- WhatsApp GET — the `hub.verify_token` must match before `hub.challenge` is
  echoed. This is the subscription handshake and is required by Meta.
- Teams POST — the `clientState` secret agreed at subscription time must match.
  A batch is accepted or rejected whole; one valid notification does not vouch
  for a forged one beside it. Failure returns a deliberately terse `401`.

This is the point that makes the change acceptable. Access is being removed
from a path that defends itself. It is not being removed from the agent
console.

**5.3 — The exemption must be a separate Access application, not a policy on
the existing one.** Cloudflare's documented pattern for this is a second
self-hosted application scoped to the narrower path, carrying a Bypass policy.
Adding a Bypass policy to the existing hostname-wide application would bypass
Access for the whole console.

**5.4 — Bypass is not logged.** Cloudflare's own warning: "Bypass does not
enforce any Access security controls and requests are not logged." Request
visibility for these two paths therefore comes from Workers observability
(already enabled) and from the Worker's own rejection counts, not from the
Access audit log. That is acceptable for a machine-to-machine endpoint, but it
should be a conscious choice rather than a surprise during an audit.

**5.5 — Service Auth is the alternative, and it does not fit.** Cloudflare
recommends Service Auth over Bypass where logging matters, because it keeps
policy evaluation and logging while skipping interactive login. It requires the
caller to send `CF-Access-Client-Id` and `CF-Access-Client-Secret` headers.
Meta's webhook sender cannot be configured to send arbitrary headers, so
Service Auth is not available for this endpoint. Bypass is the only workable
action. This was checked rather than assumed.

## 6. Risk and business impact

| Risk                                                                           | Severity | Mitigation                                                                                                          |
| ------------------------------------------------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------- |
| Bypass applied to the hostname instead of the path, exposing the agent console | **High** | Create a _new_ application scoped to the path. Verify `/` still redirects to login before declaring the step done.  |
| Path typed wrongly, so Meta still hits Access and the cutover fails silently   | Medium   | Verification step 11.2 proves a 200 from the exempt path and a 302 from `/`.                                        |
| Exemption applied now, long before cutover                                     | Medium   | Do not apply it now. It is a cutover step.                                                                          |
| Endpoint scanned and probed once public                                        | Low      | Signature verification rejects unsigned requests before parsing. Workers observability retains the rejection count. |
| Teams path forgotten                                                           | Low      | Scope the application to `/webhooks/*`.                                                                             |

Doing nothing until cutover carries no risk, because nothing depends on the
path today.

## 7. Proposed change

Create one additional Access application and one policy. Change nothing on the
existing application.

**New application**

| Field  | Value                                 |
| ------ | ------------------------------------- |
| Type   | Self-hosted                           |
| Name   | `ABC Cargo Engage — inbound webhooks` |
| Domain | `engage.abccargosupport.com`          |
| Path   | `webhooks/*`                          |

**Its only policy**

| Action | Rule type | Selector | Value    |
| ------ | --------- | -------- | -------- |
| Bypass | Include   | Everyone | Everyone |

Bypass policies cannot carry identity-based selectors, which is why the rule
reads as it does. Cloudflare evaluates Bypass and Service Auth policies before
Allow and Block, and selects the application with the most specific matching
destination, so the path-scoped application wins for `/webhooks/...` while the
hostname-wide application continues to protect everything else.

## 8. Steps for the Head of IT

These are for the Head of IT to perform. **ABC Cargo IT Department holds no
Cloudflare credential for this account and cannot perform them** — see §12.

One step at a time, with the expected result stated, per the GUI
troubleshooting standard.

1. Cloudflare dashboard → **Zero Trust** → **Access controls** →
   **Applications**.
   _Expected:_ the existing `engage.abccargosupport.com` application is listed.
   Do not open it.
2. **Add an application** → **Self-hosted**.
   _Expected:_ the application configuration form opens.
3. **Application name:** `ABC Cargo Engage — inbound webhooks`
4. Under **Public hostname**, enter domain `engage.abccargosupport.com` and
   path `webhooks/*`.
   _Expected:_ the summary shows `engage.abccargosupport.com/webhooks/*`.
   Screenshot this before continuing.
5. Continue to **Policies** → **Create new policy**.
   **Action:** `Bypass`. **Rule type:** `Include`. **Selector:** `Everyone`.
   _Expected:_ no email or group fields are offered. That absence is correct for
   a Bypass policy.
6. Save the policy, then save the application.
   _Expected:_ two applications are now listed for that hostname.

Then run the verification in §11 before telling anyone the step is done.

## 9. Rollback

Delete the `ABC Cargo Engage — inbound webhooks` application. Access reverts to
the hostname-wide application within seconds and `/webhooks/*` returns to
redirecting to login. The existing application is never edited, so there is
nothing to restore and no backup to take.

Rollback is immediate and complete. This is the main reason the change is low
risk once correctly scoped.

## 10. Security implications

Stated plainly, because this is the part a reviewer will ask about:

- Two paths move from "Access-protected" to "protected only by the Worker's own
  signature and shared-secret checks".
- Those checks run before any parsing or any write, and use timing-safe
  comparison.
- Requests to those two paths stop appearing in the Access audit log.
- The agent console, the API routes and every other path keep the Access
  identity check unchanged.
- No credential is created, moved or exposed by this change. No API token, app
  secret or verify token appears in this document or in the steps above.

## 11. Verification and testing plan

Run all three. Step 11.1 is the one that catches the dangerous mistake.

**11.1 — The console is still protected.** From a browser with no Access
session, or with `curl`:

```
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' https://engage.abccargosupport.com/
```

_Expected:_ `302` to `white-rice-9a5e.cloudflareaccess.com/...`. **If this
returns 200, the Bypass has been applied to the hostname instead of the path.
Roll back immediately per §9.**

**11.2 — The webhook path is reachable.**

```
curl -s -o /dev/null -w '%{http_code}\n' https://engage.abccargosupport.com/webhooks/whatsapp
```

_Expected, against the demonstration Worker:_ `404` — reaching the Worker and
being told the route does not exist is the proof that Access is out of the way.
_Expected, against the platform Worker:_ `400` or `403` from the Worker's own
handler. Any `302` means the exemption is not in effect.

**11.3 — An unsigned POST is rejected by the Worker.** Against the platform
Worker only:

```
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  -H 'content-type: application/json' --data '{}' \
  https://engage.abccargosupport.com/webhooks/whatsapp
```

_Expected:_ `401`. This proves the signature check is the control now doing the
work. If this returns `202`, stop the cutover — the endpoint is accepting
unauthenticated writes and that is a far more serious finding than the Access
question.

## 12. Approval

**Not approved and not requested yet.**

Two separate reasons this has not been done:

1. **No credential.** ABC Cargo IT Department holds no Cloudflare API token or
   dashboard session for this account. `wrangler` has been confirmed twice to
   refuse non-interactively without one. Access applications are configured in
   the Zero Trust dashboard or the Access API — `wrangler` does not manage them
   at all — so even with a Worker credential this would not be possible from
   here.
2. **Standing hold and approval scope.** The Head of IT instructed on
   8 October 2026: "dont change any live". The one exception granted was
   `APPROVE LIVE CHANGE for DEMO`, which covered deploying the demonstration
   Worker. It does not extend to editing a production Zero Trust
   configuration.

When this is to be executed, the approval phrase required is
`APPROVE LIVE CHANGE` for this document specifically.

## 13. Status

Prepared. Reviewed against current Cloudflare documentation on 8 October 2026
(Access policy actions and order of execution; application destination
specificity). Not executed.

## 14. Next action

Fold §8 into the Stage B cutover runbook as the step immediately before the
callback URL is saved in the Meta App dashboard, and run §11 straight after it.

Until a number is actually being cut over, no action is needed and none should
be taken.
