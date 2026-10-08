# Engage — deploying the demonstration to engage.abccargosupport.com

**Prepared by:** Head of IT, ABC Cargo IT Department
**Date:** 8 October 2026
**Approval:** `APPROVE LIVE CHANGE for DEMO`, given 8 October 2026
**Status:** Prepared and dry-run verified. **Not deployed** — see §3.

---

## 1. What is being deployed, and what is not

A separate Worker, `abc-cargo-engage-demo`, built from `src/demo-only.ts` and
configured by `wrangler.demo.jsonc`. It serves the training demonstration at
`/` and refuses everything else.

The approval given was for the demonstration, and the safest way to honour that
is to deploy something **incapable** of anything more rather than something
capable but configured not to. So this deployment declares:

|                  |          |
| ---------------- | -------- |
| D1 database      | **none** |
| R2 bucket        | **none** |
| Queues           | **none** |
| Durable Objects  | **none** |
| Meta credentials | **none** |
| API routes       | **none** |
| Webhook route    | **none** |

The dry run confirms it: the only binding is `DEPLOY_NOTE`, a label. There is
no configuration mistake, no stray route and no later edit to `src/index.ts`
that could make this reach a customer, because the parts that could are not
deployed with it.

Upload size: **117.73 KiB, 31.71 KiB gzipped.**

## 2. What the page is

The single-file demonstration, which runs the platform's own compiled
TypeScript. It covers Inbox, Leads and quotations, Tickets, Bookings, Calls and
Overview across the three regions. It makes no network call of any kind: all
records live in the browser tab.

It does **not** yet cover the bot runtime, dashboard, broadcasts, composer,
team chat, contacts board or setup.

## 3. Why I have not run it

Two reasons, both factual rather than cautious:

1. **This environment has no Cloudflare credentials.** `CLOUDFLARE_API_TOKEN`
   and `CLOUDFLARE_ACCOUNT_ID` are unset, there is no stored authorisation
   (`wrangler whoami` reports "not authenticated"), and `wrangler login` needs
   an interactive browser this container does not have.
2. **The deploy should carry your identity, not a token pasted into a
   transcript.** Four commands run by you keeps the credential off this record
   entirely.

## 4. The commands

Run from `abc-cargo/whatsapp-platform`.

```bash
# 1. Authenticate. Opens a browser; approve the account that owns
#    abccargosupport.com (account id 7f853cd4...).
npx wrangler login

# 2. Confirm you are on the right account before anything is created.
npx wrangler whoami

# 3. Check what will be uploaded. Nothing is published by this command.
#    Expect: "Total Upload: ~117 KiB" and one binding, DEPLOY_NOTE.
npx wrangler deploy --dry-run -c wrangler.demo.jsonc

# 4. Deploy.
npx wrangler deploy -c wrangler.demo.jsonc
```

Step 4 binds `engage.abccargosupport.com` to the Worker as a custom domain.
Cloudflare replaces the placeholder DNS record and issues the certificate
itself; the `192.0.2.0` A record you created is a reserved documentation
address that routes nowhere and is not needed once the custom domain is bound.

## 5. Verifying it

```bash
# The page itself.
curl -sI https://engage.abccargosupport.com/ | head -n 12

# Expect: HTTP/2 200, content-type text/html, x-robots-tag noindex.

# Nothing else is there. Both should answer 404.
curl -s -o /dev/null -w "api: %{http_code}\n"     https://engage.abccargosupport.com/api/conversations
curl -s -o /dev/null -w "webhook: %{http_code}\n" https://engage.abccargosupport.com/webhooks/whatsapp
```

Then open the page and check the three region tabs read **UAE, KSA, UK** with
the real numbers. If they read "Region 2" and "Region 3", an older build has
been deployed.

## 6. Risk, stated plainly

**It is a public URL with no authentication.** Anyone with the link can open
it. It carries invented customer records under ABC Cargo's name and branding.
The headers tell search engines to stay away (`noindex, nofollow, noarchive`)
but that is a request, not a control.

Nothing it contains can reach Meta, Freshworks, a live number or any ABC Cargo
system — there is no credential and no binding to reach them with.

**Recommendation:** put Cloudflare Access in front of the hostname before it is
circulated beyond the people who need it, and certainly before it ever carries
anything other than invented data. That is a separate change and I have not
made it.

## 7. Rollback

```bash
npx wrangler delete -c wrangler.demo.jsonc
```

Immediate, and destroys nothing — there is no data in this deployment to lose.
The hostname returns to serving nothing.

## 8. One thing to be careful of afterwards

`wrangler.jsonc` — the **main** platform configuration — also claims
`engage.abccargosupport.com`. Running `npx wrangler deploy` in this directory
without `-c wrangler.demo.jsonc` would take the hostname over and put the full
platform, including the Meta webhook route, on a public URL.

A warning comment now sits directly above that route. It is not disabled,
because that is your decision rather than mine, but it is the one accident
worth knowing about before somebody runs a deploy out of habit.

## 9. Status

Prepared, dry-run verified, committed and pushed. Awaiting the four commands in
§4, which need your Cloudflare login.

The standing hold on everything else — Meta, the WABA, the live numbers,
Freshworks, the remote database — remains in force. This approval covers the
demonstration only.
