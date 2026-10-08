/**
 * Setup: the people, the teams, and the record of who was let in.
 *
 * Everything here is master-admin only, enforced at the route. The guards in
 * `guards.ts` run before any write, and the one that matters most is the
 * lockout check — a platform nobody can administer is recovered by writing SQL
 * against production, which is the situation this exists to avoid.
 */

import type { Role } from "../auth/policy.ts";
import {
	checkUserChange,
	normaliseEmail,
	type AdminCheck,
	type UserStatus,
} from "./guards.ts";

export interface UserRecord {
	id: string;
	email: string;
	display_name: string;
	role: string;
	status: string;
	created_at: string;
	updated_at: string;
}

export interface TeamRecord {
	id: string;
	name: string;
	region_id: string;
	created_at: string;
	updated_at: string;
}

export interface UserWithTeams extends UserRecord {
	teams: { id: string; name: string; regionId: string }[];
}

export interface AccessLogRow {
	id: string;
	user_id: string | null;
	email: string | null;
	method: string;
	path: string;
	outcome: string;
	reason: string;
	occurred_at: string;
}

function newId(prefix: string): string {
	return `${prefix}_${crypto.randomUUID()}`;
}

export class AdminService {
	private readonly db: D1Database;

	constructor(db: D1Database) {
		this.db = db;
	}

	/* ------------------------------------------------------------- people */

	/** Everyone, with the teams each belongs to. Two queries, not one per user. */
	async listUsers(limit = 200): Promise<UserWithTeams[]> {
		const { results: users } = await this.db
			.prepare(`SELECT * FROM users ORDER BY role, display_name LIMIT ?1`)
			.bind(Math.min(Math.max(limit, 1), 500))
			.all<UserRecord>();

		const rows = users ?? [];
		if (rows.length === 0) return [];

		const { results: memberships } = await this.db
			.prepare(
				`SELECT ut.user_id, t.id AS team_id, t.name, t.region_id
				 FROM user_teams ut JOIN teams t ON t.id = ut.team_id`,
			)
			.all<{
				user_id: string;
				team_id: string;
				name: string;
				region_id: string;
			}>();

		const byUser = new Map<string, UserWithTeams["teams"]>();
		for (const row of memberships ?? []) {
			const list = byUser.get(row.user_id) ?? [];
			list.push({ id: row.team_id, name: row.name, regionId: row.region_id });
			byUser.set(row.user_id, list);
		}

		return rows.map((user) => ({ ...user, teams: byUser.get(user.id) ?? [] }));
	}

	async getUser(id: string): Promise<UserRecord | null> {
		return this.db
			.prepare(`SELECT * FROM users WHERE id = ?1`)
			.bind(id)
			.first<UserRecord>();
	}

	/** Every active master admin, which is what the lockout guard needs. */
	async activeAdministratorIds(): Promise<string[]> {
		const { results } = await this.db
			.prepare(
				`SELECT id FROM users WHERE role = 'master_admin' AND status = 'active'`,
			)
			.all<{ id: string }>();
		return (results ?? []).map((row) => row.id);
	}

	async createUser(input: {
		email: string;
		displayName: string;
		role: Role;
		now?: Date;
	}): Promise<UserRecord> {
		const nowIso = (input.now ?? new Date()).toISOString();
		const id = newId("usr");
		await this.db
			.prepare(
				`INSERT INTO users (id, email, display_name, role, status, created_at, updated_at)
				 VALUES (?1, ?2, ?3, ?4, 'active', ?5, ?5)`,
			)
			.bind(
				id,
				normaliseEmail(input.email),
				input.displayName.trim(),
				input.role,
				nowIso,
			)
			.run();

		const created = await this.getUser(id);
		if (!created) throw new Error("failed to create the user");
		return created;
	}

	/**
	 * Changes a role or status, after the lockout guards.
	 *
	 * The guards are run here rather than only at the route, so a second
	 * caller — an importer, a script — cannot route around them.
	 */
	async updateUser(input: {
		actingUserId: string;
		targetUserId: string;
		role?: Role;
		status?: UserStatus;
		displayName?: string;
		now?: Date;
	}): Promise<
		{ ok: false; check: AdminCheck } | { ok: true; user: UserRecord }
	> {
		const check = checkUserChange({
			actingUserId: input.actingUserId,
			targetUserId: input.targetUserId,
			activeAdminIds: await this.activeAdministratorIds(),
			next: { role: input.role, status: input.status },
		});
		if (!check.ok) return { ok: false, check };

		const nowIso = (input.now ?? new Date()).toISOString();
		await this.db
			.prepare(
				`UPDATE users SET
				   role = COALESCE(?2, role),
				   status = COALESCE(?3, status),
				   display_name = COALESCE(?4, display_name),
				   updated_at = ?5
				 WHERE id = ?1`,
			)
			.bind(
				input.targetUserId,
				input.role ?? null,
				input.status ?? null,
				input.displayName?.trim() || null,
				nowIso,
			)
			.run();

		const user = await this.getUser(input.targetUserId);
		if (!user) throw new Error("user disappeared during update");
		return { ok: true, user };
	}

	/* -------------------------------------------------------------- teams */

	async listTeams(): Promise<TeamRecord[]> {
		const { results } = await this.db
			.prepare(`SELECT * FROM teams ORDER BY region_id, name`)
			.all<TeamRecord>();
		return results ?? [];
	}

	async createTeam(input: {
		name: string;
		regionId: string;
		now?: Date;
	}): Promise<TeamRecord> {
		const nowIso = (input.now ?? new Date()).toISOString();
		const id = newId("team");
		await this.db
			.prepare(
				`INSERT INTO teams (id, name, region_id, created_at, updated_at)
				 VALUES (?1, ?2, ?3, ?4, ?4)`,
			)
			.bind(id, input.name.trim(), input.regionId, nowIso)
			.run();
		const created = await this.db
			.prepare(`SELECT * FROM teams WHERE id = ?1`)
			.bind(id)
			.first<TeamRecord>();
		if (!created) throw new Error("failed to create the team");
		return created;
	}

	/**
	 * Adds somebody to a team, which is how they reach a region.
	 *
	 * Idempotent: adding twice is a tidy-up, not an error worth showing an
	 * administrator.
	 */
	async addToTeam(
		userId: string,
		teamId: string,
		now: Date = new Date(),
	): Promise<void> {
		await this.db
			.prepare(
				`INSERT INTO user_teams (user_id, team_id, created_at)
				 VALUES (?1, ?2, ?3)
				 ON CONFLICT (user_id, team_id) DO NOTHING`,
			)
			.bind(userId, teamId, now.toISOString())
			.run();
	}

	/**
	 * Removes somebody from a team, and with it their reach into that region.
	 *
	 * Nothing historical is touched. Their conversations, tickets and chat
	 * messages remain, because the record of what happened should not change
	 * when somebody moves desk.
	 */
	async removeFromTeam(userId: string, teamId: string): Promise<void> {
		await this.db
			.prepare(`DELETE FROM user_teams WHERE user_id = ?1 AND team_id = ?2`)
			.bind(userId, teamId)
			.run();
	}

	/* ---------------------------------------------------------- audit log */

	/**
	 * Who was let in, and who was turned away.
	 *
	 * Denials first when asked for them, because a run of refusals is the
	 * thing worth noticing and it is easily lost in a list dominated by
	 * ordinary successful requests.
	 */
	async accessLog(
		options: {
			deniedOnly?: boolean;
			limit?: number;
		} = {},
	): Promise<AccessLogRow[]> {
		const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
		const sql = options.deniedOnly
			? `SELECT * FROM access_log WHERE outcome = 'denied'
			   ORDER BY occurred_at DESC LIMIT ?1`
			: `SELECT * FROM access_log ORDER BY occurred_at DESC LIMIT ?1`;
		const { results } = await this.db
			.prepare(sql)
			.bind(limit)
			.all<AccessLogRow>();
		return results ?? [];
	}
}
