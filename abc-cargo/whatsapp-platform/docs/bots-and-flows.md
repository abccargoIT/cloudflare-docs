# Engage — Bot runtime and conversation flows

**Prepared by:** Head of IT, ABC Cargo IT Department
**Date:** 8 October 2026
**Status:** Built and tested. Nothing published. No live system changed.

---

## 1. Executive summary

The bot module is built: flow storage, a step interpreter, publish-time
validation, a test preview, and the record of why the bot did what it did. It
runs the platform's own code, is covered by 36 tests, and is wired into the
inbound message path.

**It is switched off, and it switches itself off.** With no published flow for a
region, the inbound path behaves exactly as it did before this module existed —
the automated reply is sent from the Durable Object and nothing else happens.
The bot becomes active for a region only when somebody publishes a flow for that
region, which is a master-admin action and a live change.

**What is still blocked is the content, not the machinery.** ABC Cargo's three
live bots run in Freshchat on the UAE, KSA and UK numbers, and those three flows
have still not been exported. The runtime is now ready to receive them. Until
they arrive, what exists is a starter flow of realistic shape, clearly labelled
as not being any of the three live ones.

## 2. Business requirement

Each of the three WhatsApp numbers is currently fronted by its own 24-hour bot
in Freshchat. Moving a number to Engage without an equivalent flow would mean
customers messaging outside office hours receive a plain automated reply where
they previously received a working triage. That is a visible reduction in
service, and it is the reason the bot could not simply be left out of scope.

## 3. Scope

| In scope                             | Not in scope                                  |
| ------------------------------------ | --------------------------------------------- |
| Flow storage, versioning, publishing | Rebuilding the three live Freshchat flows     |
| The step interpreter and its rules   | Publishing anything to a live number          |
| Publish-time validation              | A model-driven or generative bot              |
| Test preview that sends nothing      | Email or voice channels                       |
| The audit record of each turn        | A visual flow editor (API only at this stage) |

## 4. What was built

| File                              | What it holds                                            |
| --------------------------------- | -------------------------------------------------------- |
| `src/bots/types.ts`               | What a flow, a step, a session and an effect are         |
| `src/bots/parse.ts`               | Turning a JSON document into a flow, or saying why not   |
| `src/bots/validate.ts`            | Everything that must be true before a flow goes live     |
| `src/bots/runtime.ts`             | The interpreter. Pure: decides, performs nothing         |
| `src/bots/preview.ts`             | A scripted conversation run through the same interpreter |
| `src/bots/service.ts`             | Flow and session storage, versioning, publish and retire |
| `src/bots/runner.ts`              | The only part that touches the outside world             |
| `src/bots/templates.ts`           | A starter flow — **not** any of the three live ones      |
| `src/db/migrations/0007_bots.sql` | `bot_flows`, `bot_sessions`, `bot_turns`                 |

### Step kinds

| Kind       | Behaviour                                                        |
| ---------- | ---------------------------------------------------------------- |
| `message`  | Sends text, carries on                                           |
| `ask`      | Sends a question, waits, keeps the answer in a named slot        |
| `menu`     | Sends numbered options, waits, branches on the reply             |
| `classify` | Branches on the platform's own intent classifier                 |
| `lookup`   | Branches on whether we hold the shipment the customer referenced |
| `create`   | Opens a lead or a ticket                                         |
| `handover` | Passes the conversation to an agent and ends the session         |
| `end`      | Finishes politely                                                |

## 5. The five rules that matter

These are the decisions worth reviewing, because each one exists because of a
specific thing that happens to customers on bot-fronted numbers.

### 5.1 A turn performs nothing

The interpreter reads a flow and a session and returns a list of effects. It
sends no message, writes no row and looks nothing up. The caller carries the
effects out.

This is what makes the test preview honest: it calls the same function a live
message goes through, rather than a second implementation that walks the step
graph in a similar way. A preview written the second way drifts from the real
thing, which is how a flow comes to behave one way in the builder and another
way in front of a customer.

### 5.2 Asking for a person always works

Checked on every turn, at whatever step the session is sitting on, whether or
not the flow's author thought of it. A flow with no handover step can still be
escaped.

The one exception is deliberate: if a menu option itself answers to "agent",
that option wins, because the author explicitly said what should happen.

On a number that takes damage claims this is the most important rule in the
module.

### 5.3 A menu gives up

After two answers it cannot use, the conversation goes to an agent rather than
printing the menu a third time. A good answer resets the count, so a typo is not
held against anybody.

The third identical menu is the point at which a customer stops replying and
starts telephoning, and nobody finds out why.

### 5.4 A broken flow is refused at publish time, not discovered at runtime

Refused: a step pointing at nothing, two steps sharing an id, a flow that starts
nowhere, a step with nothing to say, a message longer than WhatsApp accepts, a
menu with no options, two menu options answering to the same word, and a cycle
that never waits for the customer.

Warned about but published: an unreachable step, and a flow with no route to a
person. Half-finished work has to be saveable, or people edit the live version
instead.

A loop through a question or a menu is _not_ refused — that is how every menu
that returns to itself works.

As a backstop the runtime also carries a step budget, because a flow written
straight into the database never passes through the validator. Exceeding it
hands over with a plain apology; silence would be the worst possible answer.

### 5.5 Publishing does not move a customer mid-answer

A session records the version of the flow it started on and finishes on that
version. Published flows are never rewritten: editing one creates the next
version as a draft, and publishing that draft retires the one before it.

Without this, publishing a change moves a customer halfway through answering a
question into a different conversation — onto a step that may not exist in the
new version or, worse, that exists and means something else.

The database enforces one published flow per region through a partial unique
index, rather than relying on whoever wrote the publish path. Two published
flows for one number is a coin toss over which bot a customer meets.

## 6. Evidence

Verified on 8 October 2026 in this working copy. No remote and no live system
was touched.

| Check                                      | Result                                                       |
| ------------------------------------------ | ------------------------------------------------------------ |
| `npm run test`                             | **210 passed, 0 failed** (36 new)                            |
| `npm run typecheck`                        | Clean                                                        |
| `npm run lint`                             | Clean                                                        |
| `npm run format:check`                     | Clean                                                        |
| `wrangler deploy --dry-run`                | 322.73 KiB / 79.34 KiB gzip                                  |
| `wrangler d1 migrations apply --local`     | `0007_bots.sql` applied, 10 commands                         |
| Two published flows for one region (local) | **Refused** by the unique index                              |
| Retire-then-publish in one transaction     | **Succeeds** — old retired, new live                         |
| Publish-then-retire (the wrong order)      | **Refused** — which is why the code batches it the other way |

A correction worth recording: the first attempt at the publish test proved
nothing. Wrangler applies a `--file` as one transaction, so the file whose second
statement failed rolled back the first as well, leaving no published row for the
swap to contend with. The test was redone with the published row established in
a separate file, and only then did it demonstrate what it claimed.

## 7. API

Reading a flow and running a preview require only access to the region — that is
how a supervisor checks what a customer is being told. Saving and publishing are
master admin only.

| Method | Path                              | Who          |
| ------ | --------------------------------- | ------------ |
| GET    | `/api/bots/flows?region=`         | Region       |
| GET    | `/api/bots/flows/:flowId`         | Region       |
| GET    | `/api/bots/starter?region=`       | Region       |
| POST   | `/api/bots/preview`               | Region       |
| POST   | `/api/bots/drafts`                | Master admin |
| POST   | `/api/bots/flows/:flowId/publish` | Master admin |
| POST   | `/api/bots/unpublish`             | Master admin |
| GET    | `/api/bots/turns/:conversationId` | Region       |

A publish refused by validation answers **409**, not 400: the request was
well-formed and the refusal is about the state of the flow.

`/api/bots/unpublish` takes a region's bot out of service without deleting
anything. The platform then falls back to the automated reply and the agent
queue. This is the control to use if a flow turns out to be wrong on a live
number at two in the morning.

## 8. Risk

| Risk                                                           | Mitigation                                                                   |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| A rebuilt flow behaves differently from the live Freshchat one | The three flows must be exported and compared. Not yet possible              |
| A flow is published to a live number before it is approved     | Master admin only; and the standing hold means no publish at all for now     |
| A customer is trapped in a flow                                | The escape hatch, the menu give-up rule, and the step budget — all three     |
| A customer mid-conversation meets a different bot              | Sessions pinned to their flow version                                        |
| A bot answers a webhook Meta has already delivered             | A duplicate webhook does not advance the flow; the session cannot move twice |
| The shipment system is unreachable                             | The lookup takes the "not found" branch, which reaches a person              |

## 9. What is still required from the business

1. **The three Freshchat flow exports** (`ABC Cargo`, `ABC Cargo KSA`,
   `ABC Cargo UK`). The largest outstanding item on the project. Without them a
   cutover either drops the bot or replaces it with something nobody has
   approved.
2. **A retention decision for `bot_turns` and the answers held in
   `bot_sessions`.** These are the customer's own words. Nothing deletes them
   automatically, and that is a decision rather than an oversight.
3. **Confirmation of the wording** in any flow before it is published. The
   starter flow's wording is mine, not ABC Cargo's.

## 10. Rollback

Nothing to roll back: nothing has been deployed and no flow has been published.
The module is inert in the code as it stands.

Were a flow ever published and found wrong, the rollback is
`POST /api/bots/unpublish` for that region, which restores the behaviour that
exists today. It deletes nothing, so the flow can be corrected and republished
as the next version.

## 11. Approval

No approval is required for what has been done, which is preparation only.

**`APPROVE LIVE CHANGE` would be required before** publishing any flow to a
region, applying `0007_bots.sql` to the remote database, or deploying the Worker.

The standing hold of 8 October 2026 — _"dont change any live"_ — remains in
force and none of the above has been requested.

## 12. Next action

Chase the three Freshchat flow exports. The runtime is ready for them, and until
they arrive the bot cannot be part of any cutover.
