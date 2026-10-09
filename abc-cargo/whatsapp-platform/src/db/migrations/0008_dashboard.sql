-- Indexes the dashboard needs.
--
-- The dashboard is polled, not read once, so its queries are the ones most
-- worth indexing. Two of them scan in a way the original schema did not
-- anticipate.

-- "Messages today" filters messages by time and then joins to find the region,
-- because a message carries its conversation rather than its region. The
-- existing index is on (conversation_id, wa_timestamp), which does not help a
-- query that starts from the time.
CREATE INDEX IF NOT EXISTS idx_messages_wa_timestamp
	ON messages (wa_timestamp);

-- The queue counts and the attention list both ask for the conversations in a
-- region where the customer has spoken since we last did, oldest first.
CREATE INDEX IF NOT EXISTS idx_conversations_unanswered
	ON conversations (region_id, status, last_inbound_at);

-- Open tickets by whichever of their two clocks runs out first.
CREATE INDEX IF NOT EXISTS idx_tickets_open_due
	ON tickets (region_id, status, first_response_due_at, resolution_due_at);

-- A ticket owner's own list, for the personal queue.
CREATE INDEX IF NOT EXISTS idx_tickets_owner
	ON tickets (owner_agent_id, status);

-- Presence is now read with a staleness cutoff, so the timestamp is part of
-- the query rather than just a record of when the row was written.
CREATE INDEX IF NOT EXISTS idx_agent_presence_fresh
	ON agent_presence (status, updated_at);
