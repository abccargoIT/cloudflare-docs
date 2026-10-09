-- The bot: the flows that front each number, and the sessions running through
-- them.
--
-- Two things in this schema are deliberate and worth reading before changing.
--
-- A flow is immutable once published. Editing a published flow creates the
-- next version as a draft; publishing that retires the previous one. Nothing
-- rewrites a published version in place, because a session records the version
-- it started on and must be able to find it.
--
-- One published flow per region at a time, enforced by the index rather than
-- by whoever wrote the publish path. Two published flows for the same number
-- is a coin toss over which bot a customer meets.

CREATE TABLE IF NOT EXISTS bot_flows (
	id TEXT PRIMARY KEY,
	region_id TEXT NOT NULL,
	name TEXT NOT NULL,
	version INTEGER NOT NULL,
	-- draft | published | retired
	status TEXT NOT NULL,
	entry_step_id TEXT NOT NULL,
	-- The steps, as the JSON the runtime reads. Kept whole rather than split
	-- into rows: a flow is read in its entirety every time and never queried
	-- step by step, and a half-written flow spread over rows is a worse
	-- failure than a malformed document.
	steps TEXT NOT NULL,
	created_by TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	published_at TEXT,
	published_by TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_bot_flows_version
	ON bot_flows (region_id, version);

CREATE UNIQUE INDEX IF NOT EXISTS idx_bot_flows_one_published
	ON bot_flows (region_id) WHERE status = 'published';

CREATE INDEX IF NOT EXISTS idx_bot_flows_region
	ON bot_flows (region_id, status);

-- Where a conversation has reached in the flow.
--
-- Keyed by conversation, not by customer: the same person messaging the UAE
-- number and the UK number is two conversations with two different bots, and
-- merging them would put a UK answer into a UAE flow.
CREATE TABLE IF NOT EXISTS bot_sessions (
	conversation_id TEXT PRIMARY KEY,
	customer_id TEXT,
	region_id TEXT NOT NULL,
	flow_id TEXT NOT NULL REFERENCES bot_flows (id),
	flow_version INTEGER NOT NULL,
	-- The step waiting for the customer. Null once the session has ended.
	step_id TEXT,
	-- Answers collected so far, as JSON. These are the customer's own words,
	-- so they are covered by the same retention decision as the messages.
	slots TEXT NOT NULL DEFAULT '{}',
	invalid_replies INTEGER NOT NULL DEFAULT 0,
	turns INTEGER NOT NULL DEFAULT 0,
	started_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	ended_at TEXT,
	ended_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_bot_sessions_open
	ON bot_sessions (region_id, updated_at DESC) WHERE ended_at IS NULL;

-- Why the bot did what it did, one row per inbound message it handled.
--
-- This exists to answer a supervisor asking why a customer was sent down a
-- particular branch, which is a question that gets asked about every bot and
-- which no amount of reading the flow answers after the fact. Retention is a
-- decision for the Head of IT; nothing here deletes it automatically.
CREATE TABLE IF NOT EXISTS bot_turns (
	id TEXT PRIMARY KEY,
	conversation_id TEXT NOT NULL,
	region_id TEXT NOT NULL,
	flow_id TEXT NOT NULL,
	flow_version INTEGER NOT NULL,
	-- The step the session was on when the message arrived.
	from_step_id TEXT,
	-- The step it is on afterwards, null if the session ended.
	to_step_id TEXT,
	ended_reason TEXT,
	-- The runtime's own account of the turn, as JSON.
	trace TEXT NOT NULL,
	occurred_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bot_turns_conversation
	ON bot_turns (conversation_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_bot_turns_region
	ON bot_turns (region_id, occurred_at DESC);
