/**
 * The dashboard: what needs doing, right now.
 *
 * The line between this module and `crm/reports.ts` is worth stating, because
 * the two look similar and are not. Reports answer "how did we do over a
 * window", aggregated the same way in every region so the three can be
 * compared, and the design puts them behind a supervisor. The dashboard
 * answers "what is waiting, who is here, is the office open" — the agent's own
 * work and the state of the queue, in each region's own hours. An agent must
 * see one and not the other.
 *
 * Two rules hold throughout.
 *
 * **Nothing is counted outside the caller's scope.** Every query takes the
 * region list the route resolved, and an agent's share of the attention list
 * is narrowed again to the conversations they may actually read — their own
 * and the unclaimed ones. Without that second narrowing a dashboard would hand
 * an agent a preview of every colleague's conversation, which is precisely
 * what `canReadConversation` exists to prevent.
 *
 * **Nothing is invented.** A figure the platform does not record is absent.
 * There is no satisfaction score and no average handling time here, because
 * neither is measured yet, and a dashboard carrying a plausible number nobody
 * can trace is worse than one carrying a gap.
 */

import { isBreached } from "../crm/sla.ts";
import type { RegionConfig } from "../regions.ts";
import {
	describeMinutes,
	greeting,
	minutesSince,
	officeState,
	regionalDay,
	type OfficeState,
} from "./clock.ts";
import { countOnlineIn, Presence, type OnlinePerson } from "./presence.ts";

export interface QueueState {
	/** Conversations not yet resolved. */
	waiting: number;
	/** Of those, the ones nobody has claimed. */
	unassigned: number;
	/** Of those, the ones where the customer has spoken since we last did. */
	unanswered: number;
	/** How long the longest-unanswered customer has been waiting. */
	longestWaitMinutes: number | null;
	longestWait: string;
}

export interface DashboardRegion {
	regionId: string;
	label: string;
	office: OfficeState;
	/** Phrased for the strip: "opens in 2 hours 14 minutes". */
	officeChanges: string;
	queue: QueueState;
	tickets: { open: number; breaching: number };
	/** Counted between this region's own midnights. */
	today: { inbound: number; outbound: number; newConversations: number };
	onlineNow: number;
	/** Names only. Who is about is not a performance figure. */
	online: { id: string; name: string }[];
	/**
	 * Open conversations per colleague. Supervisors only — this is where a
	 * queue view turns into a comparison between people.
	 */
	workload?: { agentId: string; open: number }[];
}

export interface AttentionItem {
	kind: "conversation" | "ticket";
	id: string;
	regionId: string;
	/** A ticket's reference; a conversation has none to show. */
	ref?: string;
	/** What it is, in a few words. Never the customer's own text. */
	summary: string;
	/** Minutes a customer has been waiting, or minutes past a target. */
	minutes: number | null;
	waited: string;
	breached: boolean;
}

export interface MyQueue {
	assigned: number;
	unanswered: number;
	tickets: number;
	ticketsBreaching: number;
}

export interface Dashboard {
	greeting: string;
	/** A snapshot, not a stream. Shown so nobody reads a stale tab as live. */
	generatedAt: string;
	regions: DashboardRegion[];
	totals: {
		waiting: number;
		unassigned: number;
		unanswered: number;
		ticketsOpen: number;
		ticketsBreaching: number;
		onlineNow: number;
	};
	attention: AttentionItem[];
	/** Absent for a service caller, which has no desk. */
	mine?: MyQueue;
}

/**
 * One aggregate from a keyed `UNION ALL`.
 *
 * `n` is deliberately wide: most of these queries count, but the one asking
 * for the longest-waiting customer returns a timestamp through the same shape.
 * Typing it as a number and reading a string out of it would be a lie the
 * compiler could not catch.
 */
interface StatRow {
	k: string | null;
	n: number | string | null;
}

/** A counted aggregate, or zero when the row is absent. */
function count(result: D1Result<StatRow> | undefined, key: string): number {
	const value = (result?.results ?? []).find((row) => row.k === key)?.n;
	return typeof value === "number" ? value : 0;
}

/** A text aggregate, or null when the row is absent or not text. */
function text(
	result: D1Result<StatRow> | undefined,
	key: string,
): string | null {
	const value = (result?.results ?? []).find((row) => row.k === key)?.n;
	return typeof value === "string" ? value : null;
}

/** The condition that makes a conversation "unanswered", in one place. */
const UNANSWERED = `last_inbound_at IS NOT NULL
	 AND (last_outbound_at IS NULL OR last_outbound_at < last_inbound_at)`;

const OPEN_TICKET = `status IN ('open','pending')`;

/** A ticket is breaching when either of its two clocks has run out. */
const TICKET_BREACHING = `(
	 (first_response_at IS NULL AND first_response_due_at < ?now)
	 OR (resolved_at IS NULL AND resolution_due_at < ?now)
 )`;

export class DashboardService {
	private readonly db: D1Database;
	private readonly presence: Presence;

	constructor(db: D1Database) {
		this.db = db;
		this.presence = new Presence(db);
	}

	/**
	 * The whole dashboard for one caller.
	 *
	 * `regions` is already narrowed to what the caller may see; this method
	 * does not widen it. `now` is a parameter so "overdue" is measured against
	 * a time the caller chose and the behaviour can be exercised at a fixed
	 * instant.
	 */
	async build(input: {
		regions: RegionConfig[];
		displayName?: string | null;
		/** The caller's user id, or null for a service caller. */
		userId: string | null;
		/** True for a supervisor: adds the per-colleague breakdown. */
		includeWorkload: boolean;
		/** False for an agent: narrows the attention list to what they may read. */
		seesEveryConversation: boolean;
		attentionLimit?: number;
		now?: Date;
	}): Promise<Dashboard> {
		const now = input.now ?? new Date();
		const online = await this.presence.online(now);

		const regions = await Promise.all(
			input.regions.map((region) =>
				this.forRegion({
					region,
					online,
					includeWorkload: input.includeWorkload,
					now,
				}),
			),
		);

		const totals = {
			waiting: 0,
			unassigned: 0,
			unanswered: 0,
			ticketsOpen: 0,
			ticketsBreaching: 0,
			onlineNow: 0,
		};
		for (const region of regions) {
			totals.waiting += region.queue.waiting;
			totals.unassigned += region.queue.unassigned;
			totals.unanswered += region.queue.unanswered;
			totals.ticketsOpen += region.tickets.open;
			totals.ticketsBreaching += region.tickets.breaching;
		}
		// Counted across the distinct people, not summed per region: somebody
		// covering two regions is one person at one desk.
		totals.onlineNow = online.filter((person) =>
			input.regions.some((region) => countOnlineIn([person], region.id) > 0),
		).length;

		return {
			// Greeted in the hours of the first region they work in. An admin
			// spanning three timezones is greeted in the first configured
			// region's hours, which is a guess, but a stated one.
			greeting: greeting({
				displayName: input.displayName,
				now,
				timezone: input.regions[0]?.timezone ?? "UTC",
			}),
			generatedAt: now.toISOString(),
			regions,
			totals,
			attention: await this.attention({
				regionIds: input.regions.map((r) => r.id),
				userId: input.userId,
				seesEveryConversation: input.seesEveryConversation,
				limit: input.attentionLimit ?? 12,
				now,
			}),
			mine: input.userId ? await this.myQueue(input.userId, now) : undefined,
		};
	}

	/* ------------------------------------------------------------ a region */

	private async forRegion(input: {
		region: RegionConfig;
		online: OnlinePerson[];
		includeWorkload: boolean;
		now: Date;
	}): Promise<DashboardRegion> {
		const { region, now } = input;
		const nowIso = now.toISOString();
		const day = regionalDay(now, region.timezone);

		const statements = [
			this.db
				.prepare(
					`SELECT 'waiting' AS k, COUNT(*) AS n FROM conversations
					   WHERE region_id = ?1 AND status != 'resolved'
					 UNION ALL
					 SELECT 'unassigned' AS k, COUNT(*) AS n FROM conversations
					   WHERE region_id = ?1 AND status != 'resolved'
					     AND assigned_agent_id IS NULL
					 UNION ALL
					 SELECT 'unanswered' AS k, COUNT(*) AS n FROM conversations
					   WHERE region_id = ?1 AND status != 'resolved' AND ${UNANSWERED}`,
				)
				.bind(region.id),
			this.db
				.prepare(
					`SELECT 'oldest' AS k, MIN(last_inbound_at) AS n FROM conversations
					   WHERE region_id = ?1 AND status != 'resolved' AND ${UNANSWERED}`,
				)
				.bind(region.id),
			this.db
				.prepare(
					`SELECT 'open' AS k, COUNT(*) AS n FROM tickets
					   WHERE region_id = ?1 AND ${OPEN_TICKET}
					 UNION ALL
					 SELECT 'breaching' AS k, COUNT(*) AS n FROM tickets
					   WHERE region_id = ?1 AND ${OPEN_TICKET}
					     AND ${TICKET_BREACHING.replace(/\?now/g, "?2")}`,
				)
				.bind(region.id, nowIso),
			// Today in this region's own hours. The join is needed because a
			// message carries its conversation, not its region.
			this.db
				.prepare(
					`SELECT m.direction AS k, COUNT(*) AS n
					 FROM messages m JOIN conversations c ON c.id = m.conversation_id
					 WHERE c.region_id = ?1
					   AND m.wa_timestamp >= ?2 AND m.wa_timestamp < ?3
					 GROUP BY m.direction`,
				)
				.bind(region.id, day.from, day.to),
			this.db
				.prepare(
					`SELECT 'new' AS k, COUNT(*) AS n FROM conversations
					   WHERE region_id = ?1 AND created_at >= ?2 AND created_at < ?3`,
				)
				.bind(region.id, day.from, day.to),
		];

		if (input.includeWorkload) {
			statements.push(
				this.db
					.prepare(
						`SELECT assigned_agent_id AS k, COUNT(*) AS n FROM conversations
						   WHERE region_id = ?1 AND status != 'resolved'
						     AND assigned_agent_id IS NOT NULL
						 GROUP BY assigned_agent_id
						 ORDER BY n DESC`,
					)
					.bind(region.id),
			);
		}

		const results = await this.db.batch<StatRow>(statements);
		const [queueRow, oldestRow, ticketRow, messageRow, newRow, workloadRow] =
			results;

		// `batch` is typed as possibly short, so every result is read
		// defensively. A missing one reads as zero: a dashboard that throws is
		// worse than a dashboard showing a nought.
		const longestWaitMinutes = minutesSince(text(oldestRow, "oldest"), now);

		const office = officeState(region, now);
		const onlineHere = input.online.filter(
			(person) => countOnlineIn([person], region.id) > 0,
		);

		return {
			regionId: region.id,
			label: region.label,
			office,
			officeChanges:
				office.nextChange === null
					? "no working hours configured"
					: `${office.nextChange} in ${describeMinutes(office.changesInMinutes)}`,
			queue: {
				waiting: count(queueRow, "waiting"),
				unassigned: count(queueRow, "unassigned"),
				unanswered: count(queueRow, "unanswered"),
				longestWaitMinutes,
				longestWait:
					longestWaitMinutes === null
						? "nobody waiting"
						: describeMinutes(longestWaitMinutes),
			},
			tickets: {
				open: count(ticketRow, "open"),
				breaching: count(ticketRow, "breaching"),
			},
			today: {
				inbound: count(messageRow, "in"),
				outbound: count(messageRow, "out"),
				newConversations: count(newRow, "new"),
			},
			onlineNow: onlineHere.length,
			online: onlineHere.map((person) => ({
				id: person.id,
				name: person.name,
			})),
			workload: input.includeWorkload
				? (workloadRow?.results ?? [])
						.filter(
							(row): row is StatRow & { k: string; n: number } =>
								row.k !== null && typeof row.n === "number",
						)
						.map((row) => ({ agentId: row.k, open: row.n }))
				: undefined,
		};
	}

	/* ---------------------------------------------------------- attention */

	/**
	 * The things that need somebody now, worst first.
	 *
	 * This is the part of a dashboard that earns its place: a count tells you
	 * there is a problem, a list tells you which one to open. Customers who
	 * have been waiting longest come before tickets past their target, because
	 * a person waiting on a reply is the more immediate failure.
	 */
	private async attention(input: {
		regionIds: string[];
		userId: string | null;
		seesEveryConversation: boolean;
		limit: number;
		now: Date;
	}): Promise<AttentionItem[]> {
		if (input.regionIds.length === 0) return [];
		const limit = Math.min(Math.max(input.limit, 1), 50);
		const regionPlaceholders = input.regionIds
			.map((_, i) => `?${i + 1}`)
			.join(", ");

		// Placeholder numbers are derived from the bindings as they are added,
		// rather than counted by hand. Counting by hand is how a dashboard ends
		// up comparing an agent id against a limit.
		const conversationBindings: (string | number)[] = [...input.regionIds];
		let conversationSql = `SELECT id, region_id, last_inbound_at
			 FROM conversations
			 WHERE region_id IN (${regionPlaceholders})
			   AND status != 'resolved' AND ${UNANSWERED}`;
		if (!input.seesEveryConversation) {
			// An agent sees their own conversations and the unclaimed ones,
			// exactly as `canReadConversation` allows. Without this the
			// dashboard would be a way round it.
			conversationBindings.push(input.userId ?? "");
			conversationSql += ` AND (assigned_agent_id IS NULL
			   OR assigned_agent_id = ?${conversationBindings.length})`;
		}
		conversationBindings.push(limit);
		conversationSql += ` ORDER BY last_inbound_at ASC
			 LIMIT ?${conversationBindings.length}`;

		const [conversations, tickets] = await Promise.all([
			this.db
				.prepare(conversationSql)
				.bind(...conversationBindings)
				.all<{
					id: string;
					region_id: string;
					last_inbound_at: string | null;
				}>(),
			this.db
				.prepare(
					`SELECT id, ref, region_id, type, first_response_at,
					        first_response_due_at, resolved_at, resolution_due_at
					 FROM tickets
					 WHERE region_id IN (${regionPlaceholders}) AND ${OPEN_TICKET}
					 ORDER BY MIN(first_response_due_at, resolution_due_at) ASC
					 LIMIT ?${input.regionIds.length + 1}`,
				)
				.bind(...input.regionIds, limit)
				.all<{
					id: string;
					ref: string;
					region_id: string;
					type: string;
					first_response_at: string | null;
					first_response_due_at: string;
					resolved_at: string | null;
					resolution_due_at: string;
				}>(),
		]);

		const items: AttentionItem[] = [];

		for (const row of conversations.results ?? []) {
			const minutes = minutesSince(row.last_inbound_at, input.now);
			items.push({
				kind: "conversation",
				id: row.id,
				regionId: row.region_id,
				summary: "Customer waiting for a reply",
				minutes,
				waited: minutes === null ? "unknown" : describeMinutes(minutes),
				// Measured against the conversation first-response target
				// elsewhere; here the plain fact of a long wait is the signal.
				breached: minutes !== null && minutes > 60,
			});
		}

		for (const row of tickets.results ?? []) {
			const dueAt =
				row.first_response_at === null
					? row.first_response_due_at
					: row.resolution_due_at;
			const breached = isBreached(dueAt, input.now);
			const over = minutesSince(dueAt, input.now);
			items.push({
				kind: "ticket",
				id: row.id,
				regionId: row.region_id,
				ref: row.ref,
				summary:
					row.first_response_at === null
						? `${row.type} awaiting first reply`
						: `${row.type} awaiting resolution`,
				minutes: breached ? over : null,
				waited: breached
					? `${describeMinutes(over)} past target`
					: "within target",
				breached,
			});
		}

		// A waiting customer outranks a ticket past its target, and within each
		// the longest wait comes first.
		const rank = (item: AttentionItem) =>
			item.kind === "conversation" ? 0 : 1;
		items.sort(
			(a, b) =>
				Number(b.breached) - Number(a.breached) ||
				rank(a) - rank(b) ||
				(b.minutes ?? -1) - (a.minutes ?? -1),
		);
		return items.slice(0, limit);
	}

	/* ------------------------------------------------------------ my queue */

	private async myQueue(userId: string, now: Date): Promise<MyQueue> {
		const nowIso = now.toISOString();
		const [conversations, tickets] = await this.db.batch<StatRow>([
			this.db
				.prepare(
					`SELECT 'assigned' AS k, COUNT(*) AS n FROM conversations
					   WHERE assigned_agent_id = ?1 AND status != 'resolved'
					 UNION ALL
					 SELECT 'unanswered' AS k, COUNT(*) AS n FROM conversations
					   WHERE assigned_agent_id = ?1 AND status != 'resolved'
					     AND ${UNANSWERED}`,
				)
				.bind(userId),
			this.db
				.prepare(
					`SELECT 'open' AS k, COUNT(*) AS n FROM tickets
					   WHERE owner_agent_id = ?1 AND ${OPEN_TICKET}
					 UNION ALL
					 SELECT 'breaching' AS k, COUNT(*) AS n FROM tickets
					   WHERE owner_agent_id = ?1 AND ${OPEN_TICKET}
					     AND ${TICKET_BREACHING.replace(/\?now/g, "?2")}`,
				)
				.bind(userId, nowIso),
		]);

		return {
			assigned: count(conversations, "assigned"),
			unanswered: count(conversations, "unanswered"),
			tickets: count(tickets, "open"),
			ticketsBreaching: count(tickets, "breaching"),
		};
	}
}
