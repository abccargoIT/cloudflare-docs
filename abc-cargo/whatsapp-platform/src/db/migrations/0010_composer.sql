-- Internal notes on a conversation.
--
-- These are kept in their own table, and that is the whole point of the
-- design rather than a filing decision.
--
-- An internal note is the one piece of text in this platform that must never
-- reach the customer. "This one always argues about the duty, get Aziz to
-- call him" is written on the assumption that nobody outside the office will
-- ever read it, and a note delivered to the customer it is about is not a bug
-- anybody recovers from with an apology.
--
-- If notes lived in `messages` alongside the real ones, separated by a
-- direction column or a flag, then every piece of code that sends an outbound
-- message would be one wrong WHERE clause away from sending one. By putting
-- them here, the WhatsApp send path has nothing to read: there is no query it
-- could get wrong, because it does not touch this table at all. A test
-- asserts that the sending code contains no reference to it.
--
-- The cost is that displaying a conversation means merging two ordered lists.
-- That is a cheap and visible cost, paid in one place, for a guarantee that
-- holds everywhere.

CREATE TABLE IF NOT EXISTS conversation_notes (
	id TEXT PRIMARY KEY,
	conversation_id TEXT NOT NULL,
	-- Denormalised so a scoped read never joins back to the conversation.
	region_id TEXT NOT NULL,
	author_id TEXT NOT NULL,
	body TEXT NOT NULL,
	-- Kept at the top of the thread. This is the handover note: the thing the
	-- next agent has to read before they reply, which otherwise scrolls away
	-- under the conversation it is about.
	pinned INTEGER NOT NULL DEFAULT 0,
	created_at TEXT NOT NULL,
	-- Set when edited. The original is not kept: this is a working note, not
	-- an evidential record, and pretending otherwise would be worse than
	-- saying so. The same decision as team chat.
	edited_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_conversation_notes_thread
	ON conversation_notes (conversation_id, created_at DESC);

-- The pinned ones, which are read on every conversation open.
CREATE INDEX IF NOT EXISTS idx_conversation_notes_pinned
	ON conversation_notes (conversation_id) WHERE pinned = 1;

-- Outbound attachments keep their own record of what was uploaded to Meta.
--
-- Meta's media ids and download URLs expire, so the copy in R2 is the only
-- durable one. Without this, a conversation from three months ago shows "[a
-- document]" with no way to see which document, which is useless in a dispute
-- about what was sent to whom.
ALTER TABLE messages ADD COLUMN media_filename TEXT;

-- Where a location message pointed, so the history is readable without
-- unpacking the raw payload.
ALTER TABLE messages ADD COLUMN location_latitude REAL;
ALTER TABLE messages ADD COLUMN location_longitude REAL;
