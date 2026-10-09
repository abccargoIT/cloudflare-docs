-- Conversation transfer, including across regions.
--
-- The rule that matters is in src/crm/transfer.ts and is enforced in two
-- places, so it is worth stating here as well: a transfer moves OWNERSHIP and
-- never the channel. The conversation id embeds the WhatsApp phone number id,
-- and every reply leaves from that number, so `region_id` can move to the
-- receiving region while the customer's thread stays exactly where it is.
--
-- `region_id` surviving later inbound messages depends on
-- Repository.upsertConversationOnInbound NOT updating it on conflict. It does
-- not, and a comment there now says why: if it ever did, every transfer would
-- silently revert the next time the customer wrote.

-- SQLite has no ADD COLUMN IF NOT EXISTS. D1 tracks applied migrations, so
-- this runs once; re-running the file by hand would fail here, loudly, rather
-- than half-apply.
ALTER TABLE conversations ADD COLUMN assigned_team_id TEXT;

CREATE INDEX IF NOT EXISTS idx_conversations_team
	ON conversations (assigned_team_id, status);

-- One row per transfer. The audit trail is the point: "why is a Dubai claim
-- being answered in London?" has no answer in the data unless somebody wrote
-- one, which is why `reason` is required.
CREATE TABLE IF NOT EXISTS conversation_transfers (
	id TEXT PRIMARY KEY,
	conversation_id TEXT NOT NULL,
	from_region_id TEXT NOT NULL,
	to_region_id TEXT NOT NULL,
	from_team_id TEXT,
	to_team_id TEXT NOT NULL,
	from_agent_id TEXT,
	to_agent_id TEXT,
	actor TEXT NOT NULL,
	reason TEXT NOT NULL,
	cross_region INTEGER NOT NULL CHECK (cross_region IN (0, 1)),
	-- The warnings shown when the transfer was made, so a later reader can see
	-- that "the receiving region was closed" was known at the time.
	warnings TEXT NOT NULL DEFAULT '[]',
	occurred_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_transfers_conversation
	ON conversation_transfers (conversation_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_transfers_to_region
	ON conversation_transfers (to_region_id, occurred_at DESC);
