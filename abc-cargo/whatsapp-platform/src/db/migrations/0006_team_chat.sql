-- Internal messages between staff, across all three regions.
--
-- This is the one part of the platform that crosses regions on purpose. Every
-- other table is scoped because it holds a customer's information; this one
-- holds a conversation between colleagues, and a UAE agent asking a KSA agent
-- about a shipment is the point rather than a leak.
--
-- The rule that keeps it from becoming a way around the regional scoping:
-- a message may REFERENCE a customer record, but it never embeds one. The
-- reference is an id, and following it goes through the ordinary scoped route,
-- which will refuse a reader who should not see it. Quoting text into a
-- message is something a person does and a person is accountable for; the
-- platform will not do it for them.

CREATE TABLE IF NOT EXISTS chat_threads (
	id TEXT PRIMARY KEY,
	-- direct | team
	kind TEXT NOT NULL,
	-- Set for a team thread, null for a direct one.
	team_id TEXT REFERENCES teams (id),
	title TEXT,
	-- For a direct thread: the two user ids, sorted and joined. Stops a second
	-- thread being opened between the same pair just because someone started
	-- it from the other end.
	direct_key TEXT,
	created_by TEXT NOT NULL REFERENCES users (id),
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	-- Denormalised so a thread list can sort without reading every message.
	last_message_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_direct_key
	ON chat_threads (direct_key) WHERE direct_key IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_team_thread
	ON chat_threads (team_id) WHERE team_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_chat_threads_recent
	ON chat_threads (last_message_at DESC);

-- Who is in a thread, and how far each of them has read.
--
-- Membership is explicit even for a team thread. Deriving it from the team
-- would mean somebody leaving a team loses the history of a conversation they
-- took part in, and that history is often the only record of why something was
-- done.
CREATE TABLE IF NOT EXISTS chat_participants (
	thread_id TEXT NOT NULL REFERENCES chat_threads (id),
	user_id TEXT NOT NULL REFERENCES users (id),
	added_at TEXT NOT NULL,
	last_read_at TEXT,
	PRIMARY KEY (thread_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_chat_participants_user
	ON chat_participants (user_id, thread_id);

CREATE TABLE IF NOT EXISTS chat_messages (
	id TEXT PRIMARY KEY,
	thread_id TEXT NOT NULL REFERENCES chat_threads (id),
	author_id TEXT NOT NULL REFERENCES users (id),
	body TEXT NOT NULL,
	-- An optional pointer at something in the platform: conversation,
	-- customer, ticket or booking. An id only — never the record's contents,
	-- so following it is still subject to the reader's own permissions.
	ref_kind TEXT,
	ref_id TEXT,
	created_at TEXT NOT NULL,
	-- Set when edited. The original is not kept: this is a staff chat, not an
	-- evidential record, and pretending otherwise would be worse than saying so.
	edited_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_thread
	ON chat_messages (thread_id, created_at DESC);
