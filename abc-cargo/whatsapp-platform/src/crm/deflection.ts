/**
 * Bot deflection, with the ambiguity left in rather than averaged away.
 *
 * The designed dashboard shows "41% deflected". The acceptance note recorded
 * that nothing measured it and that it needed a definition first. This is
 * that definition, and the awkward part of it is deliberate.
 *
 * The bot already records why each session ended — `SessionEndReason` — so
 * deflection does not need a new invented rule, only an honest mapping of
 * reasons the platform actually writes:
 *
 * - `completed` — the flow reached its end and no human sent a message.
 *   **Deflected.** The customer asked, the bot answered, nobody was needed.
 * - `handover`, `customer_asked_for_agent` — **escalated.** The bot did part
 *   of the work; a person finished it.
 * - `too_many_invalid_replies`, `flow_stuck` — **escalated.** The bot failed.
 *   Counting a failure as anything else is how a deflection rate becomes
 *   flattering.
 * - `expired` — the customer stopped replying mid-flow. **Abandoned**, and
 *   this is the honest category: we do not know whether they got what they
 *   needed and left satisfied, or gave up. Nobody can know that from the
 *   data, so it is reported as its own number and never folded into either
 *   of the other two.
 *
 * That last point is the whole design. A deflection rate of
 * `deflected / (deflected + escalated)` quietly treats every abandonment as
 * if it never happened, which inflates the figure by exactly the amount the
 * bot is failing silently. So `deflectionRate` divides by every session, and
 * `abandonmentRate` sits beside it. If management wants the flattering
 * version it is `deflected / (deflected + escalated)` and it is published
 * here as `rateExcludingAbandoned` with a name that says what it leaves out.
 *
 * One further correction the data forces: a session that ended `completed`
 * but where a human did in fact send a message is **not** deflected. The end
 * reason describes the bot's flow, not the conversation, and an agent who
 * stepped in after the flow finished still did the work.
 */

import type { SessionEndReason } from "../bots/types.ts";

export type DeflectionOutcome =
	| "deflected"
	| "escalated"
	| "abandoned"
	/** Still running. Counted nowhere until it ends. */
	| "in_progress";

export interface SessionOutcomeInput {
	endedReason: SessionEndReason | null;
	/** Whether any human message was sent in the conversation. */
	humanReplied: boolean;
	/** Whether the session has ended at all. */
	ended: boolean;
}

/**
 * Classifies one session.
 *
 * `humanReplied` overrides a `completed` flow, because the question being
 * answered is "did this need a person", and a person who sent a message
 * answered it.
 */
export function classifySession(input: SessionOutcomeInput): DeflectionOutcome {
	if (!input.ended || input.endedReason === null) return "in_progress";

	switch (input.endedReason) {
		case "completed":
			return input.humanReplied ? "escalated" : "deflected";
		case "handover":
		case "customer_asked_for_agent":
		case "too_many_invalid_replies":
		case "flow_stuck":
			return "escalated";
		case "expired":
			// A human who stepped in before the customer went quiet means this
			// was handled, not abandoned.
			return input.humanReplied ? "escalated" : "abandoned";
	}
}

export interface DeflectionSummary {
	deflected: number;
	escalated: number;
	abandoned: number;
	inProgress: number;
	/** Ended sessions: the denominator for the published rate. */
	resolved: number;
	/**
	 * Deflected over every ended session, including abandoned ones.
	 *
	 * This is the figure for the dashboard. Null when nothing has ended.
	 */
	deflectionRate: number | null;
	/**
	 * Deflected over deflected plus escalated, excluding abandoned.
	 *
	 * Higher, and named so that nobody can quote it without saying what it
	 * leaves out.
	 */
	rateExcludingAbandoned: number | null;
	abandonmentRate: number | null;
	/** Whether the rates may be published as figures. */
	reportable: boolean;
	note: string | null;
}

/** Below this many ended sessions a rate is a coincidence, not a measurement. */
export const MIN_REPORTABLE_SESSIONS = 20;

export function summariseDeflection(
	sessions: SessionOutcomeInput[],
	minSessions: number = MIN_REPORTABLE_SESSIONS,
): DeflectionSummary {
	let deflected = 0;
	let escalated = 0;
	let abandoned = 0;
	let inProgress = 0;

	for (const session of sessions) {
		switch (classifySession(session)) {
			case "deflected":
				deflected += 1;
				break;
			case "escalated":
				escalated += 1;
				break;
			case "abandoned":
				abandoned += 1;
				break;
			case "in_progress":
				inProgress += 1;
				break;
		}
	}

	const resolved = deflected + escalated + abandoned;
	const decided = deflected + escalated;
	const reportable = resolved >= minSessions;

	return {
		deflected,
		escalated,
		abandoned,
		inProgress,
		resolved,
		deflectionRate: resolved > 0 ? round(deflected / resolved) : null,
		rateExcludingAbandoned: decided > 0 ? round(deflected / decided) : null,
		abandonmentRate: resolved > 0 ? round(abandoned / resolved) : null,
		reportable,
		note: reportable
			? null
			: resolved === 0
				? "No completed bot sessions yet."
				: `${resolved} completed session${resolved === 1 ? "" : "s"} — too few to publish a rate (minimum ${minSessions}).`,
	};
}

function round(value: number): number {
	return Math.round(value * 1000) / 1000;
}

/**
 * The per-flow breakdown, so a flow that is failing can be found.
 *
 * An overall rate says the bot is doing well or badly; it never says which
 * flow to fix. This is what makes the figure actionable rather than a score.
 */
export function summariseByFlow(
	sessions: Array<SessionOutcomeInput & { flowId: string }>,
	minSessions: number = MIN_REPORTABLE_SESSIONS,
): Record<string, DeflectionSummary> {
	const byFlow = new Map<string, SessionOutcomeInput[]>();
	for (const session of sessions) {
		const list = byFlow.get(session.flowId);
		if (list) list.push(session);
		else byFlow.set(session.flowId, [session]);
	}
	const out: Record<string, DeflectionSummary> = {};
	for (const [flowId, list] of byFlow) {
		out[flowId] = summariseDeflection(list, minSessions);
	}
	return out;
}

/**
 * The step at which abandoned sessions stopped, most frequent first.
 *
 * Abandonment is the category nobody can interpret in aggregate, but it is
 * perfectly interpretable per step: if forty customers all went quiet at the
 * same question, the question is the problem.
 */
export function abandonmentHotspots(
	sessions: Array<SessionOutcomeInput & { lastStepId: string | null }>,
): Array<{ stepId: string; count: number }> {
	const counts = new Map<string, number>();
	for (const session of sessions) {
		if (classifySession(session) !== "abandoned") continue;
		const step = session.lastStepId;
		if (!step) continue;
		counts.set(step, (counts.get(step) ?? 0) + 1);
	}
	return [...counts.entries()]
		.map(([stepId, count]) => ({ stepId, count }))
		.sort((a, b) => b.count - a.count || a.stepId.localeCompare(b.stepId));
}
