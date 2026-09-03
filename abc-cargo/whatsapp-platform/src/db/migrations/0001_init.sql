-- ABC Cargo WhatsApp platform: initial schema (D1 / SQLite)

CREATE TABLE IF NOT EXISTS contacts (
	wa_id TEXT PRIMARY KEY,
	profile_name TEXT,
	region_id TEXT,
	opted_out INTEGER NOT NULL DEFAULT 0,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
	-- "<phone_number_id>:<wa_id>": one thread per customer per business number
	id TEXT PRIMARY KEY,
	wa_id TEXT NOT NULL,
	phone_number_id TEXT NOT NULL,
	region_id TEXT NOT NULL,
	-- open | pending | resolved
	status TEXT NOT NULL DEFAULT 'open',
	assigned_agent_id TEXT,
	-- end of the 24-hour customer service window (ISO 8601)
	window_expires_at TEXT,
	last_inbound_at TEXT,
	last_outbound_at TEXT,
	last_message_preview TEXT,
	unread_count INTEGER NOT NULL DEFAULT 0,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_conversations_region_status
	ON conversations (region_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversations_agent
	ON conversations (assigned_agent_id, status);

CREATE TABLE IF NOT EXISTS messages (
	-- WhatsApp message id (wamid.*), unique across the platform
	id TEXT PRIMARY KEY,
	conversation_id TEXT NOT NULL,
	-- in | out
	direction TEXT NOT NULL,
	type TEXT NOT NULL,
	body TEXT,
	-- R2 object key for downloaded media, if any
	media_key TEXT,
	media_mime TEXT,
	-- received | accepted | sent | delivered | read | failed
	status TEXT,
	error_code INTEGER,
	error_message TEXT,
	-- agent id, 'auto' for automated replies, 'system' for notifications
	sent_by TEXT,
	wa_timestamp TEXT NOT NULL,
	raw_json TEXT,
	created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation
	ON messages (conversation_id, wa_timestamp);

CREATE TABLE IF NOT EXISTS agents (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	email TEXT,
	-- NULL means the agent may handle every region
	region_id TEXT,
	-- agent | supervisor | admin
	role TEXT NOT NULL DEFAULT 'agent',
	active INTEGER NOT NULL DEFAULT 1,
	created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_presence (
	agent_id TEXT PRIMARY KEY,
	-- online | away | offline
	status TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS template_sends (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	conversation_id TEXT NOT NULL,
	template_name TEXT NOT NULL,
	language_code TEXT NOT NULL,
	to_wa_id TEXT NOT NULL,
	wa_message_id TEXT,
	requested_by TEXT NOT NULL,
	created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	actor TEXT NOT NULL,
	action TEXT NOT NULL,
	conversation_id TEXT,
	details TEXT,
	created_at TEXT NOT NULL
);
