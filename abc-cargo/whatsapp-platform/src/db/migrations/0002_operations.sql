-- ABC Cargo Engage: commercial and service objects.
--
-- The conversation tables in 0001 cover the WhatsApp channel. These tables
-- cover what the business actually runs on — leads, quotations, bookings,
-- tickets and calls — and the activity stream that gives one customer one
-- history across every channel and record.

CREATE TABLE IF NOT EXISTS companies (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	region_id TEXT NOT NULL,
	-- trade | cash | prospect
	account_type TEXT NOT NULL DEFAULT 'prospect',
	credit_terms TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS customers (
	id TEXT PRIMARY KEY,
	company_id TEXT REFERENCES companies (id),
	display_name TEXT NOT NULL,
	-- WhatsApp id, when the customer has messaged us. Unique when present.
	wa_id TEXT,
	phone TEXT,
	email TEXT,
	region_id TEXT NOT NULL,
	account_type TEXT,
	opt_in_marketing INTEGER NOT NULL DEFAULT 0,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_wa_id
	ON customers (wa_id) WHERE wa_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_customers_region ON customers (region_id);

CREATE TABLE IF NOT EXISTS leads (
	id TEXT PRIMARY KEY,
	ref TEXT NOT NULL UNIQUE,
	customer_id TEXT NOT NULL REFERENCES customers (id),
	region_id TEXT NOT NULL,
	conversation_id TEXT,
	-- whatsapp_bot | call | website | agent
	source TEXT NOT NULL,
	origin TEXT,
	destination TEXT,
	-- air | sea_lcl | sea_fcl | road
	mode TEXT,
	-- new | qualified | quoted | negotiating | won | lost
	stage TEXT NOT NULL DEFAULT 'new',
	est_value REAL,
	currency TEXT,
	owner_agent_id TEXT,
	lost_reason TEXT,
	closed_at TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_leads_region_stage
	ON leads (region_id, stage, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_leads_customer ON leads (customer_id);

CREATE TABLE IF NOT EXISTS quotations (
	id TEXT PRIMARY KEY,
	ref TEXT NOT NULL UNIQUE,
	lead_id TEXT REFERENCES leads (id),
	customer_id TEXT NOT NULL REFERENCES customers (id),
	region_id TEXT NOT NULL,
	origin TEXT NOT NULL,
	destination TEXT NOT NULL,
	mode TEXT NOT NULL,
	chargeable_kg REAL,
	total_amount REAL NOT NULL,
	currency TEXT NOT NULL,
	-- draft | sent | negotiating | accepted | lost | expired
	status TEXT NOT NULL DEFAULT 'draft',
	valid_until TEXT,
	-- whatsapp | email | call
	sent_channel TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_quotations_region_status
	ON quotations (region_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_quotations_customer ON quotations (customer_id);

CREATE TABLE IF NOT EXISTS bookings (
	id TEXT PRIMARY KEY,
	-- the airway bill or shipment reference the customer quotes back to us
	ref TEXT NOT NULL UNIQUE,
	quotation_id TEXT REFERENCES quotations (id),
	customer_id TEXT NOT NULL REFERENCES customers (id),
	region_id TEXT NOT NULL,
	origin TEXT NOT NULL,
	destination TEXT NOT NULL,
	mode TEXT NOT NULL,
	pieces INTEGER,
	weight_kg REAL,
	value_amount REAL,
	currency TEXT,
	-- booked | collected | departed | in_transit | arrived | cleared | delivered
	milestone TEXT NOT NULL DEFAULT 'booked',
	-- when the current milestone was reached; drives stall detection
	milestone_at TEXT NOT NULL,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bookings_region_milestone
	ON bookings (region_id, milestone, milestone_at);
CREATE INDEX IF NOT EXISTS idx_bookings_customer ON bookings (customer_id);

CREATE TABLE IF NOT EXISTS booking_milestones (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	booking_id TEXT NOT NULL REFERENCES bookings (id),
	milestone TEXT NOT NULL,
	occurred_at TEXT NOT NULL,
	-- shipment_system | agent | api
	source TEXT NOT NULL,
	notified_at TEXT,
	created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_booking_milestones_unique
	ON booking_milestones (booking_id, milestone);

CREATE TABLE IF NOT EXISTS tickets (
	id TEXT PRIMARY KEY,
	ref TEXT NOT NULL UNIQUE,
	customer_id TEXT NOT NULL REFERENCES customers (id),
	region_id TEXT NOT NULL,
	booking_id TEXT REFERENCES bookings (id),
	conversation_id TEXT,
	-- claim | delay | billing | documentation | delivery | general
	type TEXT NOT NULL,
	subject TEXT NOT NULL,
	-- low | normal | high | urgent
	priority TEXT NOT NULL DEFAULT 'normal',
	-- open | pending | resolved | closed
	status TEXT NOT NULL DEFAULT 'open',
	owner_agent_id TEXT,
	-- both targets are computed in business minutes for the owning region
	first_response_due_at TEXT NOT NULL,
	resolution_due_at TEXT NOT NULL,
	first_response_at TEXT,
	resolved_at TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tickets_region_status
	ON tickets (region_id, status, resolution_due_at);
CREATE INDEX IF NOT EXISTS idx_tickets_customer ON tickets (customer_id);
CREATE INDEX IF NOT EXISTS idx_tickets_booking ON tickets (booking_id);

CREATE TABLE IF NOT EXISTS calls (
	id TEXT PRIMARY KEY,
	customer_id TEXT NOT NULL REFERENCES customers (id),
	region_id TEXT NOT NULL,
	-- in | out
	direction TEXT NOT NULL,
	agent_id TEXT,
	started_at TEXT NOT NULL,
	duration_seconds INTEGER NOT NULL DEFAULT 0,
	outcome TEXT,
	-- lead | quotation | booking | ticket | conversation
	linked_type TEXT,
	linked_id TEXT,
	created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_calls_region_started
	ON calls (region_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_calls_customer ON calls (customer_id);

-- Append-only stream behind Customer 360. Every service writes here, so one
-- indexed query returns a customer's whole history in order.
CREATE TABLE IF NOT EXISTS activities (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	customer_id TEXT NOT NULL REFERENCES customers (id),
	region_id TEXT NOT NULL,
	-- whatsapp | handover | call | lead | quotation | booking | milestone | ticket | note
	kind TEXT NOT NULL,
	ref TEXT,
	summary TEXT NOT NULL,
	detail TEXT,
	actor TEXT,
	occurred_at TEXT NOT NULL,
	created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_activities_customer
	ON activities (customer_id, occurred_at DESC);

-- Dense, readable references (L-00001, Q-00001, T-00001, ABC-UAE-000001)
-- need a counter per kind. One row per kind, incremented in a transaction.
CREATE TABLE IF NOT EXISTS ref_sequences (
	kind TEXT PRIMARY KEY,
	next_value INTEGER NOT NULL
);

INSERT OR IGNORE INTO ref_sequences (kind, next_value) VALUES
	('lead', 1),
	('quotation', 1),
	('ticket', 1),
	('booking', 1);
