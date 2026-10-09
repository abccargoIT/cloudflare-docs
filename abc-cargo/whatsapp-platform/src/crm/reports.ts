/**
 * The figures behind the dashboard and the report library.
 *
 * Two rules shape this file.
 *
 * Every query is **scoped to one region and aggregated in SQL**. Counting rows
 * in the Worker would mean fetching them first, which both costs more and
 * quietly bypasses the region scoping that the route applies — the safest
 * aggregate is the one that never had the other regions in hand.
 *
 * Nothing here invents a figure. A metric that cannot be computed from what
 * the platform actually records is absent rather than estimated, because a
 * dashboard that shows a plausible number nobody can trace is worse than one
 * that shows a gap.
 */

/** A closed interval, as ISO 8601 instants. */
export interface Window {
	from: string;
	to: string;
}

export interface RegionSummary {
	regionId: string;
	conversations: {
		open: number;
		pending: number;
		resolved: number;
		unassigned: number;
		/** Open conversations whose first reply is already late. */
		firstResponseOverdue: number;
	};
	tickets: {
		open: number;
		overdueFirstResponse: number;
		overdueResolution: number;
		byType: Record<string, number>;
	};
	leads: { open: number; won: number; lost: number };
	bookings: { active: number; delivered: number };
	calls: { inbound: number; outbound: number };
}

export interface Summary {
	window: Window;
	generatedAt: string;
	regions: RegionSummary[];
	totals: Omit<RegionSummary, "regionId">;
}

/**
 * The window a dashboard defaults to: the last fourteen days, ending now.
 *
 * Fourteen rather than seven so a fortnightly pattern is visible and a single
 * quiet week does not read as a trend.
 */
export function defaultWindow(now: Date = new Date(), days = 14): Window {
	const to = new Date(now.getTime());
	const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
	return { from: from.toISOString(), to: to.toISOString() };
}

/** Parses a requested window, falling back to the default on anything odd. */
export function parseWindow(
	fromParam: string | null,
	toParam: string | null,
	now: Date = new Date(),
): Window {
	const fallback = defaultWindow(now);
	const from = fromParam ? Date.parse(fromParam) : NaN;
	const to = toParam ? Date.parse(toParam) : NaN;
	if (!Number.isFinite(from) || !Number.isFinite(to)) return fallback;
	// A backwards window is a mistake, not a request for nothing.
	if (to <= from) return fallback;
	return { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
}

function emptyRegion(regionId: string): RegionSummary {
	return {
		regionId,
		conversations: {
			open: 0,
			pending: 0,
			resolved: 0,
			unassigned: 0,
			firstResponseOverdue: 0,
		},
		tickets: {
			open: 0,
			overdueFirstResponse: 0,
			overdueResolution: 0,
			byType: {},
		},
		leads: { open: 0, won: 0, lost: 0 },
		bookings: { active: 0, delivered: 0 },
		calls: { inbound: 0, outbound: 0 },
	};
}

/** Adds one region's figures into a running total. */
export function addInto(
	total: Omit<RegionSummary, "regionId">,
	region: RegionSummary,
): void {
	total.conversations.open += region.conversations.open;
	total.conversations.pending += region.conversations.pending;
	total.conversations.resolved += region.conversations.resolved;
	total.conversations.unassigned += region.conversations.unassigned;
	total.conversations.firstResponseOverdue +=
		region.conversations.firstResponseOverdue;

	total.tickets.open += region.tickets.open;
	total.tickets.overdueFirstResponse += region.tickets.overdueFirstResponse;
	total.tickets.overdueResolution += region.tickets.overdueResolution;
	for (const [type, count] of Object.entries(region.tickets.byType)) {
		total.tickets.byType[type] = (total.tickets.byType[type] ?? 0) + count;
	}

	total.leads.open += region.leads.open;
	total.leads.won += region.leads.won;
	total.leads.lost += region.leads.lost;
	total.bookings.active += region.bookings.active;
	total.bookings.delivered += region.bookings.delivered;
	total.calls.inbound += region.calls.inbound;
	total.calls.outbound += region.calls.outbound;
}

interface CountRow {
	k: string | null;
	n: number;
}

export class Reports {
	private readonly db: D1Database;

	constructor(db: D1Database) {
		this.db = db;
	}

	/**
	 * One region's figures for a window.
	 *
	 * `now` is a parameter rather than read from the clock so "overdue" is
	 * computed against a time the caller chose, and so the behaviour can be
	 * exercised at a fixed instant.
	 */
	async forRegion(
		regionId: string,
		window: Window,
		now: Date = new Date(),
	): Promise<RegionSummary> {
		const nowIso = now.toISOString();
		const summary = emptyRegion(regionId);

		const [
			conversations,
			overdueConversations,
			tickets,
			lateTickets,
			leads,
			bookings,
			calls,
		] = await this.db.batch<CountRow>([
			this.db
				.prepare(
					`SELECT status AS k, COUNT(*) AS n FROM conversations
						 WHERE region_id = ?1 AND updated_at BETWEEN ?2 AND ?3
						 GROUP BY status`,
				)
				.bind(regionId, window.from, window.to),
			// Unassigned, and of those the ones already late. A conversation
			// is late when the window has moved past its target and nobody
			// has answered, which is why both halves are counted here.
			this.db
				.prepare(
					`SELECT 'unassigned' AS k, COUNT(*) AS n FROM conversations
						   WHERE region_id = ?1 AND status != 'resolved'
						     AND assigned_agent_id IS NULL
						 UNION ALL
						 SELECT 'overdue' AS k, COUNT(*) AS n FROM conversations
						   WHERE region_id = ?1 AND status != 'resolved'
						     AND last_outbound_at IS NULL
						     AND last_inbound_at IS NOT NULL
						     AND last_inbound_at < ?2`,
				)
				.bind(regionId, nowIso),
			this.db
				.prepare(
					`SELECT type AS k, COUNT(*) AS n FROM tickets
						 WHERE region_id = ?1 AND status IN ('open','pending')
						 GROUP BY type`,
				)
				.bind(regionId),
			this.db
				.prepare(
					`SELECT 'first_response' AS k, COUNT(*) AS n FROM tickets
						   WHERE region_id = ?1 AND status IN ('open','pending')
						     AND first_response_at IS NULL
						     AND first_response_due_at < ?2
						 UNION ALL
						 SELECT 'resolution' AS k, COUNT(*) AS n FROM tickets
						   WHERE region_id = ?1 AND status IN ('open','pending')
						     AND resolved_at IS NULL AND resolution_due_at < ?2`,
				)
				.bind(regionId, nowIso),
			this.db
				.prepare(
					`SELECT CASE
						           WHEN stage IN ('won') THEN 'won'
						           WHEN stage IN ('lost') THEN 'lost'
						           ELSE 'open' END AS k,
						        COUNT(*) AS n
						 FROM leads WHERE region_id = ?1
						   AND updated_at BETWEEN ?2 AND ?3
						 GROUP BY k`,
				)
				.bind(regionId, window.from, window.to),
			this.db
				.prepare(
					`SELECT CASE WHEN milestone = 'delivered' THEN 'delivered'
						             ELSE 'active' END AS k,
						        COUNT(*) AS n
						 FROM bookings WHERE region_id = ?1
						 GROUP BY k`,
				)
				.bind(regionId),
			this.db
				.prepare(
					`SELECT direction AS k, COUNT(*) AS n FROM calls
						 WHERE region_id = ?1 AND started_at BETWEEN ?2 AND ?3
						 GROUP BY direction`,
				)
				.bind(regionId, window.from, window.to),
		]);

		// `batch` is typed as possibly short, so each result is read
		// defensively: a missing result reads as zero rather than throwing on
		// a dashboard.
		const read = (
			result: D1Result<CountRow> | undefined,
			key: string,
		): number => (result?.results ?? []).find((row) => row.k === key)?.n ?? 0;

		summary.conversations.open = read(conversations, "open");
		summary.conversations.pending = read(conversations, "pending");
		summary.conversations.resolved = read(conversations, "resolved");
		summary.conversations.unassigned = read(overdueConversations, "unassigned");
		summary.conversations.firstResponseOverdue = read(
			overdueConversations,
			"overdue",
		);

		for (const row of tickets?.results ?? []) {
			if (!row.k) continue;
			summary.tickets.byType[row.k] = row.n;
			summary.tickets.open += row.n;
		}
		summary.tickets.overdueFirstResponse = read(lateTickets, "first_response");
		summary.tickets.overdueResolution = read(lateTickets, "resolution");

		summary.leads.open = read(leads, "open");
		summary.leads.won = read(leads, "won");
		summary.leads.lost = read(leads, "lost");
		summary.bookings.active = read(bookings, "active");
		summary.bookings.delivered = read(bookings, "delivered");
		summary.calls.inbound = read(calls, "in");
		summary.calls.outbound = read(calls, "out");

		return summary;
	}

	/** The same figures for several regions, plus a total across them. */
	async summary(
		regionIds: string[],
		window: Window,
		now: Date = new Date(),
	): Promise<Summary> {
		const regions = await Promise.all(
			regionIds.map((regionId) => this.forRegion(regionId, window, now)),
		);
		const totals = emptyRegion("");
		for (const region of regions) addInto(totals, region);
		const { regionId: _discard, ...rest } = totals;
		return {
			window,
			generatedAt: now.toISOString(),
			regions,
			totals: rest,
		};
	}
}
