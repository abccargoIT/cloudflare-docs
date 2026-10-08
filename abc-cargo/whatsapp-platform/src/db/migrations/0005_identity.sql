-- Who the people using the platform are, and what each of them may see.
--
-- Until now every caller of /api/* presented one shared key and saw
-- everything. For a centralised platform serving three regions that is the
-- wrong shape: a UAE agent should not be able to read a KSA conversation, and
-- the design is explicit that an agent sees only their own conversations.
--
-- Region is already a column on every operational table. What was missing was
-- a person to compare it against.

CREATE TABLE IF NOT EXISTS users (
	id TEXT PRIMARY KEY,
	-- The identity the authenticating layer asserts. Lower-cased on write so
	-- a lookup never misses on capitalisation.
	email TEXT NOT NULL UNIQUE,
	display_name TEXT NOT NULL,
	-- agent | team_lead | master_admin
	role TEXT NOT NULL DEFAULT 'agent',
	-- active | suspended. Suspended keeps the row, and the history that points
	-- at it, while refusing every request.
	status TEXT NOT NULL DEFAULT 'active',
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_role ON users (role, status);

CREATE TABLE IF NOT EXISTS teams (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	region_id TEXT NOT NULL,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_teams_region ON teams (region_id);

-- A person may belong to more than one team, and therefore to more than one
-- region: the design calls for multi-team users, and a supervisor covering
-- UAE and KSA is an ordinary case rather than an exception.
CREATE TABLE IF NOT EXISTS user_teams (
	user_id TEXT NOT NULL REFERENCES users (id),
	team_id TEXT NOT NULL REFERENCES teams (id),
	created_at TEXT NOT NULL,
	PRIMARY KEY (user_id, team_id)
);

CREATE INDEX IF NOT EXISTS idx_user_teams_team ON user_teams (team_id);

-- Every decision the platform makes about who may see what, recorded.
--
-- Separate from `activities`, which is the customer's history. This is the
-- platform's own history, and an auditor asking "who read this customer's
-- conversation" is asking a different question from "what happened to this
-- customer". Denials are recorded as well as grants, because a run of denials
-- is the thing worth noticing.
CREATE TABLE IF NOT EXISTS access_log (
	id TEXT PRIMARY KEY,
	user_id TEXT,
	email TEXT,
	method TEXT NOT NULL,
	path TEXT NOT NULL,
	-- granted | denied
	outcome TEXT NOT NULL,
	-- Why, in a word: ok | no_identity | unknown_user | suspended |
	-- wrong_region | not_assigned | insufficient_role
	reason TEXT NOT NULL,
	occurred_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_access_log_time ON access_log (occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_access_log_denied
	ON access_log (outcome, occurred_at DESC)
	WHERE outcome = 'denied';
