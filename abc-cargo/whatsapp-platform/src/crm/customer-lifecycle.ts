/**
 * The customer lifecycle, and why it is not the same thing as the lead
 * pipeline.
 *
 * The design package asks for New Lead → Hot Lead → Payment → Customer. The
 * platform already had new → qualified → quoted → negotiating → won/lost. They
 * looked like two answers to one question, and picking a winner was the
 * obvious move. It would have been wrong: they answer two different questions.
 *
 *   The **pipeline** is the state of a *deal*. It belongs to one enquiry, it
 *   ends, and a customer may have three of them open at once at different
 *   stages.
 *
 *   The **lifecycle** is the state of a *relationship*. There is exactly one
 *   per customer, it never really ends, and it is what a contact list, a
 *   segment and a report mean by "stage".
 *
 * Collapsing them loses real information. A long-standing trade account with a
 * new enquiry is a Customer *and* has a new lead; one field cannot say both.
 *
 * So both exist, and the lifecycle is **derived rather than stored**. Nobody
 * has to remember to move a customer along, which matters because the one
 * thing reliably true of a hand-maintained relationship stage is that it is
 * out of date. Every value below is computed from facts the platform already
 * records — leads, quotations, bookings, last contact — so it cannot drift,
 * and a wrong answer is a wrong rule rather than a stale click.
 */

import type { LeadStage, Milestone, QuotationStatus } from "./types.ts";
import { isLeadOpen } from "./lifecycle.ts";

/**
 * Where a relationship stands. Ordered from coldest to warmest, except for
 * the two terminal states at the end.
 */
export const CUSTOMER_STAGES = [
	/** Known to us, with no sign of interest yet. */
	"prospect",
	/** An open enquiry, not yet quoted. The design's "New Lead". */
	"lead",
	/** A live enquiry being actively worked. The design's "Hot Lead". */
	"engaged",
	/** A quotation they accepted, with no shipment yet. */
	"committed",
	/** At least one shipment booked. The design's "Customer". */
	"customer",
	/** More than one shipment: the relationship, not just the sale. */
	"repeat_customer",
	/** Was a customer, has gone quiet for longer than the threshold. */
	"dormant",
	/** Only ever enquired, and that enquiry was lost. */
	"lapsed",
] as const;

export type CustomerStage = (typeof CUSTOMER_STAGES)[number];

/** How a stage should read on a screen. */
export const CUSTOMER_STAGE_LABELS: Record<CustomerStage, string> = {
	prospect: "Prospect",
	lead: "New lead",
	engaged: "Active lead",
	committed: "Won, awaiting shipment",
	customer: "Customer",
	repeat_customer: "Repeat customer",
	dormant: "Dormant",
	lapsed: "Lapsed enquiry",
};

/**
 * Everything the derivation looks at. Deliberately plain data: the rule can
 * then be exercised without a database, and the same rule serves a single
 * customer record, a contact list and a report.
 */
export interface CustomerFacts {
	leads: { stage: LeadStage; updatedAt: string }[];
	quotations: { status: QuotationStatus; updatedAt: string }[];
	bookings: { milestone: Milestone; createdAt: string }[];
	/** Last time the customer said anything to us, on any channel. */
	lastInboundAt?: string | null;
}

export interface LifecycleThresholds {
	/** Days without contact or a booking before a customer reads as dormant. */
	dormantAfterDays: number;
	/** Days within which a lead counts as actively worked rather than merely open. */
	engagedWithinDays: number;
}

export const DEFAULT_THRESHOLDS: LifecycleThresholds = {
	dormantAfterDays: 180,
	engagedWithinDays: 30,
};

function daysBetween(from: string | null | undefined, to: Date): number {
	if (!from) return Number.POSITIVE_INFINITY;
	const parsed = Date.parse(from);
	if (!Number.isFinite(parsed)) return Number.POSITIVE_INFINITY;
	return (to.getTime() - parsed) / 86_400_000;
}

function mostRecent(values: (string | null | undefined)[]): string | null {
	let best: string | null = null;
	for (const value of values) {
		if (!value) continue;
		const parsed = Date.parse(value);
		if (!Number.isFinite(parsed)) continue;
		if (best === null || parsed > Date.parse(best)) best = value;
	}
	return best;
}

/**
 * Works out where a relationship stands.
 *
 * Read top to bottom: the first rule that matches wins, and they are ordered
 * so the strongest evidence is consulted first. Shipments beat quotations,
 * quotations beat enquiries, and an enquiry beats nothing at all — because a
 * customer who has shipped with us is a customer whatever else is open.
 */
export function deriveCustomerStage(
	facts: CustomerFacts,
	now: Date = new Date(),
	thresholds: LifecycleThresholds = DEFAULT_THRESHOLDS,
): CustomerStage {
	const bookings = facts.bookings ?? [];
	const leads = facts.leads ?? [];
	const quotations = facts.quotations ?? [];

	// Shipments are the strongest evidence there is: money and goods moved.
	if (bookings.length > 0) {
		const lastActivity = mostRecent([
			facts.lastInboundAt,
			...bookings.map((b) => b.createdAt),
			...leads.map((l) => l.updatedAt),
		]);
		// Dormancy is about the relationship going quiet, so an open enquiry
		// keeps it alive however old the last shipment is.
		const hasOpenLead = leads.some((lead) => isLeadOpen(lead.stage));
		if (
			!hasOpenLead &&
			daysBetween(lastActivity, now) > thresholds.dormantAfterDays
		) {
			return "dormant";
		}
		return bookings.length > 1 ? "repeat_customer" : "customer";
	}

	// Won on paper, nothing shipped yet. A real and useful state: it is the
	// list somebody should be chasing.
	if (quotations.some((q) => q.status === "accepted")) return "committed";
	if (leads.some((lead) => lead.stage === "won")) return "committed";

	const openLeads = leads.filter((lead) => isLeadOpen(lead.stage));
	if (openLeads.length > 0) {
		// "Engaged" is the design's Hot Lead, except that it is observed
		// rather than declared: a quotation out, or a negotiation running, or
		// simply a recently touched enquiry.
		const quoted = quotations.some(
			(q) => q.status === "sent" || q.status === "negotiating",
		);
		const working = openLeads.some(
			(lead) =>
				lead.stage === "quoted" ||
				lead.stage === "negotiating" ||
				lead.stage === "qualified",
		);
		const recent = openLeads.some(
			(lead) =>
				daysBetween(lead.updatedAt, now) <= thresholds.engagedWithinDays,
		);
		return quoted || working || recent ? "engaged" : "lead";
	}

	// Every enquiry closed without a win, and nothing ever shipped.
	if (leads.length > 0) return "lapsed";
	return "prospect";
}

/**
 * How warm the relationship is, as a number rather than a badge somebody
 * remembered to set.
 *
 * The design's "Hot Lead" is a stage an agent has to maintain by hand, which
 * means in practice it reflects whoever last tidied the list. This is computed
 * from what actually happened, so it is current by construction.
 *
 * Returns 0–100. It is a prompt for attention, not a probability: it ranks a
 * queue, and nothing downstream should treat it as a forecast.
 */
export function leadTemperature(
	facts: CustomerFacts,
	now: Date = new Date(),
): number {
	const leads = (facts.leads ?? []).filter((lead) => isLeadOpen(lead.stage));
	if (leads.length === 0) return 0;

	let score = 20; // an open enquiry at all

	// How far it has travelled.
	if (leads.some((l) => l.stage === "qualified")) score += 15;
	if (leads.some((l) => l.stage === "quoted")) score += 25;
	if (leads.some((l) => l.stage === "negotiating")) score += 30;

	// A quotation in the customer's hands.
	const quotations = facts.quotations ?? [];
	if (quotations.some((q) => q.status === "sent")) score += 10;
	if (quotations.some((q) => q.status === "negotiating")) score += 15;

	// Recency, which decays rather than cliff-edges: a week-old enquiry is
	// not cold, a two-month-old one mostly is.
	const touched = mostRecent([
		facts.lastInboundAt,
		...leads.map((l) => l.updatedAt),
	]);
	const age = daysBetween(touched, now);
	if (age <= 2) score += 20;
	else if (age <= 7) score += 12;
	else if (age <= 30) score += 4;
	else if (age > 60) score -= 20;

	// They have shipped before, so they are a known quantity.
	if ((facts.bookings ?? []).length > 0) score += 10;

	return Math.max(0, Math.min(100, score));
}

/** A reading of the temperature, for a screen that wants a word. */
export function temperatureBand(score: number): "hot" | "warm" | "cold" {
	if (score >= 70) return "hot";
	if (score >= 40) return "warm";
	return "cold";
}

/**
 * Both answers together, which is what a contact record actually needs.
 */
export interface LifecycleView {
	stage: CustomerStage;
	label: string;
	temperature: number;
	band: "hot" | "warm" | "cold";
}

export function lifecycleFor(
	facts: CustomerFacts,
	now: Date = new Date(),
	thresholds: LifecycleThresholds = DEFAULT_THRESHOLDS,
): LifecycleView {
	const stage = deriveCustomerStage(facts, now, thresholds);
	const temperature = leadTemperature(facts, now);
	return {
		stage,
		label: CUSTOMER_STAGE_LABELS[stage],
		temperature,
		band: temperatureBand(temperature),
	};
}
