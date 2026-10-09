-- Customer satisfaction surveys and their answers.
--
-- The rules are in src/crm/csat.ts. Two of them are enforced here as well,
-- because a rule that exists only in application code is a rule one careless
-- query can break:
--
--   * One survey per conversation. `conversation_id` is the primary key, so a
--     second survey for the same conversation is refused by the database, not
--     merely checked for first.
--   * A score is 1 to 5 or nothing. A score outside the scale is a bug
--     upstream, and averaging it would publish a wrong figure.
--
-- The answer lives on the same row as the survey. A survey is asked once and
-- answered at most once, so a separate responses table would only add a join
-- and the possibility of two answers to one question.

CREATE TABLE IF NOT EXISTS csat_surveys (
	conversation_id TEXT PRIMARY KEY,
	customer_id TEXT,
	-- The cooldown is per customer across every conversation, keyed on the
	-- WhatsApp id because it is always present and customer_id may not be.
	wa_id TEXT NOT NULL,
	region_id TEXT NOT NULL,
	-- Who resolved the conversation, for the per-agent view. Nullable: a
	-- conversation resolved by the bot alone has nobody to attribute.
	agent_id TEXT,
	-- free_text inside the 24-hour window, template outside it.
	channel TEXT NOT NULL CHECK (channel IN ('free_text', 'template')),
	sent_at TEXT NOT NULL,
	responded_at TEXT,
	score INTEGER CHECK (score IS NULL OR (score BETWEEN 1 AND 5)),
	comment TEXT
);

CREATE INDEX IF NOT EXISTS idx_csat_customer
	ON csat_surveys (wa_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_csat_region
	ON csat_surveys (region_id, sent_at DESC);
-- Open surveys: sent, not yet answered. The inbound path checks this on every
-- message from a customer who has one, so it has to be cheap.
CREATE INDEX IF NOT EXISTS idx_csat_open
	ON csat_surveys (conversation_id) WHERE responded_at IS NULL;
