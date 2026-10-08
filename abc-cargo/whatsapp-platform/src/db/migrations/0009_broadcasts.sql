-- Template broadcasts: the one part of this platform that can reach thousands
-- of real customers from a single click.
--
-- Four properties are built into this schema rather than left to the code that
-- uses it, because each of them is a thing that goes wrong once and is
-- remembered for years.
--
-- **The audience is frozen before it is approved.** Resolving an audience
-- writes a row per recipient. Approval then applies to that list, not to a
-- query that might return different people by the time it runs. A broadcast
-- that selects its recipients at send time can message people nobody reviewed.
--
-- **A recipient can only be messaged once.** The primary key on
-- (broadcast_id, wa_id) makes a double send impossible rather than unlikely,
-- so a retried queue batch or a second press of Send cannot do it.
--
-- **Why somebody was skipped is recorded.** "4,812 of 5,000 sent" invites the
-- question, and the answer has to be better than a guess. An opt-out that
-- silently drops someone from a count is also how a platform ends up messaging
-- them next time.
--
-- **Nothing is denormalised.** The counts a dashboard shows are aggregated from
-- the recipient rows, so a stored total cannot drift from the thing it totals.

CREATE TABLE IF NOT EXISTS broadcasts (
	id TEXT PRIMARY KEY,
	region_id TEXT NOT NULL,
	name TEXT NOT NULL,
	-- marketing | service
	--
	-- Marketing needs the customer to have opted in. Service — a delay
	-- notice, a customs document request — does not, because it is about a
	-- shipment they asked us to carry. Both honour an opt-out absolutely.
	kind TEXT NOT NULL,
	template_name TEXT NOT NULL,
	language_code TEXT NOT NULL,
	-- Template variables, as the JSON the Cloud API takes. Null for a template
	-- with no variables.
	components TEXT,
	-- The audience rule, as JSON, kept for the record. The recipients are the
	-- authority on who will be messaged; this is how they were chosen.
	audience TEXT NOT NULL,
	-- draft | review | approved | sending | paused | sent | cancelled
	status TEXT NOT NULL DEFAULT 'draft',
	-- Messages per minute. Meta throttles a number that sends too fast and
	-- lowers its quality rating, which is shared with every other
	-- conversation on that number.
	rate_per_minute INTEGER NOT NULL DEFAULT 20,
	created_by TEXT NOT NULL,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	-- Set when the audience was last resolved, and how many it found. Any
	-- re-resolve clears the approval below, because the approval was of a
	-- particular list of people.
	resolved_at TEXT,
	resolved_count INTEGER,
	approved_by TEXT,
	approved_at TEXT,
	started_at TEXT,
	finished_at TEXT,
	cancelled_by TEXT,
	cancelled_at TEXT,
	cancel_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_broadcasts_region
	ON broadcasts (region_id, status, created_at DESC);

-- Everything that is sending or could start sending, which is what a worker
-- and a kill switch both need to find quickly.
CREATE INDEX IF NOT EXISTS idx_broadcasts_running
	ON broadcasts (status) WHERE status IN ('sending', 'paused');

CREATE TABLE IF NOT EXISTS broadcast_recipients (
	broadcast_id TEXT NOT NULL REFERENCES broadcasts (id),
	-- The WhatsApp id is the key, not the customer id: two customer records
	-- for the same number must not produce two messages to that number.
	wa_id TEXT NOT NULL,
	customer_id TEXT,
	-- Denormalised so a scoped read never has to join back to the broadcast.
	region_id TEXT NOT NULL,
	-- pending | skipped | sending | sent | delivered | read | replied | failed
	state TEXT NOT NULL DEFAULT 'pending',
	-- opted_out | not_opted_in | no_wa_id, for a skipped recipient.
	skip_reason TEXT,
	conversation_id TEXT,
	wa_message_id TEXT,
	attempts INTEGER NOT NULL DEFAULT 0,
	error_code INTEGER,
	error_message TEXT,
	queued_at TEXT,
	sent_at TEXT,
	delivered_at TEXT,
	read_at TEXT,
	replied_at TEXT,
	PRIMARY KEY (broadcast_id, wa_id)
);

-- The worker's own query: the next few pending recipients of one broadcast.
CREATE INDEX IF NOT EXISTS idx_broadcast_recipients_pending
	ON broadcast_recipients (broadcast_id, state);

-- A delivery status arrives carrying only the WhatsApp message id.
CREATE INDEX IF NOT EXISTS idx_broadcast_recipients_message
	ON broadcast_recipients (wa_message_id) WHERE wa_message_id IS NOT NULL;

-- An inbound message has to be attributable to a recent broadcast send, to
-- count a reply. Keyed by conversation because that is what an inbound message
-- carries.
CREATE INDEX IF NOT EXISTS idx_broadcast_recipients_conversation
	ON broadcast_recipients (conversation_id, sent_at)
	WHERE conversation_id IS NOT NULL;
