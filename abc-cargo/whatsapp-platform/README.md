# ABC Cargo WhatsApp customer communication platform

Starter implementation of a WhatsApp customer communication service for
ABC Cargo, built on Cloudflare Workers and the Meta WhatsApp Business
Platform (Cloud API). It supports several regional business numbers under one
WhatsApp Business Account (WABA), human agents during working hours, and
automated replies when the team is offline.

Read `docs/architecture-and-implementation-plan.md` first. This README covers
the code only.

## What is implemented

| Area                 | File                         | Notes                                                                     |
| -------------------- | ---------------------------- | ------------------------------------------------------------------------- |
| Webhook verification | `src/index.ts`               | GET challenge handshake and HMAC-SHA256 signature check on every POST     |
| Fast acknowledgement | `src/index.ts`, `src/queue/` | Payload split per change and pushed to a Queue; Meta gets 200 at once     |
| Per-thread state     | `src/conversation.ts`        | Durable Object per (business number, customer): window, assignment        |
| 24-hour window rule  | `src/conversation.ts`        | Free-form replies blocked once the window closes; templates still allowed |
| Automated replies    | `src/auto-reply.ts`          | Outside hours or no agent online; cooldown to avoid repeats               |
| Region routing       | `src/regions.ts`             | Phone number ID to region, timezone and working hours                     |
| Graph API client     | `src/whatsapp/client.ts`     | Text, template, interactive buttons, mark-as-read, media download         |
| Persistence          | `src/db/`                    | D1 schema and repository (contacts, conversations, messages, audit)       |
| Media                | `src/conversation.ts`        | Inbound media copied to R2 before Meta's short-lived link expires         |
| Internal API         | `src/index.ts`               | Endpoints for an agent console: list, read, reply, assign, template       |

Not implemented yet: the agent console user interface, agent login and
roles (use Cloudflare Access in front of `/api/*`), AI-assisted drafting,
reporting, and integration with ABC Cargo shipment systems.

## Interactive demo

`demo/index.html` is a self-contained simulation of the platform for people who want to see
the behaviour rather than read about it. Open the file in a browser; it needs no build step,
no server and no network access to Meta or Cloudflare.

It shows three panes side by side: the customer's WhatsApp thread, the agent console, and a
live trace of every stage the real pipeline runs, labelled with the source file that does the
work. The controls change the conditions the platform actually reacts to.

| Control         | What it demonstrates                                                              |
| --------------- | --------------------------------------------------------------------------------- |
| Business number | Region routing across the three WhatsApp numbers, each with its own working hours |
| Simulated clock | The out-of-hours automatic reply, and the 24-hour service window expiring         |
| Agents on shift | The "all agents busy" automatic reply and its cooldown                            |
| Reset demo      | Returns the sample conversations to their starting state                          |

The conversations, names and shipment references are sample data. Region 2 and Region 3 are
placeholders until the number details are confirmed in WhatsApp Manager.

## Layout

```
src/
  index.ts              HTTP router, webhook endpoints, internal API, queue export
  env.ts                Bindings, variables and secret names
  conversation.ts       Conversation Durable Object
  regions.ts            Region configuration parsing
  business-hours.ts     Timezone-aware working-hours check
  auto-reply.ts         Rule-based automated replies
  queue/consumer.ts     Queue consumer: routes events to Durable Objects / D1
  whatsapp/             Cloud API client, webhook types, signature verification
  db/repo.ts            D1 data access
  db/migrations/        D1 schema
test/                   Node test runner suites for the pure modules
docs/                   Architecture and implementation plan
```

## Local development

Requires Node.js 22.18 or newer.

```sh
npm install
cp .dev.vars.example .dev.vars   # then fill in local-only values
npm run typecheck
npm test
npm run lint
npm run format:check
```

To run the Worker locally with Wrangler, create the local D1 schema first:

```sh
npm run db:migrate:local
npm run dev
```

Expose the local port with a tunnel (for example `cloudflared tunnel`) to
test webhook delivery from Meta against a test number.

## Configuration

Plain variables live in `wrangler.jsonc` under `vars`:

- `REGION_NUMBERS`: JSON array with one entry per business number. Replace
  every `REPLACE_ME` and placeholder number before deploying.
- `GRAPH_API_VERSION`: Meta Graph API version.
- `AUTO_REPLY_COOLDOWN_HOURS`: minimum gap between automated replies to the
  same customer.
- `TRACKING_URL`: optional public tracking link used in automated replies.

Secrets are set with `wrangler secret put` and never committed:

- `WHATSAPP_ACCESS_TOKEN`
- `WHATSAPP_APP_SECRET`
- `WHATSAPP_VERIFY_TOKEN`
- `INTERNAL_API_KEY`

## Internal API

All `/api/*` routes require `Authorization: Bearer <INTERNAL_API_KEY>`.

| Method | Path                            | Body                                                   |
| ------ | ------------------------------- | ------------------------------------------------------ |
| GET    | `/api/conversations`            | query: `region`, `status`, `agent`, `limit`            |
| GET    | `/api/conversations/:id`        | query: `limit`                                         |
| POST   | `/api/conversations/:id/reply`  | `{ "agentId": "...", "text": "..." }`                  |
| POST   | `/api/conversations/:id/assign` | `{ "agentId": "..." \| null, "actor": "..." }`         |
| POST   | `/api/conversations/:id/status` | `{ "status": "open\|pending\|resolved", "actor" }`     |
| POST   | `/api/notifications/template`   | `{ "region", "to", "requestedBy", "template": {...} }` |
| POST   | `/api/agents/:id/presence`      | `{ "status": "online\|away\|offline" }`                |

Conversation ids have the form `<phone_number_id>:<customer_wa_id>` and must
be URL-encoded in paths.

A reply outside the 24-hour window returns HTTP 409. Use the template
endpoint instead.
