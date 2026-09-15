/**
 * Orchestration for the commercial and service side.
 *
 * Every operation that changes a record also writes one activity, so
 * Customer 360 is complete by construction rather than by remembering to
 * log. Nothing here talks to Meta directly: sending is the conversation
 * Durable Object's job, and this layer returns what should be sent.
 */

import type { RegionConfig } from "../regions.ts";
import { CrmRepository } from "./repo.ts";
import {
	assertLeadTransition,
	assertMilestoneAdvance,
	assertQuotationTransition,
	checkStall,
	leadStageForQuotation,
	templateForMilestone,
} from "./lifecycle.ts";
import { ticketDueDates } from "./sla.ts";
import { classifyIntent, outcomeFor, ticketTypeFor } from "./intent.ts";
import type {
	BookingRow,
	CallDirection,
	CustomerRow,
	LeadRow,
	LeadStage,
	Milestone,
	QuotationRow,
	QuotationStatus,
	TicketPriority,
	TicketRow,
	TicketType,
	TransportMode,
} from "./types.ts";

/** A proactive message the caller should send once the write has committed. */
export interface PendingNotification {
	customerId: string;
	regionId: string;
	waId: string | null;
	templateName: string;
	reason: string;
	bookingRef?: string;
}

export interface IntentHandling {
	customer: CustomerRow;
	intent: ReturnType<typeof classifyIntent>;
	lead: LeadRow | null;
	ticket: TicketRow | null;
	/** The booking a reference in the message pointed at, if we hold it. */
	booking: BookingRow | null;
}

function id(prefix: string): string {
	return `${prefix}_${crypto.randomUUID()}`;
}

export class CrmService {
	private readonly repo: CrmRepository;

	constructor(db: D1Database) {
		this.repo = new CrmRepository(db);
	}

	get repository(): CrmRepository {
		return this.repo;
	}

	/* ------------------------------------------------- inbound message entry */

	/**
	 * Called for every inbound customer message. Classifies the intent and
	 * creates the record the intent implies — a rate enquiry becomes a lead
	 * before an agent is free, a claim becomes a ticket with its clock
	 * already running.
	 *
	 * Idempotent in the sense that it will not open a second ticket of the
	 * same type while one is still open for the customer, nor a second lead
	 * while one is still in play.
	 */
	async handleInboundMessage(input: {
		waId: string;
		profileName?: string;
		region: RegionConfig;
		conversationId: string;
		text?: string;
		occurredAt: string;
		now?: Date;
	}): Promise<IntentHandling> {
		const now = input.now ?? new Date();
		const nowIso = now.toISOString();
		const regionId = input.region.id;

		const customer = await this.repo.ensureCustomerForWaId({
			waId: input.waId,
			displayName: input.profileName?.trim() || input.waId,
			regionId,
			now: nowIso,
		});

		const intent = classifyIntent(input.text);

		await this.repo.addActivity({
			customerId: customer.id,
			regionId,
			kind: "whatsapp",
			summary: `Inbound WhatsApp · ${intent.intent}`,
			detail: input.text ?? null,
			actor: "customer",
			occurredAt: input.occurredAt,
			now: nowIso,
		});

		// Attach the message to a booking when the customer quoted a reference.
		let booking: BookingRow | null = null;
		for (const ref of intent.references) {
			booking = await this.repo.getBooking(ref);
			if (booking) break;
		}

		const outcome = outcomeFor(intent.intent);
		let lead: LeadRow | null = null;
		let ticket: TicketRow | null = null;

		if (outcome === "lead") {
			lead = await this.openLeadIfNoneOpen({
				customer,
				regionId,
				conversationId: input.conversationId,
				source: "whatsapp_bot",
				now,
			});
		} else if (outcome === "ticket") {
			const type = ticketTypeFor(intent.intent);
			ticket = await this.openTicketIfNoneOpen({
				customer,
				region: input.region,
				type,
				subject: summarise(input.text) || `${type} raised on WhatsApp`,
				priority: type === "claim" ? "high" : "normal",
				bookingId: booking?.id ?? null,
				conversationId: input.conversationId,
				now,
			});
		}

		return { customer, intent, lead, ticket, booking };
	}

	/* ---------------------------------------------------------------- leads */

	async openLeadIfNoneOpen(input: {
		customer: CustomerRow;
		regionId: string;
		conversationId?: string | null;
		source: string;
		mode?: TransportMode | null;
		origin?: string | null;
		destination?: string | null;
		estValue?: number | null;
		currency?: string | null;
		now?: Date;
	}): Promise<LeadRow> {
		const open = await this.repo.listLeads({
			customerId: input.customer.id,
			openOnly: true,
			limit: 1,
		});
		const existing = open[0];
		if (existing) return existing;

		const now = input.now ?? new Date();
		const nowIso = now.toISOString();
		const leadId = id("lead");
		const ref = await this.repo.nextRef("lead");

		await this.repo.createLead({
			id: leadId,
			ref,
			customerId: input.customer.id,
			regionId: input.regionId,
			conversationId: input.conversationId ?? null,
			source: input.source,
			origin: input.origin ?? null,
			destination: input.destination ?? null,
			mode: input.mode ?? null,
			estValue: input.estValue ?? null,
			currency: input.currency ?? null,
			now: nowIso,
		});

		await this.repo.addActivity({
			customerId: input.customer.id,
			regionId: input.regionId,
			kind: "lead",
			ref,
			summary: `Lead ${ref} created from ${input.source.replace(/_/g, " ")}`,
			detail: null,
			actor: "system",
			occurredAt: nowIso,
			now: nowIso,
		});

		const created = await this.repo.getLead(leadId);
		if (!created) throw new Error("failed to create lead");
		return created;
	}

	async advanceLead(
		leadIdOrRef: string,
		to: LeadStage,
		actor: string,
		lostReason?: string,
		now: Date = new Date(),
	): Promise<LeadRow> {
		const lead = await this.repo.getLead(leadIdOrRef);
		if (!lead) throw new Error(`lead ${leadIdOrRef} not found`);
		assertLeadTransition(lead.stage, to);

		const nowIso = now.toISOString();
		await this.repo.setLeadStage(lead.id, to, nowIso, lostReason ?? null);
		await this.repo.addActivity({
			customerId: lead.customer_id,
			regionId: lead.region_id,
			kind: "lead",
			ref: lead.ref,
			summary: `Lead ${lead.ref} moved to ${to}`,
			detail: lostReason ?? null,
			actor,
			occurredAt: nowIso,
			now: nowIso,
		});

		const updated = await this.repo.getLead(lead.id);
		if (!updated) throw new Error("lead vanished during update");
		return updated;
	}

	/* ----------------------------------------------------------- quotations */

	async createQuotation(input: {
		leadIdOrRef?: string;
		customerId: string;
		regionId: string;
		origin: string;
		destination: string;
		mode: TransportMode;
		chargeableKg?: number | null;
		totalAmount: number;
		currency: string;
		validUntil?: string | null;
		actor: string;
		now?: Date;
	}): Promise<QuotationRow> {
		const now = input.now ?? new Date();
		const nowIso = now.toISOString();
		const lead = input.leadIdOrRef
			? await this.repo.getLead(input.leadIdOrRef)
			: null;

		const quotationId = id("quo");
		const ref = await this.repo.nextRef("quotation");
		await this.repo.createQuotation({
			id: quotationId,
			ref,
			leadId: lead?.id ?? null,
			customerId: input.customerId,
			regionId: input.regionId,
			origin: input.origin,
			destination: input.destination,
			mode: input.mode,
			chargeableKg: input.chargeableKg ?? null,
			totalAmount: input.totalAmount,
			currency: input.currency,
			validUntil: input.validUntil ?? null,
			now: nowIso,
		});

		await this.repo.addActivity({
			customerId: input.customerId,
			regionId: input.regionId,
			kind: "quotation",
			ref,
			summary: `Quotation ${ref} drafted — ${input.origin} to ${input.destination}`,
			detail: `${input.totalAmount} ${input.currency}`,
			actor: input.actor,
			occurredAt: nowIso,
			now: nowIso,
		});

		const created = await this.repo.getQuotation(quotationId);
		if (!created) throw new Error("failed to create quotation");
		return created;
	}

	/**
	 * Moves a quotation and keeps its lead in step. Accepting a quotation is
	 * what wins the lead; it does not have to be done twice by hand.
	 */
	async moveQuotation(input: {
		quotationIdOrRef: string;
		to: QuotationStatus;
		actor: string;
		sentChannel?: string;
		now?: Date;
	}): Promise<QuotationRow> {
		const quotation = await this.repo.getQuotation(input.quotationIdOrRef);
		if (!quotation)
			throw new Error(`quotation ${input.quotationIdOrRef} not found`);
		assertQuotationTransition(quotation.status, input.to);

		const now = input.now ?? new Date();
		const nowIso = now.toISOString();
		await this.repo.setQuotationStatus(
			quotation.id,
			input.to,
			nowIso,
			input.sentChannel ?? null,
		);
		await this.repo.addActivity({
			customerId: quotation.customer_id,
			regionId: quotation.region_id,
			kind: "quotation",
			ref: quotation.ref,
			summary: `Quotation ${quotation.ref} ${input.to}`,
			detail: input.sentChannel ? `sent on ${input.sentChannel}` : null,
			actor: input.actor,
			occurredAt: nowIso,
			now: nowIso,
		});

		const impliedStage = leadStageForQuotation(input.to);
		if (impliedStage && quotation.lead_id) {
			const lead = await this.repo.getLead(quotation.lead_id);
			if (lead && lead.stage !== impliedStage) {
				try {
					await this.advanceLead(
						lead.id,
						impliedStage,
						input.actor,
						undefined,
						now,
					);
				} catch {
					// A lead already closed by hand should not block the quotation.
				}
			}
		}

		const updated = await this.repo.getQuotation(quotation.id);
		if (!updated) throw new Error("quotation vanished during update");
		return updated;
	}

	/** Turns an accepted quotation into the booking that follows from it. */
	async createBookingFromQuotation(input: {
		quotationIdOrRef: string;
		pieces?: number | null;
		weightKg?: number | null;
		actor: string;
		now?: Date;
	}): Promise<BookingRow> {
		const quotation = await this.repo.getQuotation(input.quotationIdOrRef);
		if (!quotation)
			throw new Error(`quotation ${input.quotationIdOrRef} not found`);
		if (quotation.status !== "accepted") {
			throw new Error(
				`quotation ${quotation.ref} must be accepted before a booking is created`,
			);
		}

		const now = input.now ?? new Date();
		const nowIso = now.toISOString();
		const bookingId = id("bkg");
		const ref = await this.repo.nextRef("booking", quotation.region_id);

		await this.repo.createBooking({
			id: bookingId,
			ref,
			quotationId: quotation.id,
			customerId: quotation.customer_id,
			regionId: quotation.region_id,
			origin: quotation.origin,
			destination: quotation.destination,
			mode: quotation.mode,
			pieces: input.pieces ?? null,
			weightKg: input.weightKg ?? quotation.chargeable_kg,
			valueAmount: quotation.total_amount,
			currency: quotation.currency,
			now: nowIso,
		});
		await this.repo.recordMilestoneEvent({
			bookingId,
			milestone: "booked",
			occurredAt: nowIso,
			source: "api",
			now: nowIso,
		});
		await this.repo.addActivity({
			customerId: quotation.customer_id,
			regionId: quotation.region_id,
			kind: "booking",
			ref,
			summary: `Booking ${ref} created from quotation ${quotation.ref}`,
			detail: `${quotation.origin} to ${quotation.destination}, ${quotation.mode}`,
			actor: input.actor,
			occurredAt: nowIso,
			now: nowIso,
		});

		const created = await this.repo.getBooking(bookingId);
		if (!created) throw new Error("failed to create booking");
		return created;
	}

	/* ------------------------------------------------------------ milestones */

	/**
	 * Records a shipment milestone. Returns the proactive message the
	 * customer should receive, so the caller sends it only after the write
	 * has committed and never sends one twice for the same milestone.
	 */
	async recordMilestone(input: {
		bookingIdOrRef: string;
		milestone: Milestone;
		occurredAt?: string;
		source?: string;
		actor: string;
		now?: Date;
	}): Promise<{ booking: BookingRow; notify: PendingNotification | null }> {
		const booking = await this.repo.getBooking(input.bookingIdOrRef);
		if (!booking) throw new Error(`booking ${input.bookingIdOrRef} not found`);
		assertMilestoneAdvance(booking.milestone, input.milestone);

		const now = input.now ?? new Date();
		const nowIso = now.toISOString();
		const occurredAt = input.occurredAt ?? nowIso;

		const isNew = await this.repo.recordMilestoneEvent({
			bookingId: booking.id,
			milestone: input.milestone,
			occurredAt,
			source: input.source ?? "shipment_system",
			now: nowIso,
		});
		await this.repo.setBookingMilestone(
			booking.id,
			input.milestone,
			occurredAt,
			nowIso,
		);
		await this.repo.addActivity({
			customerId: booking.customer_id,
			regionId: booking.region_id,
			kind: "milestone",
			ref: booking.ref,
			summary: `${booking.ref} — ${input.milestone.replace(/_/g, " ")}`,
			detail: `${booking.origin} to ${booking.destination}`,
			actor: input.actor,
			occurredAt,
			now: nowIso,
		});

		const updated = await this.repo.getBooking(booking.id);
		if (!updated) throw new Error("booking vanished during update");

		const templateName = templateForMilestone(input.milestone);
		const customer = await this.repo.getCustomer(booking.customer_id);
		const notify: PendingNotification | null =
			isNew && templateName
				? {
						customerId: booking.customer_id,
						regionId: booking.region_id,
						waId: customer?.wa_id ?? null,
						templateName,
						reason: `milestone ${input.milestone}`,
						bookingRef: booking.ref,
					}
				: null;

		return { booking: updated, notify };
	}

	/**
	 * Finds shipments that have gone quiet and opens a ticket for each, so a
	 * stalled booking reaches an agent before the customer chases it. Meant
	 * to be driven by a scheduled handler.
	 */
	async sweepStalledBookings(
		regions: RegionConfig[],
		now: Date = new Date(),
		limit = 100,
	): Promise<TicketRow[]> {
		const byId = new Map(regions.map((r) => [r.id, r]));
		const candidates = await this.repo.listBookings({
			undelivered: true,
			limit,
		});
		const opened: TicketRow[] = [];

		for (const booking of candidates) {
			const region = byId.get(booking.region_id);
			if (!region) continue;
			const stall = checkStall(booking.milestone, booking.milestone_at, now);
			if (!stall.stalled) continue;

			const customer = await this.repo.getCustomer(booking.customer_id);
			if (!customer) continue;

			const ticket = await this.openTicketIfNoneOpen({
				customer,
				region,
				type: "delay",
				subject: `${booking.ref} has not moved since ${booking.milestone.replace(/_/g, " ")}`,
				priority: "high",
				bookingId: booking.id,
				conversationId: null,
				now,
			});
			// Only count tickets this sweep actually opened.
			if (ticket.created_at === now.toISOString()) opened.push(ticket);
		}
		return opened;
	}

	/* -------------------------------------------------------------- tickets */

	async openTicketIfNoneOpen(input: {
		customer: CustomerRow;
		region: RegionConfig;
		type: TicketType;
		subject: string;
		priority: TicketPriority;
		bookingId?: string | null;
		conversationId?: string | null;
		now?: Date;
	}): Promise<TicketRow> {
		const open = await this.repo.listTickets({
			customerId: input.customer.id,
			type: input.type,
			openOnly: true,
			limit: 1,
		});
		const existing = open[0];
		if (existing) return existing;

		const now = input.now ?? new Date();
		const nowIso = now.toISOString();
		const ticketId = id("tkt");
		const ref = await this.repo.nextRef("ticket");
		const due = ticketDueDates(input.region, input.type, input.priority, now);

		await this.repo.createTicket({
			id: ticketId,
			ref,
			customerId: input.customer.id,
			regionId: input.region.id,
			bookingId: input.bookingId ?? null,
			conversationId: input.conversationId ?? null,
			type: input.type,
			subject: input.subject,
			priority: input.priority,
			firstResponseDueAt: due.firstResponseDueAt,
			resolutionDueAt: due.resolutionDueAt,
			now: nowIso,
		});
		await this.repo.addActivity({
			customerId: input.customer.id,
			regionId: input.region.id,
			kind: "ticket",
			ref,
			summary: `Ticket ${ref} opened — ${input.type}`,
			detail: input.subject,
			actor: "system",
			occurredAt: nowIso,
			now: nowIso,
		});

		const created = await this.repo.getTicket(ticketId);
		if (!created) throw new Error("failed to create ticket");
		return created;
	}

	async resolveTicket(
		ticketIdOrRef: string,
		actor: string,
		now: Date = new Date(),
	): Promise<TicketRow> {
		const ticket = await this.repo.getTicket(ticketIdOrRef);
		if (!ticket) throw new Error(`ticket ${ticketIdOrRef} not found`);
		const nowIso = now.toISOString();
		await this.repo.setTicketStatus(ticket.id, "resolved", nowIso);
		await this.repo.addActivity({
			customerId: ticket.customer_id,
			regionId: ticket.region_id,
			kind: "ticket",
			ref: ticket.ref,
			summary: `Ticket ${ticket.ref} resolved`,
			detail: null,
			actor,
			occurredAt: nowIso,
			now: nowIso,
		});
		const updated = await this.repo.getTicket(ticket.id);
		if (!updated) throw new Error("ticket vanished during update");
		return updated;
	}

	/* ---------------------------------------------------------------- calls */

	async recordCall(input: {
		customerId: string;
		regionId: string;
		direction: CallDirection;
		agentId?: string | null;
		startedAt: string;
		durationSeconds: number;
		outcome?: string;
		linkedType?: string;
		linkedId?: string;
		now?: Date;
	}): Promise<void> {
		const now = input.now ?? new Date();
		const nowIso = now.toISOString();
		const callId = id("call");
		await this.repo.recordCall({
			id: callId,
			customerId: input.customerId,
			regionId: input.regionId,
			direction: input.direction,
			agentId: input.agentId ?? null,
			startedAt: input.startedAt,
			durationSeconds: input.durationSeconds,
			outcome: input.outcome ?? null,
			linkedType: input.linkedType ?? null,
			linkedId: input.linkedId ?? null,
			now: nowIso,
		});
		await this.repo.addActivity({
			customerId: input.customerId,
			regionId: input.regionId,
			kind: "call",
			ref: input.linkedId ?? null,
			summary: `${input.direction === "in" ? "Inbound" : "Outbound"} call · ${formatDuration(input.durationSeconds)}`,
			detail: input.outcome ?? null,
			actor: input.agentId ?? null,
			occurredAt: input.startedAt,
			now: nowIso,
		});
	}

	/* -------------------------------------------------------- customer view */

	/** Everything Customer 360 needs, in one call. */
	async customerView(customerId: string, activityLimit = 100) {
		const customer = await this.repo.getCustomer(customerId);
		if (!customer) return null;
		const [activities, leads, quotations, bookings, tickets, calls] =
			await Promise.all([
				this.repo.listActivities(customerId, activityLimit),
				this.repo.listLeads({ customerId, limit: 50 }),
				this.repo.listQuotations({ customerId, limit: 50 }),
				this.repo.listBookings({ customerId, limit: 50 }),
				this.repo.listTickets({ customerId, limit: 50 }),
				this.repo.listCalls({ customerId, limit: 50 }),
			]);
		return {
			customer,
			activities,
			leads,
			quotations,
			bookings,
			tickets,
			calls,
		};
	}
}

function summarise(text: string | undefined, max = 120): string {
	const clean = (text ?? "").replace(/\s+/g, " ").trim();
	if (clean.length <= max) return clean;
	return `${clean.slice(0, max - 1)}…`;
}

function formatDuration(seconds: number): string {
	const s = Math.max(0, Math.round(seconds));
	const m = Math.floor(s / 60);
	return `${m}:${String(s % 60).padStart(2, "0")}`;
}
