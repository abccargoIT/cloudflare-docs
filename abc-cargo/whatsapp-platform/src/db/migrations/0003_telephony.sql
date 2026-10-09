-- Telephony: Microsoft Teams calls landing on the customer timeline.
--
-- Two things are being added. The first is the ability to say which external
-- system a call came from and what it was called there, so the same call is
-- never written twice. The second is the call's text, kept separately from the
-- call row because it arrives later, is much larger, and is governed by a
-- different retention decision.

-- Where the call came from, and its id in that system.
ALTER TABLE calls ADD COLUMN source TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE calls ADD COLUMN external_id TEXT;

-- The number the customer was reached on, kept as dialled. A call can arrive
-- before the customer exists, and this is what an agent needs to match it.
ALTER TABLE calls ADD COLUMN external_number TEXT;

-- Microsoft re-notifies whenever it revises a call record, and the revision
-- carries the same id. Without this index the same call appears several times
-- on one customer's timeline, which is worse than it not appearing at all.
CREATE UNIQUE INDEX IF NOT EXISTS idx_calls_source_external
	ON calls (source, external_id)
	WHERE external_id IS NOT NULL;

-- Calls that arrived with a number matching no customer. They are held here
-- rather than dropped, or attached to a guess, so an agent can assign them.
CREATE TABLE IF NOT EXISTS unmatched_calls (
	id TEXT PRIMARY KEY,
	source TEXT NOT NULL,
	external_id TEXT NOT NULL,
	region_id TEXT NOT NULL,
	direction TEXT NOT NULL,
	external_number TEXT,
	agent_upn TEXT,
	started_at TEXT NOT NULL,
	duration_seconds INTEGER NOT NULL DEFAULT 0,
	-- open | assigned | ignored
	status TEXT NOT NULL DEFAULT 'open',
	assigned_call_id TEXT REFERENCES calls (id),
	created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_unmatched_source_external
	ON unmatched_calls (source, external_id);

CREATE INDEX IF NOT EXISTS idx_unmatched_open
	ON unmatched_calls (region_id, status, started_at DESC);

-- The spoken text of a call, once Microsoft makes it available.
--
-- Separate from `calls` on purpose: the transcript arrives after the call
-- record, is orders of magnitude larger, and will almost certainly be deleted
-- on a shorter clock than the call metadata it belongs to. Deleting a row here
-- must not delete the record that the call happened.
CREATE TABLE IF NOT EXISTS call_transcripts (
	id TEXT PRIMARY KEY,
	call_id TEXT REFERENCES calls (id),
	source TEXT NOT NULL,
	-- The transcript's own id in the source system.
	external_id TEXT NOT NULL,
	-- The call it belongs to, in the source system. Present even when the call
	-- row is missing, so a transcript arriving first is not lost.
	external_call_id TEXT NOT NULL,
	region_id TEXT NOT NULL,
	customer_id TEXT REFERENCES customers (id),
	-- Plain text, speaker-labelled, derived from the WebVTT Microsoft returns.
	content TEXT NOT NULL,
	language TEXT,
	created_at TEXT NOT NULL,
	-- When this transcript should be deleted. Set from policy at write time so
	-- a sweep can act on it without re-deriving the rule.
	expires_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_transcripts_source_external
	ON call_transcripts (source, external_id);

CREATE INDEX IF NOT EXISTS idx_transcripts_call
	ON call_transcripts (external_call_id);

CREATE INDEX IF NOT EXISTS idx_transcripts_expiry
	ON call_transcripts (expires_at)
	WHERE expires_at IS NOT NULL;
