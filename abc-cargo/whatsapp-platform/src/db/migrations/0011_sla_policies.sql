-- Per-team and per-region service targets.
--
-- The rules live in src/crm/sla-policy.ts: the most specific policy wins, team
-- type before team default before region type before region default before
-- the platform default. These two tables are only where a supervisor's
-- choices are kept.
--
-- The policy is stored as JSON rather than as a column per ticket type, and
-- that is deliberate. A ticket type added later must not need a migration to
-- be given a target, and a policy that sets only claims must be able to say
-- nothing about the rest — which a column per type cannot express without
-- inventing a NULL convention.
--
-- A stored policy is never trusted. resolveTarget validates every entry on
-- read and falls through past a bad one, reporting it, so a hand-edited row
-- with a negative target cannot take a region's ticket queue down.

CREATE TABLE IF NOT EXISTS team_sla_policies (
	team_id TEXT PRIMARY KEY REFERENCES teams (id),
	-- Copied from the team so a policy filed under the wrong region can be
	-- detected and refused (resolveTarget does), rather than silently applied
	-- to another country's tickets.
	region_id TEXT NOT NULL,
	-- { "byType": { "<type>": { "firstResponseMinutes": n, "resolutionMinutes": n } },
	--   "fallback": { ... } }
	policy TEXT NOT NULL,
	updated_by TEXT,
	updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_team_sla_policies_region
	ON team_sla_policies (region_id);

CREATE TABLE IF NOT EXISTS region_sla_policies (
	region_id TEXT PRIMARY KEY,
	policy TEXT NOT NULL,
	updated_by TEXT,
	updated_at TEXT NOT NULL
);
