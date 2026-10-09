/**
 * The checks that run before an administrative change is written.
 *
 * Pure functions, so the awkward cases can be exercised without a database.
 * The awkward cases are the point of this file: adding a user is easy, and
 * every interesting failure here is about taking something away.
 */

import { isRole, type Role } from "../auth/policy.ts";

export type AdminRefusal =
	| "invalid_email"
	| "invalid_name"
	| "invalid_role"
	| "invalid_status"
	| "last_administrator"
	| "self_demotion"
	| "unknown_region";

export type AdminCheck =
	{ ok: true } | { ok: false; reason: AdminRefusal; message: string };

const OK: AdminCheck = { ok: true };
const no = (reason: AdminRefusal, message: string): AdminCheck => ({
	ok: false,
	reason,
	message,
});

export const USER_STATUSES = ["active", "suspended"] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export function isUserStatus(value: string): value is UserStatus {
	return (USER_STATUSES as readonly string[]).includes(value);
}

/**
 * Lower-cased and trimmed, because Access asserts an address and a directory
 * lookup that misses on capitalisation locks somebody out for no reason.
 */
export function normaliseEmail(value: string): string {
	return value.trim().toLowerCase();
}

/**
 * Deliberately permissive. The authority on whether an address is real is the
 * identity provider, which will not issue an assertion for one that is not.
 * This only rejects what could not be an address at all, so a legitimate but
 * unusual one is never refused on a guess.
 */
export function looksLikeEmail(value: string): boolean {
	const trimmed = value.trim();
	if (trimmed.length < 3 || trimmed.length > 320) return false;
	if (/\s/.test(trimmed)) return false;
	const at = trimmed.indexOf("@");
	if (at <= 0 || at !== trimmed.lastIndexOf("@")) return false;
	return at < trimmed.length - 1;
}

export interface UserInput {
	email: string;
	displayName: string;
	role: string;
	status?: string;
}

export function validateUser(input: UserInput): AdminCheck {
	if (!looksLikeEmail(input.email)) {
		return no("invalid_email", "a work email address is required");
	}
	if (input.displayName.trim().length === 0) {
		return no("invalid_name", "a display name is required");
	}
	if (!isRole(input.role)) {
		return no("invalid_role", "role must be agent, team_lead or master_admin");
	}
	if (input.status !== undefined && !isUserStatus(input.status)) {
		return no("invalid_status", "status must be active or suspended");
	}
	return OK;
}

/**
 * Stops the platform being locked out of its own administration.
 *
 * The failure this prevents is quiet and complete: the last master admin
 * demotes or suspends themselves, and from that moment nobody can create a
 * user, change a role or undo it. Recovery means someone writing SQL against
 * the production database, which is exactly the situation this platform exists
 * to avoid.
 *
 * `activeAdminIds` is every active master admin, including the target.
 */
export function checkAdministratorRemains(
	activeAdminIds: string[],
	targetUserId: string,
	next: { role?: Role; status?: UserStatus },
): AdminCheck {
	const stillAdmin =
		(next.role === undefined || next.role === "master_admin") &&
		(next.status === undefined || next.status === "active");
	if (stillAdmin) return OK;

	const remaining = activeAdminIds.filter((id) => id !== targetUserId);
	if (remaining.length > 0) return OK;

	return no(
		"last_administrator",
		"this is the only active administrator; appoint another before changing this one",
	);
}

/**
 * A separate, narrower refusal for the common version of the same mistake.
 *
 * Someone removing their own administrator role in a tidy-up is far more
 * likely than someone doing it to a colleague, and "you cannot remove your own
 * administrator role" is a clearer thing to read than a note about counts.
 */
export function checkNotSelfDemotion(
	actingUserId: string,
	targetUserId: string,
	next: { role?: Role; status?: UserStatus },
): AdminCheck {
	if (actingUserId !== targetUserId) return OK;
	if (next.role !== undefined && next.role !== "master_admin") {
		return no(
			"self_demotion",
			"you cannot remove your own administrator role; ask another administrator",
		);
	}
	if (next.status === "suspended") {
		return no("self_demotion", "you cannot suspend your own account");
	}
	return OK;
}

export interface TeamInput {
	name: string;
	regionId: string;
}

export function validateTeam(
	input: TeamInput,
	knownRegionIds: string[],
): AdminCheck {
	if (input.name.trim().length === 0) {
		return no("invalid_name", "a team name is required");
	}
	if (!knownRegionIds.includes(input.regionId)) {
		return no(
			"unknown_region",
			`region must be one of ${knownRegionIds.join(", ")}`,
		);
	}
	return OK;
}

/**
 * Runs every applicable check and returns the first refusal.
 *
 * One entry point so a new rule cannot be added in one place and forgotten in
 * another — which is how a guard ends up protecting the API but not the
 * importer.
 */
export function checkUserChange(input: {
	actingUserId: string;
	targetUserId: string;
	activeAdminIds: string[];
	next: { role?: Role; status?: UserStatus };
}): AdminCheck {
	const selfCheck = checkNotSelfDemotion(
		input.actingUserId,
		input.targetUserId,
		input.next,
	);
	if (!selfCheck.ok) return selfCheck;
	return checkAdministratorRemains(
		input.activeAdminIds,
		input.targetUserId,
		input.next,
	);
}
