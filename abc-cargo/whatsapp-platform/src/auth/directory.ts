/**
 * Turns a verified Access identity into a caller the policy can reason about.
 *
 * Access says who someone is. It does not know which ABC Cargo teams they
 * belong to, which regions those teams cover, or whether they have been
 * suspended since this morning — so a person being signed in proves nothing on
 * its own. They also have to be a known, active user here.
 */

import {
	isRole,
	type DenyReason,
	type Role,
	type UserCaller,
} from "./policy.ts";

interface UserRow {
	id: string;
	email: string;
	display_name: string;
	role: string;
	status: string;
}

interface TeamRow {
	team_id: string;
	region_id: string;
}

export type CallerResult =
	| { ok: true; caller: UserCaller }
	| { ok: false; reason: DenyReason; email?: string };

export class Directory {
	constructor(private readonly db: D1Database) {}

	/**
	 * Looks a signed-in person up and assembles their caller.
	 *
	 * Fails closed in three distinct ways, kept distinct because an auditor
	 * reading the access log wants to tell them apart: never set up, set up
	 * and suspended, or set up but in no team.
	 */
	async callerForEmail(email: string): Promise<CallerResult> {
		const normalised = email.trim().toLowerCase();
		if (!normalised) return { ok: false, reason: "no_identity" };

		const user = await this.db
			.prepare(
				`SELECT id, email, display_name, role, status FROM users WHERE email = ?1`,
			)
			.bind(normalised)
			.first<UserRow>();

		if (!user) return { ok: false, reason: "unknown_user", email: normalised };
		if (user.status !== "active") {
			return { ok: false, reason: "suspended", email: normalised };
		}
		// A role the database does not recognise is not a licence to invent
		// one. Treat it as the least privilege rather than the most.
		const role: Role = isRole(user.role) ? user.role : "agent";

		const { results } = await this.db
			.prepare(
				`SELECT ut.team_id AS team_id, t.region_id AS region_id
				 FROM user_teams ut
				 JOIN teams t ON t.id = ut.team_id
				 WHERE ut.user_id = ?1`,
			)
			.bind(user.id)
			.all<TeamRow>();

		const teamIds = (results ?? []).map((row) => row.team_id);
		const regionIds = [...new Set((results ?? []).map((row) => row.region_id))];

		return {
			ok: true,
			caller: {
				kind: "user",
				id: user.id,
				email: user.email,
				displayName: user.display_name,
				role,
				status: "active",
				regionIds,
				teamIds,
			},
		};
	}

	/**
	 * Records what was decided. Denials are written as well as grants: a run
	 * of them is the thing worth noticing, and a log that only holds successes
	 * answers no useful question after an incident.
	 */
	async record(entry: {
		userId?: string | null;
		email?: string | null;
		method: string;
		path: string;
		outcome: "granted" | "denied";
		reason: string;
		now?: string;
	}): Promise<void> {
		const occurredAt = entry.now ?? new Date().toISOString();
		await this.db
			.prepare(
				`INSERT INTO access_log
				   (id, user_id, email, method, path, outcome, reason, occurred_at)
				 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
			)
			.bind(
				`acl_${crypto.randomUUID()}`,
				entry.userId ?? null,
				entry.email ?? null,
				entry.method,
				entry.path,
				entry.outcome,
				entry.reason,
				occurredAt,
			)
			.run();
	}
}
