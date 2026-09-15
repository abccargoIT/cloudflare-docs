/**
 * Service targets measured in business minutes.
 *
 * A target counted in wall-clock time is unfair to a region and misleading
 * to management: a ticket raised at 17:55 in the UK is not late at 09:05 the
 * next morning. Every due date here is computed by walking the region's own
 * business calendar, so the clock only runs while the team is open.
 */

import type { RegionConfig } from "../regions.ts";
import { localClock, toMinutes } from "../business-hours.ts";
import type { TicketPriority, TicketType } from "./types.ts";

const MINUTE = 60_000;
const DAY_MINUTES = 1440;

/** Guard against an unreachable target when a calendar has no working days. */
const MAX_DAYS_SCANNED = 400;

export interface SlaTarget {
	/** Business minutes allowed before the first human response. */
	firstResponseMinutes: number;
	/** Business minutes allowed before the ticket is resolved. */
	resolutionMinutes: number;
}

/**
 * Defaults pending the SLA policy export from Freshworks. They are written
 * here rather than scattered through the code so that replacing them with
 * ABC Cargo's real policy is a single edit.
 */
export const DEFAULT_TICKET_TARGETS: Record<TicketType, SlaTarget> = {
	claim: { firstResponseMinutes: 30, resolutionMinutes: 8 * 60 },
	delay: { firstResponseMinutes: 30, resolutionMinutes: 8 * 60 },
	billing: { firstResponseMinutes: 120, resolutionMinutes: 24 * 60 },
	documentation: { firstResponseMinutes: 120, resolutionMinutes: 24 * 60 },
	delivery: { firstResponseMinutes: 60, resolutionMinutes: 12 * 60 },
	general: { firstResponseMinutes: 120, resolutionMinutes: 24 * 60 },
};

/** Priority shortens the clock; it never lengthens it. */
const PRIORITY_FACTOR: Record<TicketPriority, number> = {
	urgent: 0.25,
	high: 0.5,
	normal: 1,
	low: 1,
};

/** First response target for a conversation, before any ticket exists. */
export const CONVERSATION_FIRST_RESPONSE_MINUTES = 5;

export function targetFor(
	type: TicketType,
	priority: TicketPriority,
	targets: Record<TicketType, SlaTarget> = DEFAULT_TICKET_TARGETS,
): SlaTarget {
	const base = targets[type];
	const factor = PRIORITY_FACTOR[priority];
	return {
		firstResponseMinutes: Math.max(
			5,
			Math.round(base.firstResponseMinutes * factor),
		),
		resolutionMinutes: Math.max(
			15,
			Math.round(base.resolutionMinutes * factor),
		),
	};
}

/**
 * Adds business minutes to an instant, skipping closed hours and closed
 * days in the region's own timezone.
 *
 * The walk is minute-accurate at the boundaries and day-accurate in between,
 * so a 24-hour target on a 9-hour calendar lands on the correct day rather
 * than the same evening.
 */
export function addBusinessMinutes(
	region: RegionConfig,
	from: Date,
	minutes: number,
): Date {
	if (!Number.isFinite(minutes) || minutes < 0) {
		throw new Error("minutes must be a non-negative number");
	}
	const { days, start, end } = region.businessHours;
	if (days.length === 0) {
		throw new Error(
			`region ${region.id} has no working days; cannot compute a target`,
		);
	}
	const openAt = toMinutes(start);
	const closeAt = toMinutes(end);
	if (closeAt <= openAt) {
		throw new Error(
			`region ${region.id} business hours must end after they start`,
		);
	}
	const dayCapacity = closeAt - openAt;

	let cursor = new Date(from.getTime());
	let remaining = minutes;

	for (let guard = 0; guard <= MAX_DAYS_SCANNED; guard++) {
		const { weekday, minutes: nowMinutes } = localClock(
			cursor,
			region.timezone,
		);

		if (!days.includes(weekday)) {
			cursor = advanceToNextOpen(cursor, nowMinutes, openAt);
			continue;
		}

		if (nowMinutes < openAt) {
			// Before opening: jump forward to the opening bell, same day.
			cursor = new Date(cursor.getTime() + (openAt - nowMinutes) * MINUTE);
			continue;
		}

		if (nowMinutes >= closeAt) {
			cursor = advanceToNextOpen(cursor, nowMinutes, openAt);
			continue;
		}

		const availableToday = closeAt - nowMinutes;
		if (remaining <= availableToday) {
			return new Date(cursor.getTime() + remaining * MINUTE);
		}
		remaining -= availableToday;
		// Move to closing time, then on to the next opening.
		cursor = advanceToNextOpen(cursor, closeAt, openAt);

		if (remaining > dayCapacity * MAX_DAYS_SCANNED) break;
	}

	throw new Error(
		`could not place an SLA target for region ${region.id} within ${MAX_DAYS_SCANNED} days`,
	);
}

/**
 * Moves the cursor to the opening time of the following calendar day.
 * `currentMinutes` is the local minute-of-day the cursor is sitting on.
 */
function advanceToNextOpen(
	cursor: Date,
	currentMinutes: number,
	openAt: number,
): Date {
	const toMidnight = DAY_MINUTES - currentMinutes;
	return new Date(cursor.getTime() + (toMidnight + openAt) * MINUTE);
}

export interface TicketDueDates {
	firstResponseDueAt: string;
	resolutionDueAt: string;
}

export function ticketDueDates(
	region: RegionConfig,
	type: TicketType,
	priority: TicketPriority,
	from: Date = new Date(),
	targets?: Record<TicketType, SlaTarget>,
): TicketDueDates {
	const target = targetFor(type, priority, targets);
	return {
		firstResponseDueAt: addBusinessMinutes(
			region,
			from,
			target.firstResponseMinutes,
		).toISOString(),
		resolutionDueAt: addBusinessMinutes(
			region,
			from,
			target.resolutionMinutes,
		).toISOString(),
	};
}

/** Milliseconds remaining against a due date; negative once it has passed. */
export function remainingMs(dueAt: string, now: Date = new Date()): number {
	return Date.parse(dueAt) - now.getTime();
}

export function isBreached(dueAt: string, now: Date = new Date()): boolean {
	return remainingMs(dueAt, now) < 0;
}
