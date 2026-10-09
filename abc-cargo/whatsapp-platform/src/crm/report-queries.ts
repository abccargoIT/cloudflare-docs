/**
 * The rows behind the report library and the deflection figure.
 *
 * Same rules as `reports.ts`: every query is scoped to one region and
 * aggregated in SQL, and a figure the platform does not record is absent
 * rather than estimated. The shaping — CSV, series, the deflection
 * definition — is done by the pure modules; this file only counts.
 *
 * **Service targets live on tickets.** The live platform sets first-response
 * and resolution due dates when a ticket opens, not when a conversation does,
 * so "first response against target" is counted over tickets. A conversation
 * that never became a ticket has no target to be measured against, and is
 * not counted as on time or late.
 */

import type { SessionOutcomeInput } from "./deflection.ts";
import type { SessionEndReason } from "../bots/types.ts";
import type { ReportWindow, TicketTypeRow } from "./report-library.ts";
import { TICKET_TYPES, type TicketType } from "./types.ts";

/**
 * Senders that are not a person.
 *
 * `bot` is a flow's message, `auto` the out-of-hours reply, `system` a
 * notification and `survey` a satisfaction question. A message from anyone
 * else on the outbound side was written by a colleague, which is what
 * "a human replied" means for deflection.
 */
export const AUTOMATED_SENDERS = ["bot", "auto", "system", "survey"] as const;

/** The longest day series a report will draw, so one request cannot ask for years. */
export const MAX_REPORT_DAYS = 92;

const DAY_MS = 86_400_000;

export interface VolumeRow {
	day: string;
	regionId: string;
	conversations: number;
	[key: string]: unknown;
}

export interface FirstResponseRow {
	regionId: string;
	answered: number;
	withinTarget: number;
	late: number;
	unanswered: number;
	[key: string]: unknown;
}

export type DeflectionSessionRow = SessionOutcomeInput & {
	flowId: string;
	regionId: string;
	lastStepId: string | null;
};

export class ReportQueries {
	private readonly db: D1Database;

	constructor(db: D1Database) {
		this.db = db;
	}

	/**
	 * New conversations per UTC day, per region, with empty days present.
	 *
	 * A day with no conversations is a zero, not a gap: dropped, it would
	 * draw a quiet Friday as though it never happened and the x-axis would
	 * stop being a calendar.
	 */
	async volumeByDay(
		regionIds: string[],
		window: ReportWindow,
	): Promise<VolumeRow[]> {
		const days = daysIn(window);
		const rows: VolumeRow[] = [];
		for (const regionId of regionIds) {
			const result = await this.db
				.prepare(
					`SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS n
					   FROM conversations
					  WHERE region_id = ?1 AND created_at >= ?2 AND created_at <= ?3
					  GROUP BY day`,
				)
				.bind(regionId, window.from, window.to)
				.all<{ day: string; n: number }>();
			const counts = new Map(
				(result.results ?? []).map((r) => [r.day, r.n] as const),
			);
			for (const day of days) {
				rows.push({ day, regionId, conversations: counts.get(day) ?? 0 });
			}
		}
		return rows;
	}

	/** Tickets opened in the window, by whether the first reply met its target. */
	async firstResponse(
		regionIds: string[],
		window: ReportWindow,
	): Promise<FirstResponseRow[]> {
		const rows: FirstResponseRow[] = [];
		for (const regionId of regionIds) {
			const row = await this.db
				.prepare(
					`SELECT
					   SUM(CASE WHEN first_response_at IS NOT NULL THEN 1 ELSE 0 END) AS answered,
					   SUM(CASE WHEN first_response_at IS NOT NULL
					             AND first_response_at <= first_response_due_at THEN 1 ELSE 0 END) AS within,
					   SUM(CASE WHEN first_response_at IS NOT NULL
					             AND first_response_at > first_response_due_at THEN 1 ELSE 0 END) AS late,
					   SUM(CASE WHEN first_response_at IS NULL THEN 1 ELSE 0 END) AS waiting
					  FROM tickets
					 WHERE region_id = ?1 AND created_at >= ?2 AND created_at <= ?3`,
				)
				.bind(regionId, window.from, window.to)
				.first<{
					answered: number | null;
					within: number | null;
					late: number | null;
					waiting: number | null;
				}>();
			rows.push({
				regionId,
				answered: row?.answered ?? 0,
				withinTarget: row?.within ?? 0,
				late: row?.late ?? 0,
				unanswered: row?.waiting ?? 0,
			});
		}
		return rows;
	}

	/**
	 * Opened and resolved in the window, and overdue now, per ticket type.
	 *
	 * Overdue is the state at the moment of asking rather than a count over
	 * the window, because "how many are late" is a question about today.
	 * Every type is present, at zero where nothing was raised.
	 */
	async ticketsByType(
		regionIds: string[],
		window: ReportWindow,
		now: Date = new Date(),
	): Promise<TicketTypeRow[]> {
		const totals = new Map<TicketType, TicketTypeRow>(
			TICKET_TYPES.map((type) => [
				type,
				{ type, opened: 0, resolved: 0, overdue: 0 },
			]),
		);
		const bump = (
			type: string,
			key: "opened" | "resolved" | "overdue",
			n: number,
		) => {
			const row = totals.get(type as TicketType);
			// A type the platform no longer offers is not invented as a row.
			if (row) row[key] += n;
		};

		for (const regionId of regionIds) {
			const [opened, resolved, overdue] = await Promise.all([
				this.db
					.prepare(
						`SELECT type, COUNT(*) AS n FROM tickets
						  WHERE region_id = ?1 AND created_at >= ?2 AND created_at <= ?3
						  GROUP BY type`,
					)
					.bind(regionId, window.from, window.to)
					.all<{ type: string; n: number }>(),
				this.db
					.prepare(
						`SELECT type, COUNT(*) AS n FROM tickets
						  WHERE region_id = ?1 AND resolved_at >= ?2 AND resolved_at <= ?3
						  GROUP BY type`,
					)
					.bind(regionId, window.from, window.to)
					.all<{ type: string; n: number }>(),
				this.db
					.prepare(
						`SELECT type, COUNT(*) AS n FROM tickets
						  WHERE region_id = ?1 AND status IN ('open', 'pending')
						    AND resolution_due_at < ?2
						  GROUP BY type`,
					)
					.bind(regionId, now.toISOString())
					.all<{ type: string; n: number }>(),
			]);
			for (const r of opened.results ?? []) bump(r.type, "opened", r.n);
			for (const r of resolved.results ?? []) bump(r.type, "resolved", r.n);
			for (const r of overdue.results ?? []) bump(r.type, "overdue", r.n);
		}
		return [...totals.values()];
	}

	/**
	 * Every bot session started in the window, with whether a person replied.
	 *
	 * "A person replied" is any outbound message on the conversation from a
	 * sender that is not automated. It is asked of the conversation as a
	 * whole, because the question deflection answers is whether the customer
	 * needed a colleague — and a colleague who replied after the flow ended
	 * still answered it.
	 */
	async deflectionSessions(
		regionIds: string[],
		window: ReportWindow,
	): Promise<DeflectionSessionRow[]> {
		const placeholders = AUTOMATED_SENDERS.map((_, i) => `?${i + 4}`).join(
			", ",
		);
		const rows: DeflectionSessionRow[] = [];
		for (const regionId of regionIds) {
			const result = await this.db
				.prepare(
					`SELECT s.flow_id, s.region_id, s.ended_at, s.ended_reason,
					        COALESCE(s.step_id, (
					          SELECT t.from_step_id FROM bot_turns t
					           WHERE t.conversation_id = s.conversation_id
					           ORDER BY t.occurred_at DESC LIMIT 1
					        )) AS last_step_id,
					        EXISTS (
					          SELECT 1 FROM messages m
					           WHERE m.conversation_id = s.conversation_id
					             AND m.direction = 'out'
					             AND m.sent_by IS NOT NULL
					             AND m.sent_by NOT IN (${placeholders})
					        ) AS human
					   FROM bot_sessions s
					  WHERE s.region_id = ?1 AND s.started_at >= ?2 AND s.started_at <= ?3`,
				)
				.bind(regionId, window.from, window.to, ...AUTOMATED_SENDERS)
				.all<{
					flow_id: string;
					region_id: string;
					last_step_id: string | null;
					ended_at: string | null;
					ended_reason: string | null;
					human: number;
				}>();
			for (const r of result.results ?? []) {
				rows.push({
					flowId: r.flow_id,
					regionId: r.region_id,
					// An ended session no longer has a current step, so the step it
					// was last waiting on comes from its final turn — which is
					// exactly where an abandoned customer stopped.
					lastStepId: r.last_step_id,
					ended: r.ended_at !== null,
					endedReason: (r.ended_reason as SessionEndReason | null) ?? null,
					humanReplied: r.human === 1,
				});
			}
		}
		return rows;
	}
}

/**
 * The UTC days a window touches, oldest first, capped at MAX_REPORT_DAYS
 * counted back from the end so the most recent days are always the ones kept.
 */
export function daysIn(window: ReportWindow): string[] {
	const from = Date.parse(window.from);
	const to = Date.parse(window.to);
	if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return [];
	const start = Math.floor(from / DAY_MS) * DAY_MS;
	const end = Math.floor(to / DAY_MS) * DAY_MS;
	const days: string[] = [];
	for (let t = end; t >= start && days.length < MAX_REPORT_DAYS; t -= DAY_MS) {
		days.push(new Date(t).toISOString().slice(0, 10));
	}
	return days.reverse();
}

/**
 * Shortens a window to at most MAX_REPORT_DAYS, keeping its end.
 *
 * Applied once by the route, so every report in one export covers the same
 * span — a volume chart cut to 92 days beside a ticket table over a year
 * would be two reports pretending to be one.
 */
export function clampWindow(window: ReportWindow): ReportWindow {
	const from = Date.parse(window.from);
	const to = Date.parse(window.to);
	if (!Number.isFinite(from) || !Number.isFinite(to)) return window;
	// The start of the earliest UTC day kept, so the clamped window touches
	// exactly MAX_REPORT_DAYS calendar days and `daysIn` drops none of them.
	const earliest =
		Math.floor(to / DAY_MS) * DAY_MS - (MAX_REPORT_DAYS - 1) * DAY_MS;
	return from >= earliest
		? window
		: { from: new Date(earliest).toISOString(), to: window.to };
}
