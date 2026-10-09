/**
 * The rules that stand between a draft and thousands of customers.
 *
 * Pure functions over plain data, because these are the rules that most need
 * to be exercised without a database and the ones it would be worst to get
 * wrong. Every refusal carries a reason, so a refused send can be explained to
 * whoever pressed the button.
 *
 * The two that matter most:
 *
 * **Approval is a second person's act.** The author of a broadcast cannot
 * approve their own. This is deliberately an obstacle. The failure it prevents
 * — the wrong template, the wrong audience, a placeholder left in the text —
 * is not caught by anything else in the platform, and it is caught almost
 * every time by one other person reading it.
 *
 * **Approval attaches to a particular list and a particular message.** Change
 * either and the approval is void. An approved broadcast that can quietly
 * acquire recipients, or quietly change what it says, is the worst bug this
 * module could have.
 */

import type { Caller } from "../auth/policy.ts";
import type { BroadcastStatus } from "./types.ts";

export type BroadcastRefusal =
	| "wrong_region"
	| "suspended"
	| "insufficient_role"
	| "service_caller"
	| "not_a_draft"
	| "not_in_review"
	| "not_approved"
	| "already_finished"
	| "nothing_to_send"
	| "not_resolved"
	| "stale_resolution"
	| "own_broadcast"
	| "sending_disabled"
	| "bad_transition";

export type BroadcastDecision =
	| { allowed: true; reason: "ok" }
	| { allowed: false; reason: BroadcastRefusal; message: string };

const ALLOW: BroadcastDecision = { allowed: true, reason: "ok" };
const deny = (
	reason: BroadcastRefusal,
	message: string,
): BroadcastDecision => ({ allowed: false, reason, message });

/** The parts of a broadcast the rules below need. */
export interface BroadcastRef {
	id: string;
	regionId: string;
	status: BroadcastStatus;
	createdBy: string;
	/** Null until the audience has been written down. */
	resolvedAt: string | null;
	resolvedCount: number | null;
	approvedBy: string | null;
	approvedAt: string | null;
	/** Null until the first message goes out. */
	startedAt: string | null;
}

/**
 * A broadcast is composed by a supervisor, not an agent.
 *
 * An agent answers the customers in front of them; choosing what five thousand
 * of them are told is a different job with a different accountability, and the
 * design puts it with the people who carry that.
 *
 * A machine credential is refused outright. Nothing automated should be able to
 * compose a campaign, and a key in a configuration file that could would be an
 * odd thing to leave lying about.
 */
export function canComposeBroadcast(
	caller: Caller,
	regionId: string,
): BroadcastDecision {
	if (caller.kind === "service") {
		return deny(
			"service_caller",
			"a machine credential cannot compose a broadcast",
		);
	}
	if (caller.status !== "active") {
		return deny("suspended", "this account is suspended");
	}
	if (caller.role === "agent") {
		return deny(
			"insufficient_role",
			"composing a broadcast is a supervisor's decision",
		);
	}
	if (caller.role !== "master_admin" && !caller.regionIds.includes(regionId)) {
		return deny("wrong_region", "this broadcast belongs to another region");
	}
	return ALLOW;
}

/**
 * Approval: a second person, reading a resolved list.
 *
 * Each condition here has a specific failure behind it. Not in review — the
 * audience may still be being edited. Not resolved, or resolved to nobody —
 * there is no list to approve. Own broadcast — the author has already read it
 * and is the least likely person to notice what is wrong with it.
 */
export function canApproveBroadcast(
	caller: Caller,
	broadcast: BroadcastRef,
): BroadcastDecision {
	const may = canComposeBroadcast(caller, broadcast.regionId);
	if (!may.allowed) return may;
	// Narrowed by canComposeBroadcast, which refuses a service caller.
	const actorId = caller.kind === "user" ? caller.id : "";

	if (broadcast.status !== "review") {
		return deny(
			"not_in_review",
			`a broadcast is approved from review, and this one is ${broadcast.status}`,
		);
	}
	if (broadcast.resolvedAt === null) {
		return deny(
			"not_resolved",
			"the audience has not been resolved, so there is no list to approve",
		);
	}
	if ((broadcast.resolvedCount ?? 0) === 0) {
		return deny(
			"nothing_to_send",
			"the audience resolved to nobody; check the filters and the opt-in rule",
		);
	}
	if (broadcast.createdBy === actorId) {
		return deny(
			"own_broadcast",
			"a broadcast is approved by somebody other than its author; ask a colleague to read it",
		);
	}
	return ALLOW;
}

/**
 * Sending: approved, still approved, and switched on.
 *
 * `sendingEnabled` is a deployment-level switch that is off unless somebody
 * has set it. A platform that can message every customer the moment it is
 * deployed is one bad merge away from doing so.
 */
export function canSendBroadcast(input: {
	caller: Caller;
	broadcast: BroadcastRef;
	sendingEnabled: boolean;
}): BroadcastDecision {
	const may = canComposeBroadcast(input.caller, input.broadcast.regionId);
	if (!may.allowed) return may;

	if (!input.sendingEnabled) {
		return deny(
			"sending_disabled",
			"broadcast sending is switched off for this deployment",
		);
	}
	const { status } = input.broadcast;
	if (status === "sent" || status === "cancelled") {
		return deny("already_finished", `this broadcast is already ${status}`);
	}
	if (status !== "approved" && status !== "paused") {
		return deny(
			"not_approved",
			`a broadcast is sent once approved, and this one is ${status}`,
		);
	}
	if (input.broadcast.approvedBy === null) {
		return deny("not_approved", "this broadcast has not been approved");
	}
	return ALLOW;
}

/** Pausing and cancelling are available to anyone who could have sent it. */
export function canStopBroadcast(
	caller: Caller,
	broadcast: BroadcastRef,
): BroadcastDecision {
	const may = canComposeBroadcast(caller, broadcast.regionId);
	if (!may.allowed) return may;
	if (broadcast.status === "sent" || broadcast.status === "cancelled") {
		return deny(
			"already_finished",
			`this broadcast is already ${broadcast.status}`,
		);
	}
	return ALLOW;
}

/* --------------------------------------------------------------- lifecycle */

/**
 * The transitions a broadcast may make.
 *
 * Written out rather than inferred, so the ones that are deliberately absent
 * are visible: nothing returns from `sent` or `cancelled`, and nothing reaches
 * `sending` except from `approved` or `paused`.
 */
const TRANSITIONS: Record<BroadcastStatus, BroadcastStatus[]> = {
	draft: ["review", "cancelled"],
	review: ["draft", "approved", "cancelled"],
	approved: ["sending", "draft", "cancelled"],
	sending: ["paused", "sent", "cancelled"],
	paused: ["sending", "cancelled"],
	sent: [],
	cancelled: [],
};

export function canTransition(
	from: BroadcastStatus,
	to: BroadcastStatus,
): BroadcastDecision {
	if ((TRANSITIONS[from] ?? []).includes(to)) return ALLOW;
	return deny("bad_transition", `a broadcast cannot go from ${from} to ${to}`);
}

/**
 * What a change to the message or the audience does to an approval.
 *
 * Anything that alters who is messaged or what they are told sends the
 * broadcast back to draft and clears the approval. The alternative — editing
 * an approved broadcast in place — means the thing that was read by a second
 * person is not the thing that gets sent.
 */
export const APPROVAL_VOIDING_FIELDS = [
	"audience",
	"templateName",
	"languageCode",
	"components",
	"kind",
] as const;

export function voidsApproval(changedFields: string[]): boolean {
	return changedFields.some((field) =>
		(APPROVAL_VOIDING_FIELDS as readonly string[]).includes(field),
	);
}

/** Whether a resolved list is too old to approve against. */
export const RESOLUTION_FRESHNESS_HOURS = 48;

/**
 * A resolution ages: customers opt out, new ones arrive.
 *
 * Two days. Beyond that the list approved is not the list the filters would
 * produce now, and the difference includes people who have since asked not to
 * be contacted.
 */
export function resolutionIsFresh(
	resolvedAt: string | null,
	now: Date,
	hours = RESOLUTION_FRESHNESS_HOURS,
): boolean {
	if (!resolvedAt) return false;
	const at = Date.parse(resolvedAt);
	if (!Number.isFinite(at)) return false;
	const age = (now.getTime() - at) / 3_600_000;
	return age >= 0 && age < hours;
}

/**
 * Sending requires an approval, and — the first time — a list that has not
 * gone stale.
 *
 * The freshness test applies only to starting a broadcast, not to resuming a
 * paused one. Blocking a resume would strand a half-sent campaign: the
 * remaining recipients could then only be reached by building the whole thing
 * again, while the ones already messaged would have to be excluded by hand.
 *
 * What staleness actually risks is messaging somebody who has opted out since
 * the list was drawn up, and that is dealt with where it belongs — the sender
 * re-checks each recipient's opt-out immediately before sending to them. This
 * test is the coarser guard in front of it: a list drawn up last month should
 * be looked at again before anybody presses Send.
 */
export function checkReadyToSend(input: {
	caller: Caller;
	broadcast: BroadcastRef;
	sendingEnabled: boolean;
	now: Date;
}): BroadcastDecision {
	const may = canSendBroadcast(input);
	if (!may.allowed) return may;
	const resuming = input.broadcast.startedAt !== null;
	if (!resuming && !resolutionIsFresh(input.broadcast.resolvedAt, input.now)) {
		return deny(
			"stale_resolution",
			`the audience was resolved more than ${RESOLUTION_FRESHNESS_HOURS} hours ago; resolve it again before starting`,
		);
	}
	return ALLOW;
}

/**
 * Whether the audience may be resolved again.
 *
 * Only before the first message goes out. Re-resolving a broadcast that is
 * part-sent would mean reconciling a new list against the people already
 * messaged, and the obvious implementations of that either message somebody
 * twice or drop somebody silently. A part-sent campaign is paused, cancelled
 * or finished — not re-aimed.
 */
export function canResolveAudience(
	caller: Caller,
	broadcast: BroadcastRef,
): BroadcastDecision {
	const may = canComposeBroadcast(caller, broadcast.regionId);
	if (!may.allowed) return may;
	if (broadcast.startedAt !== null) {
		return deny(
			"already_finished",
			"this broadcast has started sending; its audience can no longer be changed",
		);
	}
	if (broadcast.status === "sent" || broadcast.status === "cancelled") {
		return deny(
			"already_finished",
			`this broadcast is already ${broadcast.status}`,
		);
	}
	return ALLOW;
}
