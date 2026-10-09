/**
 * The rules that govern how a lead, a quotation and a shipment move.
 *
 * Kept free of I/O so the transitions can be tested exhaustively. A booking
 * milestone that jumps backwards, or a lead that is quoted before anyone
 * qualified it, is a data problem that should be rejected at the boundary
 * rather than discovered in a report three weeks later.
 */

import {
	LEAD_STAGES,
	MILESTONES,
	type LeadStage,
	type Milestone,
	type QuotationStatus,
} from "./types.ts";

/* -------------------------------------------------------------- lead stages */

const LEAD_TRANSITIONS: Record<LeadStage, readonly LeadStage[]> = {
	new: ["qualified", "lost"],
	qualified: ["quoted", "lost"],
	quoted: ["negotiating", "won", "lost"],
	negotiating: ["won", "lost"],
	won: [],
	lost: [],
};

export function canAdvanceLead(from: LeadStage, to: LeadStage): boolean {
	return LEAD_TRANSITIONS[from].includes(to);
}

export class InvalidTransitionError extends Error {
	constructor(what: string, from: string, to: string) {
		super(`${what} cannot move from ${from} to ${to}`);
		this.name = "InvalidTransitionError";
	}
}

export function assertLeadTransition(from: LeadStage, to: LeadStage): void {
	if (!canAdvanceLead(from, to)) {
		throw new InvalidTransitionError("lead", from, to);
	}
}

export function isLeadOpen(stage: LeadStage): boolean {
	return stage !== "won" && stage !== "lost";
}

export function leadStageIndex(stage: LeadStage): number {
	return LEAD_STAGES.indexOf(stage);
}

/* -------------------------------------------------------- quotation statuses */

const QUOTATION_TRANSITIONS: Record<
	QuotationStatus,
	readonly QuotationStatus[]
> = {
	draft: ["sent", "lost"],
	sent: ["negotiating", "accepted", "lost", "expired"],
	negotiating: ["accepted", "lost", "expired"],
	accepted: [],
	lost: [],
	expired: ["sent"],
};

export function canMoveQuotation(
	from: QuotationStatus,
	to: QuotationStatus,
): boolean {
	return QUOTATION_TRANSITIONS[from].includes(to);
}

export function assertQuotationTransition(
	from: QuotationStatus,
	to: QuotationStatus,
): void {
	if (!canMoveQuotation(from, to)) {
		throw new InvalidTransitionError("quotation", from, to);
	}
}

/** The lead stage implied by a quotation reaching a given status. */
export function leadStageForQuotation(
	status: QuotationStatus,
): LeadStage | null {
	switch (status) {
		case "sent":
			return "quoted";
		case "negotiating":
			return "negotiating";
		case "accepted":
			return "won";
		case "lost":
			return "lost";
		case "draft":
		case "expired":
			return null;
	}
}

/* -------------------------------------------------------------- milestones */

export function milestoneIndex(milestone: Milestone): number {
	return MILESTONES.indexOf(milestone);
}

/**
 * Milestones only move forward. A correction is a deliberate act with its
 * own audit entry, not something a late webhook should be able to do by
 * arriving out of order.
 */
export function canAdvanceMilestone(from: Milestone, to: Milestone): boolean {
	return milestoneIndex(to) > milestoneIndex(from);
}

export function assertMilestoneAdvance(from: Milestone, to: Milestone): void {
	if (!canAdvanceMilestone(from, to)) {
		throw new InvalidTransitionError("milestone", from, to);
	}
}

export function isDelivered(milestone: Milestone): boolean {
	return milestone === "delivered";
}

/**
 * How long a shipment may sit on each milestone before the silence is
 * itself the problem. Customs clearance legitimately takes days; a
 * collection that has not moved in two is a shipment nobody is watching.
 */
export const STALL_HOURS: Record<Milestone, number> = {
	booked: 48,
	collected: 24,
	departed: 72,
	in_transit: 72,
	arrived: 48,
	cleared: 24,
	delivered: Number.POSITIVE_INFINITY,
};

export interface StallCheck {
	stalled: boolean;
	hoursSinceMilestone: number;
	thresholdHours: number;
}

/**
 * A stalled shipment is the trigger that turns a quiet booking into an
 * after-sales ticket before the customer has to chase it.
 */
export function checkStall(
	milestone: Milestone,
	milestoneAt: string,
	now: Date = new Date(),
): StallCheck {
	const thresholdHours = STALL_HOURS[milestone];
	const since = Date.parse(milestoneAt);
	if (Number.isNaN(since)) {
		throw new Error("milestoneAt is not a valid ISO 8601 timestamp");
	}
	const hoursSinceMilestone = (now.getTime() - since) / 3_600_000;
	return {
		stalled:
			Number.isFinite(thresholdHours) && hoursSinceMilestone >= thresholdHours,
		hoursSinceMilestone: Number(hoursSinceMilestone.toFixed(2)),
		thresholdHours,
	};
}

/**
 * Milestones that are worth telling the customer about unprompted. The rest
 * are internal: a customer does not need a message when a shipment moves
 * from "departed" to "in transit".
 */
const NOTIFIABLE: ReadonlySet<Milestone> = new Set<Milestone>([
	"booked",
	"collected",
	"departed",
	"arrived",
	"cleared",
	"delivered",
]);

export function shouldNotifyCustomer(milestone: Milestone): boolean {
	return NOTIFIABLE.has(milestone);
}

/** Template name used for the proactive update at each milestone. */
export function templateForMilestone(milestone: Milestone): string | null {
	if (!shouldNotifyCustomer(milestone)) return null;
	return milestone === "delivered"
		? "abc_delivery_completed"
		: "abc_shipment_status_update";
}
