# Engage — Composer: internal notes, attachments, voice notes, locations

**Prepared by:** Head of IT, ABC Cargo IT Department
**Date:** 8 October 2026
**Status:** Built and verified against a running local Worker. Nothing deployed. No message sent and Meta was not contacted.

---

## 1. Executive summary

The composer additions from the design package are built: internal notes,
attachments (documents, images, video), voice notes, and locations.

**The design decision that matters is about internal notes.** An internal note
is the one piece of text in this platform that must never reach the customer.
"This one always argues about the duty, get Aziz to call him" is written on the
assumption that nobody outside the office will ever read it, and a note
delivered to the customer it is about is not something an apology recovers.

So notes do not live in the `messages` table alongside the real ones,
separated by a flag. They live in their own table, and **the WhatsApp send
path does not read it**. There is no query it could get wrong, because it does
not touch the table at all. Two tests assert this structurally rather than
trusting it.

**Two pre-existing bugs were found and fixed on the way.** The more serious one
had been live in the codebase since before this work: errors thrown inside the
Durable Object lose their class crossing the RPC boundary, so
`error instanceof WindowClosedError` never matched — and the careful 409 telling
an agent "the 24-hour window is closed, send a template instead" was being
delivered as **"Internal error"**. Details in §6.3.

## 2. Business requirement

Agents currently have text and approved templates. The work they actually do
needs more: sending a customer their commercial invoice, recording that a
colleague has already phoned about a claim, sending the warehouse location to a
driver, answering a long question with thirty seconds of speech rather than
three paragraphs of typing.

## 3. Scope

| In scope                                      | Not in scope                                |
| --------------------------------------------- | ------------------------------------------- |
| Internal notes, pinned for handover           | @mentions and notifications on notes        |
| Documents, images, video, stickers            | Editing or converting media                 |
| Voice notes, with the codec rule made visible | Recording audio in a browser (a UI concern) |
| Locations, validated                          | Live location sharing                       |
| R2 copies of outbound media                   | A UI — this is the API one would read       |

## 4. What was built

| File                                  | What it holds                                                     |
| ------------------------------------- | ----------------------------------------------------------------- |
| `src/composer/notes.ts`               | Internal notes. No client, no phone number, no send               |
| `src/composer/media.ts`               | What may be attached, and how it will arrive                      |
| `src/db/migrations/0010_composer.sql` | `conversation_notes`, plus filename and coordinates on `messages` |
| `src/whatsapp/client.ts`              | `uploadMedia`, `sendMedia`, `sendLocation`                        |
| `src/conversation.ts`                 | `sendMedia`, `sendLocation`, both inside the service window       |

### 4.1 Internal notes cannot be sent, structurally

The guarantee is that the sending code has nothing to read. It is enforced by
two tests:

- `src/conversation.ts`, `src/whatsapp/client.ts`, `src/broadcasts/sender.ts`
  and `src/queue/consumer.ts` must contain **no reference** to
  `conversation_notes`.
- `src/composer/notes.ts` must contain no `WhatsAppClient`, no
  `phoneNumberId`, and no `fetch(`.

The cost is that displaying a conversation means merging two ordered lists.
That is a cheap and visible cost, paid in one place, for a guarantee that holds
everywhere.

Notes can be **pinned**. That is the handover note — the thing the next agent
has to read before they reply, which otherwise scrolls away under the
conversation it is about.

Only the author may edit a note, the same rule as team chat. A supervisor who
disagrees adds their own, which leaves both on the record. Pinning is not
editing, so anyone who can read the conversation may raise the note the next
agent needs.

### 4.2 Attachments are checked before they are uploaded

Meta would reject a bad attachment too — but _after_ the upload, which on a
large file is a minute of waiting for an error that reads like a server fault.
Checking locally is instant and says what is wrong.

**The limits encoded are from Meta's published documentation and Meta changes
them.** They are a courtesy to the agent, not a specification; the Cloud API
remains the authority. They should be confirmed against the current
documentation before go-live.

Documents are deliberately open about their file type: an agent sending a
customs declaration should not be stopped because nobody thought to list that
type. A document must have a filename, because that is what the customer sees
in the chat — an unnamed commercial invoice is unhelpful and looks like a
mistake on our part. A filename like `C:\Users\mariam\invoice.pdf` is reduced
to `invoice.pdf` and the agent is **told** it was adjusted rather than having it
changed silently.

### 4.3 A voice note is not an audio file, and the agent is told which

Only Ogg with the Opus codec renders as push-to-talk in WhatsApp. Every other
audio type arrives as a file attachment with a play button, which is a
different thing to receive.

An agent who records a voice note and sees it arrive as `audio.m4a` concludes
the feature is broken. So the composer returns `voiceNote: true|false` and a
warning saying which it will be, rather than leaving them to find out from the
customer.

### 4.4 Attachments are kept in R2, not only at Meta

Meta's media ids and download URLs expire. Without our own copy, a conversation
from three months ago shows "[a document]" with no way to see _which_ document —
useless in a dispute about what was sent to whom.

The file is written to R2 **before** the send. If the send then fails we have
kept a file nobody received, which is harmless; the other order risks a message
the customer has and we cannot show.

### 4.5 Locations are validated, including the cases that are usually mistakes

Latitude and longitude ranges, non-numeric coordinates, and two judgement
calls:

- **0, 0 is refused.** It is in the Gulf of Guinea and is almost always an
  uninitialised value rather than a place anybody meant to send.
- **A name without an address is refused.** WhatsApp shows the name as a
  heading and the address beneath it. A name alone renders as a labelled pin
  with no way to navigate to it, which for a warehouse is the one thing the
  customer needs. An address without a name is fine — the address is the
  useful half.

Attachments and locations are free-form messages, so the **24-hour service
window applies** exactly as it does to a text reply. Outside it Meta accepts
only templates, and a template cannot carry an arbitrary attachment, so the
honest answer is to refuse rather than to send something that will be rejected.

## 5. API

| Method | Path                                   | Notes                                  |
| ------ | -------------------------------------- | -------------------------------------- |
| GET    | `/api/conversations/:id/notes`         | Anyone who may read the conversation   |
| POST   | `/api/conversations/:id/notes`         | A person, not a machine credential     |
| PATCH  | `/api/conversations/:id/notes/:noteId` | Body: author only. Pinning: any reader |
| POST   | `/api/conversations/:id/media`         | `multipart/form-data`; reply rights    |
| POST   | `/api/conversations/:id/location`      | Reply rights                           |

Writing a note needs only the right to **read** the conversation, because a
note is a reading aid for the next person rather than an act towards the
customer. Sending an attachment or a location needs **reply** rights, which are
stricter — an agent must have claimed the conversation, because answering one
you have not taken is how two agents tell one customer different things.

A note is attributed to whoever is signed in, never to a name in the body — the
same rule as a reply. A machine credential cannot write one at all.

Media is sent as multipart rather than base64 in JSON, so a 20 MB document does
not become a 27 MB request body.

## 6. Evidence

Verified on 8 October 2026 against a running **local** Worker, with a
local-only service key in a gitignored `.dev.vars` that was deleted afterwards.
The fixture was invented and was deleted afterwards. **No message was sent and
no request was made to Meta.** No remote database, no deployment.

| Check                                         | Result                            |
| --------------------------------------------- | --------------------------------- |
| `npm run test`                                | **288 passed, 0 failed** (20 new) |
| `npm run typecheck` / `lint` / `format:check` | Clean                             |
| `wrangler deploy --dry-run`                   | 407.66 KiB / 99.26 KiB gzip       |
| `wrangler d1 migrations apply --local`        | `0010_composer.sql`, 7 commands   |

### 6.1 The route refusals, end to end

| Request                                            | Answer                                                          |
| -------------------------------------------------- | --------------------------------------------------------------- |
| Note written by a machine credential               | **403 `service_caller`**                                        |
| Reading notes as a machine credential              | **200** — reading is allowed                                    |
| Location `0, 0`                                    | **400 `null_island`**                                           |
| Location named with no address                     | **400 `name_without_address`**                                  |
| 6 MB image against a 5 MB limit                    | **400 `too_large`** — _before any upload_                       |
| `kind=spreadsheet`                                 | **400 `unknown_kind`**                                          |
| JSON instead of multipart                          | **400**, saying to use multipart                                |
| A valid document on a conversation with no history | **404 `not_started`** — reached the send path and stopped there |

The last two rows together are the useful pair: the oversized image never
reached the send path, while the valid document did and was stopped by the
conversation's own state. That is the validation boundary behaving as intended.

### 6.2 What was _not_ verified end to end, and why

**The closed-window refusal was verified by code inspection, not by a live
call.** Initialising a Durable Object's state requires either an inbound
webhook or an outbound send, and both attempt a request to Meta — `markAsRead`
on the inbound path, the send itself on the outbound one. Under the standing
hold I was not willing to contact Meta to produce a test result.

What stands behind the claim instead: the guard is a single line,
`if (!this.windowOpen(state)) throw new WindowClosedError()`, identical to and
adjacent to the one the existing `reply` path has used since before this work.
The fix in §6.3 is what makes that guard actually produce a 409 rather than a
500, and that fix _was_ verified live through the sibling error on the same
code path.

### 6.3 A pre-existing bug, more serious than the feature

`error instanceof WindowClosedError` in the top-level handler **has never
matched.** These errors are thrown inside the Durable Object and cross an RPC
boundary to reach the handler, which rebuilds them as plain errors carrying the
name and message but not the class.

The consequence: an agent trying to reply outside the 24-hour window got
**"Internal error"** — the one message that tells them nothing and sends them to
IT — instead of "the window is closed, send an approved template". The same
applied to `InvalidTransitionError`.

Found because my new location route hit the sibling case and returned 500 when
I expected a clear refusal. Now matched by error **name**, which survives the
boundary, and verified live: the same request that returned
`{"error":"Internal error"}` with HTTP 500 now returns
`{"error":"This conversation has no messages yet.","reason":"not_started"}`
with HTTP 404.

Matching on the name rather than the message is deliberate — a message would
break the first time somebody reworded it.

### 6.4 A smaller fix

A conversation row that exists with no message history threw a bare
`Error("Conversation has not been initialised")`, surfacing as a 500. That is
not a fault: it happens whenever something addresses a conversation created by
an import or a seed that has had no traffic. It is now
`ConversationNotStartedError`, answered as a 404 with a reason, mapped in one
place so every route that can reach it answers the same way.

### 6.5 A wording slip I caught in my own output

The size refusal read "a image may be up to 5 MB". It is read by an agent, so
it now reads "an image". Fixed and pinned by a test.

## 7. Risk

| Risk                                        | Mitigation                                                                    |
| ------------------------------------------- | ----------------------------------------------------------------------------- |
| An internal note reaching the customer      | Separate table; the send path has no query to get wrong; two structural tests |
| A note rewritten under a colleague's name   | Author-only edits; a supervisor adds their own instead                        |
| An attachment rejected by Meta after upload | Checked locally first; limits documented as Meta's, not ours                  |
| A voice note arriving as a file             | The codec rule is checked and reported to the agent                           |
| History showing "[a document]" months later | A copy in R2, written before the send                                         |
| A location the customer cannot navigate to  | A name requires an address                                                    |
| Media sent outside the service window       | The same window guard as a text reply, now returning a real 409               |

## 8. What is still required from the business

1. **Confirmation of Meta's current media limits and types.** Those encoded
   are from published documentation and Meta changes them.
2. **A retention decision for outbound media in R2 and for internal notes.**
   Notes in particular are candid internal remarks about named customers, and
   nothing deletes them automatically.
3. **Whether a supervisor should be able to delete a colleague's note.** Today
   nobody can delete one through the API; the service supports it and no route
   exposes it, deliberately, because deletion of a handover note is a decision
   rather than a convenience.

## 9. Rollback

Nothing deployed, so nothing to roll back. `0010_composer.sql` creates one
table and adds three nullable columns to `messages`; it changes no existing
row and is reversible with `DROP TABLE` and `DROP COLUMN`.

The error-mapping fix in §6.3 changes response codes from 500 to 409 and 404 on
paths that were previously failing opaquely. Reverting it would restore the
defect.

## 10. Approval

No approval is required for what has been done, which is preparation and local
verification only. Nothing was sent and Meta was not contacted.

**`APPROVE LIVE CHANGE` would be required before** applying
`0010_composer.sql` to the remote database, deploying the Worker, or sending any
attachment, voice note or location to a real customer.

The standing hold of 8 October 2026 — _"dont change any live"_ — remains in
force and none of the above has been requested.

## 11. Next action

**Every module in the design package now has an implementation.** Bots,
dashboard, broadcasts, contacts, lifecycle, team chat, setup, reports, roles
and the composer are all built; what remains from the package is the UI, which
the single-file demonstration stands in for.

The critical path is unchanged and is not code: **the three Freshchat bot flow
exports**, without which no number can be cut over. After that, the real
`REGION_NUMBERS` and the first `master_admin`.
