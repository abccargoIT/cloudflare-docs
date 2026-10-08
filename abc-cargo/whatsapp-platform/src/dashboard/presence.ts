/**
 * Who is actually at a desk.
 *
 * This is the single source of truth for presence, used by the dashboard and
 * by the automated reply. They must not have separate answers: the auto-reply
 * tells a customer "all our agents are currently assisting other customers"
 * when it believes nobody is online, and a dashboard showing three people
 * online while customers are being told that is a fault nobody would think to
 * look for.
 *
 * Two things here are corrections rather than new behaviour.
 *
 * **Presence is resolved through the identity model.** `agent_presence` is
 * keyed by whatever id posted it, and once the console is behind Cloudflare
 * Access that is a `users.id`. The original query joined the older `agents`
 * table, so every presence row posted by a real signed-in person would have
 * matched nothing and the platform would have believed the office was empty
 * at all times — which in turn would have sent the "all our agents are busy"
 * reply to every in-hours message. Both id spaces are handled here while both
 * exist.
 *
 * **Presence goes stale.** A browser closed without posting "offline" leaves
 * an "online" row behind for ever. An agent who went home three hours ago
 * suppressing the automated reply is the worst version of this: the customer
 * gets neither a person nor an acknowledgement. So a row is only believed for
 * as long as the console is expected to keep refreshing it.
 */

/**
 * How long a presence row is believed without being refreshed.
 *
 * The console should re-post well inside this. Failing towards "nobody is
 * here" is the safe direction: the customer gets an automated acknowledgement
 * they did not strictly need, rather than silence.
 */
export const PRESENCE_TTL_MINUTES = 15;

export interface OnlinePerson {
	id: string;
	name: string;
	/** Null means they cover every region — a master admin, or a legacy agent. */
	regionIds: string[] | null;
	/** Which identity space the row came from, while both exist. */
	source: "user" | "legacy";
}

interface PresenceRow {
	id: string;
	name: string | null;
	region_id: string | null;
}

export function staleBefore(
	now: Date,
	ttlMinutes = PRESENCE_TTL_MINUTES,
): string {
	return new Date(now.getTime() - ttlMinutes * 60_000).toISOString();
}

export class Presence {
	private readonly db: D1Database;

	constructor(db: D1Database) {
		this.db = db;
	}

	/**
	 * Everyone online, however their presence row is keyed.
	 *
	 * Two queries rather than a union, because each side carries its regions
	 * differently and merging them in SQL would make both harder to read than
	 * the merge below.
	 */
	async online(now: Date = new Date()): Promise<OnlinePerson[]> {
		const cutoff = staleBefore(now);

		const [identity, legacy] = await this.db.batch<PresenceRow>([
			// A person with no team covers every region, which is how a master
			// admin appears here. That matches the legacy table's NULL region.
			this.db
				.prepare(
					`SELECT p.agent_id AS id, u.display_name AS name, t.region_id
					 FROM agent_presence p
					 JOIN users u ON u.id = p.agent_id
					 LEFT JOIN user_teams ut ON ut.user_id = u.id
					 LEFT JOIN teams t ON t.id = ut.team_id
					 WHERE p.status = 'online' AND u.status = 'active'
					   AND p.updated_at >= ?1`,
				)
				.bind(cutoff),
			this.db
				.prepare(
					`SELECT p.agent_id AS id, a.name AS name, a.region_id
					 FROM agent_presence p
					 JOIN agents a ON a.id = p.agent_id
					 WHERE p.status = 'online' AND a.active = 1
					   AND p.updated_at >= ?1
					   AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = p.agent_id)`,
				)
				.bind(cutoff),
		]);

		const people = new Map<string, OnlinePerson>();
		const add = (row: PresenceRow, source: OnlinePerson["source"]): void => {
			const existing = people.get(row.id);
			if (!existing) {
				people.set(row.id, {
					id: row.id,
					name: row.name ?? row.id,
					regionIds: row.region_id === null ? null : [row.region_id],
					source,
				});
				return;
			}
			// A second row is a second team. Null already means every region, so
			// it is never narrowed by one.
			if (existing.regionIds === null) return;
			if (row.region_id === null) existing.regionIds = null;
			else if (!existing.regionIds.includes(row.region_id)) {
				existing.regionIds.push(row.region_id);
			}
		};

		for (const row of identity?.results ?? []) add(row, "user");
		for (const row of legacy?.results ?? []) add(row, "legacy");
		return [...people.values()];
	}

	/** How many of them cover a given region. */
	async countIn(regionId: string, now: Date = new Date()): Promise<number> {
		return countOnlineIn(await this.online(now), regionId);
	}
}

/** Pure: how many of a list of online people cover a region. */
export function countOnlineIn(
	people: OnlinePerson[],
	regionId: string,
): number {
	return people.filter((p) => coversRegion(p, regionId)).length;
}

/** Pure: whether one person covers a region. */
export function coversRegion(person: OnlinePerson, regionId: string): boolean {
	return person.regionIds === null || person.regionIds.includes(regionId);
}
