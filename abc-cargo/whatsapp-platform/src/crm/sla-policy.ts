/**
 * Per-team service targets, and where a given target came from.
 *
 * The screen designs set targets on the team — "UAE Support 5m/4h", "UAE
 * Sales 15m/1d" — while the build so far has set them per region and per
 * ticket type. Both are needed: a team policy is what a supervisor edits, and
 * a regional default is what applies to the teams nobody has configured yet.
 *
 * Two rules shape this file.
 *
 * **The most specific policy wins, and the resolution is explainable.**
 * `resolveTarget` returns the target together with its provenance, because a
 * supervisor looking at a ticket due in five minutes will ask why, and
 * "because UAE Support sets 5 minutes for a claim" is an answer whereas "5"
 * is not. The Setup screen uses the same provenance to show which of its
 * rows are actually in force.
 *
 * **A malformed policy is ignored, not obeyed and not fatal.** A stored
 * policy with a negative target or a missing field must not take a region's
 * whole ticket queue down, and must not silently become the thing the team is
 * measured against. It falls through to the next level and is reported, so
 * the problem is visible in Setup rather than inferred from odd due dates.
 */

import type { SlaTarget } from "./sla.ts";
import { DEFAULT_TICKET_TARGETS, targetFor } from "./sla.ts";
import type { TicketPriority, TicketType } from "./types.ts";
import { TICKET_TYPES } from "./types.ts";

/**
 * A team's service policy, as stored and as edited in Setup.
 *
 * `byType` is partial on purpose: a team that only cares about claims sets
 * claims and inherits the rest. `fallback` is the team's own catch-all, which
 * sits between its per-type entries and the regional default.
 */
export interface TeamSlaPolicy {
	teamId: string;
	regionId: string;
	byType?: Partial<Record<TicketType, SlaTarget>>;
	fallback?: SlaTarget;
}

/** A region's default, for teams with no policy of their own. */
export interface RegionSlaPolicy {
	regionId: string;
	byType?: Partial<Record<TicketType, SlaTarget>>;
	fallback?: SlaTarget;
}

/**
 * Where a resolved target came from, most specific first.
 *
 * `platform_default` is the floor: it always resolves, which is what makes
 * `resolveTarget` total.
 */
export type TargetSource =
	| "team_type"
	| "team_fallback"
	| "region_type"
	| "region_fallback"
	| "platform_default";

export const TARGET_SOURCE_LABELS: Record<TargetSource, string> = {
	team_type: "Team policy for this ticket type",
	team_fallback: "Team default",
	region_type: "Regional policy for this ticket type",
	region_fallback: "Regional default",
	platform_default: "Platform default",
};

export interface ResolvedTarget {
	/** After the priority factor has been applied. */
	target: SlaTarget;
	/** Before the priority factor, as the policy states it. */
	stated: SlaTarget;
	source: TargetSource;
	/** The team whose policy supplied it, when one did. */
	teamId: string | null;
	/**
	 * Policies that were skipped because they did not validate, in the order
	 * they were consulted. Empty in the ordinary case.
	 */
	ignored: IgnoredPolicy[];
}

export interface IgnoredPolicy {
	source: TargetSource;
	teamId: string | null;
	regionId: string | null;
	problem: string;
}

/**
 * The widest target a policy may state, in business minutes.
 *
 * Not a guess at ABC Cargo's policy — a sanity bound. 200 working days is
 * long past the point where a target means anything, and a figure above it is
 * far more likely to be a units mistake (milliseconds pasted into a minutes
 * field) than an intention.
 */
const MAX_POLICY_MINUTES = 200 * 24 * 60;

/**
 * Validates one stated target.
 *
 * Returns the problem as a sentence rather than a boolean, because the only
 * useful thing to do with an invalid policy is tell somebody what is wrong
 * with it.
 */
export function checkTarget(value: unknown): string | null {
	if (value === null || typeof value !== "object") {
		return "not an object";
	}
	const t = value as Partial<SlaTarget>;
	for (const field of ["firstResponseMinutes", "resolutionMinutes"] as const) {
		const n = t[field];
		if (typeof n !== "number" || !Number.isFinite(n)) {
			return `${field} must be a number`;
		}
		if (!Number.isInteger(n)) {
			return `${field} must be a whole number of minutes`;
		}
		if (n <= 0) {
			return `${field} must be greater than zero`;
		}
		if (n > MAX_POLICY_MINUTES) {
			return `${field} is longer than ${MAX_POLICY_MINUTES} minutes`;
		}
	}
	const first = t.firstResponseMinutes as number;
	const resolution = t.resolutionMinutes as number;
	if (resolution < first) {
		// A resolution target inside the first-response target is not a
		// stricter policy, it is a contradiction: the ticket would be late to
		// resolve before anyone was late to answer it.
		return "resolutionMinutes must not be shorter than firstResponseMinutes";
	}
	return null;
}

/**
 * Resolves the target for one ticket, walking from the team's policy out to
 * the platform default.
 *
 * `teamIds` is the teams that could own the ticket, in preference order. In
 * practice a ticket has one owning team and this is a single-element list;
 * the list exists so that a conversation handled by a team that has since
 * been dissolved can fall through to its successor without the caller
 * having to re-implement the walk.
 */
export function resolveTarget(
	type: TicketType,
	priority: TicketPriority,
	options: {
		teamIds?: string[];
		regionId?: string | null;
		teamPolicies?: TeamSlaPolicy[];
		regionPolicies?: RegionSlaPolicy[];
		platformDefaults?: Record<TicketType, SlaTarget>;
	} = {},
): ResolvedTarget {
	const {
		teamIds = [],
		regionId = null,
		teamPolicies = [],
		regionPolicies = [],
		platformDefaults = DEFAULT_TICKET_TARGETS,
	} = options;

	const ignored: IgnoredPolicy[] = [];

	const accept = (
		stated: SlaTarget,
		source: TargetSource,
		teamId: string | null,
	): ResolvedTarget => ({
		target: targetFor(type, priority, {
			...platformDefaults,
			[type]: stated,
		}),
		stated,
		source,
		teamId,
		ignored,
	});

	/** Consults one candidate, recording it as ignored if it does not hold up. */
	const consider = (
		candidate: unknown,
		source: TargetSource,
		teamId: string | null,
		policyRegionId: string | null,
	): SlaTarget | null => {
		if (candidate === undefined || candidate === null) return null;
		const problem = checkTarget(candidate);
		if (problem) {
			ignored.push({ source, teamId, regionId: policyRegionId, problem });
			return null;
		}
		return candidate as SlaTarget;
	};

	// 1 and 2: the owning team's policy, per type then its own fallback.
	for (const teamId of teamIds) {
		const policy = teamPolicies.find((p) => p.teamId === teamId);
		if (!policy) continue;
		// A team policy filed under the wrong region is not applied. Regional
		// scoping is the one thing holding the three countries apart, and a
		// policy is not important enough to be the exception.
		if (regionId !== null && policy.regionId !== regionId) {
			ignored.push({
				source: "team_type",
				teamId,
				regionId: policy.regionId,
				problem: `team belongs to region ${policy.regionId}, not ${regionId}`,
			});
			continue;
		}
		const byType = consider(
			policy.byType?.[type],
			"team_type",
			teamId,
			policy.regionId,
		);
		if (byType) return accept(byType, "team_type", teamId);
		const fallback = consider(
			policy.fallback,
			"team_fallback",
			teamId,
			policy.regionId,
		);
		if (fallback) return accept(fallback, "team_fallback", teamId);
	}

	// 3 and 4: the region's policy.
	if (regionId !== null) {
		const policy = regionPolicies.find((p) => p.regionId === regionId);
		if (policy) {
			const byType = consider(
				policy.byType?.[type],
				"region_type",
				null,
				regionId,
			);
			if (byType) return accept(byType, "region_type", null);
			const fallback = consider(
				policy.fallback,
				"region_fallback",
				null,
				regionId,
			);
			if (fallback) return accept(fallback, "region_fallback", null);
		}
	}

	// 5: the platform default, which is always well-formed because it is in
	// the source rather than the database.
	return accept(platformDefaults[type], "platform_default", null);
}

/**
 * Validates a whole policy before it is stored.
 *
 * Setup calls this on save so a bad policy is refused at the point someone
 * can still fix it, rather than quietly ignored later by `resolveTarget`.
 */
export function validateTeamPolicy(policy: TeamSlaPolicy): string[] {
	const errors: string[] = [];
	if (!policy.teamId?.trim()) errors.push("teamId is required");
	if (!policy.regionId?.trim()) errors.push("regionId is required");

	for (const [type, target] of Object.entries(policy.byType ?? {})) {
		if (!(TICKET_TYPES as readonly string[]).includes(type)) {
			errors.push(`${type} is not a ticket type`);
			continue;
		}
		const problem = checkTarget(target);
		if (problem) errors.push(`${type}: ${problem}`);
	}

	if (policy.fallback !== undefined) {
		const problem = checkTarget(policy.fallback);
		if (problem) errors.push(`fallback: ${problem}`);
	}

	if (!policy.fallback && Object.keys(policy.byType ?? {}).length === 0) {
		// An empty policy is not an error, but it is almost certainly not what
		// the person meant, so it is reported as one rather than saved as a
		// row that does nothing.
		errors.push("policy sets no targets");
	}

	return errors;
}

/**
 * The effective targets for every ticket type, for one team.
 *
 * This is what the Setup screen shows: a full table where each row says what
 * the target is and which level supplied it, so inherited rows and overridden
 * rows are distinguishable at a glance.
 */
export function effectivePolicyTable(options: {
	teamId: string;
	regionId: string;
	teamPolicies?: TeamSlaPolicy[];
	regionPolicies?: RegionSlaPolicy[];
	platformDefaults?: Record<TicketType, SlaTarget>;
}): Array<{
	type: TicketType;
	stated: SlaTarget;
	source: TargetSource;
	inherited: boolean;
}> {
	return TICKET_TYPES.map((type) => {
		const resolved = resolveTarget(type, "normal", {
			teamIds: [options.teamId],
			regionId: options.regionId,
			teamPolicies: options.teamPolicies,
			regionPolicies: options.regionPolicies,
			platformDefaults: options.platformDefaults,
		});
		return {
			type,
			stated: resolved.stated,
			source: resolved.source,
			inherited:
				resolved.source !== "team_type" && resolved.source !== "team_fallback",
		};
	});
}
