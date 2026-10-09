/**
 * Where per-team service targets are kept, and the one place they are used.
 *
 * The rules are in `sla-policy.ts` and are pure. This file only reads and
 * writes the two policy tables, and — the reason it exists — computes a
 * ticket's due dates through those rules rather than through the platform
 * defaults alone. Before this file, a supervisor could have set UAE Support to
 * five minutes and every ticket would still have been given thirty.
 *
 * A stored policy is never trusted. Rows are parsed defensively and handed to
 * `resolveTarget`, which validates every entry and falls past a bad one; a row
 * that is not even valid JSON is skipped and reported here, so one corrupt row
 * cannot take a region's tickets down.
 */

import type { RegionConfig } from "../regions.ts";
import { addBusinessMinutes, type SlaTarget } from "./sla.ts";
import {
	resolveTarget,
	type RegionSlaPolicy,
	type ResolvedTarget,
	type TeamSlaPolicy,
} from "./sla-policy.ts";
import type { TicketPriority, TicketType } from "./types.ts";

interface PolicyJson {
	byType?: Partial<Record<TicketType, SlaTarget>>;
	fallback?: SlaTarget;
}

/** A stored row that could not be read at all. */
export interface UnreadablePolicy {
	kind: "team" | "region";
	key: string;
	problem: string;
}

export interface DueDates {
	firstResponseDueAt: string;
	resolutionDueAt: string;
	/** Which level of policy supplied the target, for the ticket's record. */
	resolved: ResolvedTarget;
}

export class SlaPolicyStore {
	private readonly db: D1Database;

	constructor(db: D1Database) {
		this.db = db;
	}

	async teamPolicies(): Promise<{
		policies: TeamSlaPolicy[];
		unreadable: UnreadablePolicy[];
	}> {
		const rows = await this.db
			.prepare(`SELECT team_id, region_id, policy FROM team_sla_policies`)
			.all<{ team_id: string; region_id: string; policy: string }>();
		const policies: TeamSlaPolicy[] = [];
		const unreadable: UnreadablePolicy[] = [];
		for (const row of rows.results ?? []) {
			const parsed = parsePolicy(row.policy);
			if ("problem" in parsed) {
				unreadable.push({
					kind: "team",
					key: row.team_id,
					problem: parsed.problem,
				});
				continue;
			}
			policies.push({
				teamId: row.team_id,
				regionId: row.region_id,
				...parsed,
			});
		}
		return { policies, unreadable };
	}

	async regionPolicies(): Promise<{
		policies: RegionSlaPolicy[];
		unreadable: UnreadablePolicy[];
	}> {
		const rows = await this.db
			.prepare(`SELECT region_id, policy FROM region_sla_policies`)
			.all<{ region_id: string; policy: string }>();
		const policies: RegionSlaPolicy[] = [];
		const unreadable: UnreadablePolicy[] = [];
		for (const row of rows.results ?? []) {
			const parsed = parsePolicy(row.policy);
			if ("problem" in parsed) {
				unreadable.push({
					kind: "region",
					key: row.region_id,
					problem: parsed.problem,
				});
				continue;
			}
			policies.push({ regionId: row.region_id, ...parsed });
		}
		return { policies, unreadable };
	}

	/**
	 * Stores a team's policy. The caller validates first — see the route —
	 * because refusing a bad policy at the point somebody can fix it is the
	 * whole difference between a validation error and a mystery.
	 */
	async saveTeamPolicy(
		policy: TeamSlaPolicy,
		actor: string,
		now: Date = new Date(),
	): Promise<void> {
		const body: PolicyJson = {};
		if (policy.byType) body.byType = policy.byType;
		if (policy.fallback) body.fallback = policy.fallback;
		await this.db
			.prepare(
				`INSERT INTO team_sla_policies (team_id, region_id, policy, updated_by, updated_at)
				 VALUES (?1, ?2, ?3, ?4, ?5)
				 ON CONFLICT(team_id) DO UPDATE SET
				   region_id = excluded.region_id,
				   policy = excluded.policy,
				   updated_by = excluded.updated_by,
				   updated_at = excluded.updated_at`,
			)
			.bind(
				policy.teamId,
				policy.regionId,
				JSON.stringify(body),
				actor,
				now.toISOString(),
			)
			.run();
	}

	async deleteTeamPolicy(teamId: string): Promise<boolean> {
		const result = await this.db
			.prepare(`DELETE FROM team_sla_policies WHERE team_id = ?1`)
			.bind(teamId)
			.run();
		return (result.meta?.changes ?? 0) > 0;
	}

	/**
	 * The team that owns a conversation, or null. Fails safe to null: a
	 * ticket without a team falls back to its region's policy, which is
	 * exactly what it had before transfers existed.
	 */
	async teamForConversation(conversationId: string): Promise<string | null> {
		try {
			const row = await this.db
				.prepare(`SELECT assigned_team_id FROM conversations WHERE id = ?1`)
				.bind(conversationId)
				.first<{ assigned_team_id: string | null }>();
			return row?.assigned_team_id ?? null;
		} catch (error) {
			console.error("could not read the conversation's team", {
				conversationId,
				error: error instanceof Error ? error.message : String(error),
			});
			return null;
		}
	}

	/**
	 * A ticket's due dates, through the team's policy where it has one.
	 *
	 * `teamId` is the team that owns the conversation the ticket came from,
	 * which after a transfer may be a team in another region. The calendar is
	 * still the ticket's own region's: a target is counted in the business
	 * minutes of the desk that will answer it.
	 */
	async dueDates(input: {
		region: RegionConfig;
		type: TicketType;
		priority: TicketPriority;
		teamId?: string | null;
		now?: Date;
	}): Promise<DueDates> {
		const now = input.now ?? new Date();

		// A policy is a refinement, never a dependency. Before this file,
		// opening a ticket did not read the database to work out its
		// deadlines; if the policy tables are missing (a migration not yet
		// applied) or a query fails, the ticket must still open — on the
		// platform defaults — rather than every new claim being refused
		// because of a supervisor setting.
		let teams: { policies: TeamSlaPolicy[]; unreadable: UnreadablePolicy[] } = {
			policies: [],
			unreadable: [],
		};
		let regions: {
			policies: RegionSlaPolicy[];
			unreadable: UnreadablePolicy[];
		} = {
			policies: [],
			unreadable: [],
		};
		try {
			[teams, regions] = await Promise.all([
				this.teamPolicies(),
				this.regionPolicies(),
			]);
		} catch (error) {
			console.error("SLA policies unavailable; using platform defaults", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
		for (const bad of [...teams.unreadable, ...regions.unreadable]) {
			console.warn("unreadable SLA policy skipped", bad);
		}
		const resolved = resolveTarget(input.type, input.priority, {
			teamIds: input.teamId ? [input.teamId] : [],
			regionId: input.region.id,
			teamPolicies: teams.policies,
			regionPolicies: regions.policies,
		});
		return {
			firstResponseDueAt: addBusinessMinutes(
				input.region,
				now,
				resolved.target.firstResponseMinutes,
			).toISOString(),
			resolutionDueAt: addBusinessMinutes(
				input.region,
				now,
				resolved.target.resolutionMinutes,
			).toISOString(),
			resolved,
		};
	}
}

/**
 * Reads a stored policy. Returns the problem rather than throwing: an
 * unreadable row is reported and skipped, never fatal.
 */
export function parsePolicy(text: string): PolicyJson | { problem: string } {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return { problem: "not valid JSON" };
	}
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return { problem: "not a JSON object" };
	}
	const v = value as Record<string, unknown>;
	const out: PolicyJson = {};
	if (v.byType !== undefined) {
		if (
			v.byType === null ||
			typeof v.byType !== "object" ||
			Array.isArray(v.byType)
		) {
			return { problem: "byType is not an object" };
		}
		out.byType = v.byType as PolicyJson["byType"];
	}
	// Entries are passed through unvalidated on purpose: resolveTarget checks
	// each one and reports the bad ones individually, which is more useful
	// than refusing the whole row for one wrong number.
	if (v.fallback !== undefined) out.fallback = v.fallback as SlaTarget;
	return out;
}
