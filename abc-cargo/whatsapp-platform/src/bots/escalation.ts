/**
 * The fallback: what happens when a customer stops answering the bot.
 *
 * The screen designs put "fallback after 10m" on a bot step and the acceptance
 * note recorded that the runtime did not have it. Without it a half-finished
 * conversation sits at "which reference was that?" until the session expires a
 * day later and nobody ever looks at it. The customer, meanwhile, has
 * telephoned.
 *
 * Four decisions shape this file.
 *
 * **The timer runs in business minutes, not wall-clock.** A customer who is
 * asked a question at 22:55, five minutes before the desk closes, must not
 * trigger a fallback at 23:05 into an empty office. The clock pauses when the
 * region is shut and resumes when it opens, using the same calendar walk the
 * service targets use — so a 10-minute fallback set at 22:55 fires at 08:05
 * the next morning, which is when somebody can actually act on it.
 *
 * **A fallback escalates; it does not abandon.** The session ends `handover`,
 * not `expired`. That is a real change to the deflection figures and the right
 * one: a conversation a person picked up is an escalation, and counting it as
 * abandonment would flatter the bot for losing somebody quietly. Expect
 * `abandoned` to fall and `escalated` to rise once this is switched on.
 *
 * **Escalation is never silent about the service window.** If the 24-hour
 * window has closed by the time the fallback fires, the agent picking it up can
 * only open with an approved template. The decision says so rather than
 * leaving the agent to discover it when the send fails.
 *
 * **Tier 2 is a configured destination, not an invented org chart.** A step may
 * name the queue it escalates to; otherwise it goes to the region's own Tier 1
 * desk. Tier 2 is reached only when the flow asks for it, or when Tier 1 has
 * held the conversation past its own threshold — never because this module
 * guessed at a hierarchy ABC Cargo has not described.
 */

import type { RegionConfig } from "../regions.ts";
import { localClock, toMinutes } from "../business-hours.ts";
import type { BotEffect, BotSession, BotStep } from "./types.ts";
import { SESSION_TTL_HOURS } from "./runtime.ts";

const MINUTE = 60_000;
const DAY_MINUTES = 1440;

/** Guard against an unbounded walk when a calendar has no working days. */
const MAX_DAYS_SCANNED = 400;

/**
 * Default minutes of customer silence before a waiting step gives up.
 *
 * The designs say 10. It is here rather than inline so that changing ABC
 * Cargo's policy is one edit.
 */
export const DEFAULT_FALLBACK_MINUTES = 10;

/**
 * Business minutes a Tier 1 queue may hold an escalated conversation before
 * Tier 2 is offered. Deliberately long: this is a safety net, not a
 * performance target, and the service targets in `crm/sla-policy.ts` are what
 * measure the desk.
 */
export const TIER2_AFTER_MINUTES = 120;

export type EscalationTier = "tier1" | "tier2";

export interface FallbackDecision {
	/** Whether the conversation should go to a person now. */
	escalate: boolean;
	tier: EscalationTier;
	/** The queue to place it in, or null for the region's default desk. */
	queue: string | null;
	/** Business minutes the customer has been silent. */
	silentMinutes: number;
	/** Minutes still to wait, 0 once the threshold is passed. */
	remainingMinutes: number;
	/**
	 * True when the 24-hour service window has closed, so the agent can only
	 * open with an approved template.
	 */
	templateOnly: boolean;
	reason: FallbackReason;
}

export type FallbackReason =
	| "waiting"
	| "silent_too_long"
	| "tier1_held_too_long"
	| "not_waiting"
	| "already_ended"
	| "session_expired"
	| "customer_replied";

export interface FallbackInput {
	session: BotSession;
	/** The step the session is sitting on, if it still exists in the flow. */
	step: BotStep | null;
	region: RegionConfig;
	/** ISO instant the 24-hour service window closes, if it is open. */
	windowExpiresAt?: string | null;
	/** Set once a human has the conversation, to measure the Tier 2 threshold. */
	escalatedAt?: string | null;
	escalatedTier?: EscalationTier | null;
	/** Override the step's own setting; the step wins when it has one. */
	fallbackMinutes?: number;
	now: Date;
}

/**
 * Whether this waiting session should go to a person.
 *
 * Pure, so the sweep that calls it is a thin loop and the rule itself is
 * testable without a database or a clock.
 */
export function checkFallback(input: FallbackInput): FallbackDecision {
	const { session, step, region, now } = input;

	const idle = (
		reason: FallbackReason,
		silentMinutes = 0,
		remainingMinutes = 0,
	): FallbackDecision => ({
		escalate: false,
		tier: "tier1",
		queue: null,
		silentMinutes,
		remainingMinutes,
		templateOnly: false,
		reason,
	});

	if (session.endedAt !== null || session.endedReason !== null) {
		return idle("already_ended");
	}
	if (session.stepId === null) return idle("already_ended");

	// A step that no longer exists in the published flow cannot be waited on.
	// The session is stuck rather than idle, so it goes to a person.
	const waiting = step === null || step.kind === "ask" || step.kind === "menu";
	if (!waiting) return idle("not_waiting");

	const silentMinutes = businessMinutesBetween(
		region,
		new Date(Date.parse(session.updatedAt)),
		now,
	);

	// Past the session TTL the conversation itself has lapsed — the WhatsApp
	// window is gone and resuming reads as a machine with no memory of the
	// gap. Expiry wins over the fallback, so a sweep that has not run for a
	// day does not suddenly escalate yesterday's abandoned sessions onto a
	// desk as though they were live.
	const wallClockHours =
		(now.getTime() - Date.parse(session.updatedAt)) / 3_600_000;
	if (wallClockHours >= SESSION_TTL_HOURS) {
		return idle("session_expired", silentMinutes);
	}

	const threshold = resolveFallbackMinutes(step, input.fallbackMinutes);
	const templateOnly = !windowOpen(input.windowExpiresAt, now);

	// Already with Tier 1: the only question left is whether Tier 2 takes it.
	if (input.escalatedAt) {
		if (input.escalatedTier === "tier2") return idle("already_ended");
		const heldMinutes = businessMinutesBetween(
			region,
			new Date(Date.parse(input.escalatedAt)),
			now,
		);
		if (heldMinutes >= TIER2_AFTER_MINUTES) {
			return {
				escalate: true,
				tier: "tier2",
				queue: tier2Queue(region, step),
				silentMinutes,
				remainingMinutes: 0,
				templateOnly,
				reason: "tier1_held_too_long",
			};
		}
		return idle("waiting", silentMinutes, TIER2_AFTER_MINUTES - heldMinutes);
	}

	if (silentMinutes < threshold) {
		return idle("waiting", silentMinutes, threshold - silentMinutes);
	}

	return {
		escalate: true,
		tier: "tier1",
		queue: step && step.kind === "menu" ? null : queueFor(step),
		silentMinutes,
		remainingMinutes: 0,
		templateOnly,
		reason: "silent_too_long",
	};
}

/**
 * The effects of acting on a fallback decision.
 *
 * Returns the ended session and the handover effect, in the same shape a
 * normal turn produces, so the caller treats a timed-out conversation exactly
 * as it treats one the customer escalated by asking for a person.
 */
export function applyFallback(
	session: BotSession,
	decision: FallbackDecision,
	now: Date,
): { session: BotSession; effects: BotEffect[] } {
	if (!decision.escalate) return { session, effects: [] };

	const ended: BotSession = {
		...session,
		stepId: null,
		endedAt: now.toISOString(),
		endedReason: "handover",
		updatedAt: now.toISOString(),
	};

	return {
		session: ended,
		effects: [
			{
				kind: "handover",
				queue: decision.queue,
				reason: "handover",
				// The answers already collected travel with it, so the agent
				// does not open by asking the customer the same questions.
				slots: { ...session.slots },
			},
		],
	};
}

function resolveFallbackMinutes(
	step: BotStep | null,
	override: number | undefined,
): number {
	const fromStep =
		step && (step.kind === "ask" || step.kind === "menu")
			? step.fallbackMinutes
			: undefined;
	const candidate = fromStep ?? override ?? DEFAULT_FALLBACK_MINUTES;
	if (!Number.isFinite(candidate) || candidate <= 0) {
		return DEFAULT_FALLBACK_MINUTES;
	}
	return Math.round(candidate);
}

function queueFor(step: BotStep | null): string | null {
	if (step && step.kind === "handover") return step.queue ?? null;
	return null;
}

/**
 * Tier 2's queue name.
 *
 * Derived from the region rather than configured globally, because the three
 * numbers front three operations and a single "tier 2" desk spanning them is
 * not something ABC Cargo has described. A step may still name one explicitly.
 */
function tier2Queue(region: RegionConfig, step: BotStep | null): string {
	const named = step && step.kind === "handover" ? step.queue : null;
	return named ?? `${region.id}-tier2`;
}

function windowOpen(expiresAt: string | null | undefined, now: Date): boolean {
	if (!expiresAt) return false;
	const t = Date.parse(expiresAt);
	return Number.isFinite(t) && t > now.getTime();
}

/* ------------------------------------------------------- business minutes */

/**
 * Business minutes elapsed between two instants on a region's calendar.
 *
 * The inverse of `addBusinessMinutes` in `crm/sla.ts`, and the reason the
 * fallback timer can pause overnight. Walks day by day in the region's own
 * timezone, summing each day's overlap between the open window and the
 * interval asked about, so a Thursday-evening question and a Sunday-morning
 * sweep produce the minutes the desk was actually open in between rather than
 * the sixty hours on the wall.
 *
 * Returns 0 rather than a negative number when `to` precedes `from`: a clock
 * that has gone backwards is a bug elsewhere, and a negative idle time would
 * silently disable the fallback.
 */
export function businessMinutesBetween(
	region: RegionConfig,
	from: Date,
	to: Date,
): number {
	if (!(from instanceof Date) || !(to instanceof Date)) return 0;
	if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime())) {
		return 0;
	}
	if (to.getTime() <= from.getTime()) return 0;

	const { days, start, end } = region.businessHours;
	if (days.length === 0) return 0;
	const openAt = toMinutes(start);
	const closeAt = toMinutes(end);
	if (closeAt <= openAt) return 0;

	let total = 0;
	let cursor = new Date(from.getTime());

	for (let guard = 0; guard <= MAX_DAYS_SCANNED; guard++) {
		if (cursor.getTime() >= to.getTime()) break;

		const { weekday, minutes } = localClock(cursor, region.timezone);

		if (!days.includes(weekday)) {
			cursor = nextLocalMidnight(cursor, minutes);
			continue;
		}

		// The instants this local day's window opens and closes, expressed
		// relative to the cursor so the timezone offset is already applied.
		const openInstant = cursor.getTime() + (openAt - minutes) * MINUTE;
		const closeInstant = cursor.getTime() + (closeAt - minutes) * MINUTE;

		const segmentStart = Math.max(
			openInstant,
			cursor.getTime(),
			from.getTime(),
		);
		const segmentEnd = Math.min(closeInstant, to.getTime());
		if (segmentEnd > segmentStart) {
			total += (segmentEnd - segmentStart) / MINUTE;
		}

		cursor = nextLocalMidnight(cursor, minutes);
	}

	return Math.floor(total);
}

function nextLocalMidnight(cursor: Date, localMinutes: number): Date {
	return new Date(cursor.getTime() + (DAY_MINUTES - localMinutes) * MINUTE);
}
