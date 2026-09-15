/**
 * Data access for the commercial and service objects. All SQL for these
 * tables lives here, the same arrangement as the conversation repository,
 * so the schema can change in one place.
 */

import type {
	ActivityKind,
	ActivityRow,
	BookingRow,
	CallDirection,
	CallRow,
	CustomerRow,
	LeadRow,
	LeadStage,
	Milestone,
	QuotationRow,
	QuotationStatus,
	TicketPriority,
	TicketRow,
	TicketStatus,
	TicketType,
	TransportMode,
} from "./types.ts";
import { buildRef, type RefKind } from "./refs.ts";

export interface ListFilter {
	regionId?: string;
	customerId?: string;
	limit?: number;
}

function clampLimit(limit: number | undefined, fallback = 50): number {
	return Math.min(Math.max(limit ?? fallback, 1), 200);
}

export class CrmRepository {
	private readonly db: D1Database;

	constructor(db: D1Database) {
		this.db = db;
	}

	/* ------------------------------------------------------------ sequences */

	/**
	 * Reserves the next reference for a kind. D1 serialises writes to a
	 * database, so the read-modify-write below cannot interleave with another
	 * request against the same row.
	 */
	async nextRef(kind: RefKind, regionId?: string): Promise<string> {
		const row = await this.db
			.prepare(
				`UPDATE ref_sequences SET next_value = next_value + 1
				 WHERE kind = ?1 RETURNING next_value`,
			)
			.bind(kind)
			.first<{ next_value: number }>();
		if (!row) throw new Error(`no reference sequence for ${kind}`);
		// next_value now holds the value after increment, so the reserved
		// sequence for this caller is one less.
		return buildRef(kind, row.next_value - 1, regionId);
	}

	/* ------------------------------------------------------------ customers */

	async findCustomerByWaId(waId: string): Promise<CustomerRow | null> {
		return this.db
			.prepare(`SELECT * FROM customers WHERE wa_id = ?1`)
			.bind(waId)
			.first<CustomerRow>();
	}

	async getCustomer(id: string): Promise<CustomerRow | null> {
		return this.db
			.prepare(`SELECT * FROM customers WHERE id = ?1`)
			.bind(id)
			.first<CustomerRow>();
	}

	/**
	 * Finds the customer behind a WhatsApp id, creating a minimal record the
	 * first time someone messages us. A conversation should never be
	 * orphaned just because the person is not in the CRM yet.
	 */
	async ensureCustomerForWaId(input: {
		waId: string;
		displayName: string;
		regionId: string;
		now: string;
	}): Promise<CustomerRow> {
		const existing = await this.findCustomerByWaId(input.waId);
		if (existing) return existing;

		const id = `cus_${input.waId}`;
		await this.db
			.prepare(
				`INSERT OR IGNORE INTO customers
				   (id, display_name, wa_id, phone, region_id, account_type,
				    opt_in_marketing, created_at, updated_at)
				 VALUES (?1, ?2, ?3, ?3, ?4, 'prospect', 0, ?5, ?5)`,
			)
			.bind(id, input.displayName, input.waId, input.regionId, input.now)
			.run();

		const created = await this.findCustomerByWaId(input.waId);
		if (!created) throw new Error("failed to create customer");
		return created;
	}

	async listCustomers(filter: ListFilter): Promise<CustomerRow[]> {
		const params: unknown[] = [];
		let where = "";
		if (filter.regionId) {
			params.push(filter.regionId);
			where = `WHERE region_id = ?${params.length}`;
		}
		params.push(clampLimit(filter.limit));
		const { results } = await this.db
			.prepare(
				`SELECT * FROM customers ${where}
				 ORDER BY updated_at DESC LIMIT ?${params.length}`,
			)
			.bind(...params)
			.all<CustomerRow>();
		return results;
	}

	/* ---------------------------------------------------------------- leads */

	async createLead(input: {
		id: string;
		ref: string;
		customerId: string;
		regionId: string;
		conversationId?: string | null;
		source: string;
		origin?: string | null;
		destination?: string | null;
		mode?: TransportMode | null;
		estValue?: number | null;
		currency?: string | null;
		ownerAgentId?: string | null;
		now: string;
	}): Promise<void> {
		await this.db
			.prepare(
				`INSERT INTO leads
				   (id, ref, customer_id, region_id, conversation_id, source, origin,
				    destination, mode, stage, est_value, currency, owner_agent_id,
				    created_at, updated_at)
				 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'new', ?10, ?11, ?12, ?13, ?13)`,
			)
			.bind(
				input.id,
				input.ref,
				input.customerId,
				input.regionId,
				input.conversationId ?? null,
				input.source,
				input.origin ?? null,
				input.destination ?? null,
				input.mode ?? null,
				input.estValue ?? null,
				input.currency ?? null,
				input.ownerAgentId ?? null,
				input.now,
			)
			.run();
	}

	async getLead(id: string): Promise<LeadRow | null> {
		return this.db
			.prepare(`SELECT * FROM leads WHERE id = ?1 OR ref = ?1`)
			.bind(id)
			.first<LeadRow>();
	}

	async setLeadStage(
		id: string,
		stage: LeadStage,
		now: string,
		lostReason?: string | null,
	): Promise<void> {
		const closed = stage === "won" || stage === "lost";
		await this.db
			.prepare(
				`UPDATE leads
				 SET stage = ?2, lost_reason = COALESCE(?4, lost_reason),
				     closed_at = CASE WHEN ?5 = 1 THEN ?3 ELSE closed_at END,
				     updated_at = ?3
				 WHERE id = ?1`,
			)
			.bind(id, stage, now, lostReason ?? null, closed ? 1 : 0)
			.run();
	}

	async assignLead(
		id: string,
		agentId: string | null,
		now: string,
	): Promise<void> {
		await this.db
			.prepare(
				`UPDATE leads SET owner_agent_id = ?2, updated_at = ?3 WHERE id = ?1`,
			)
			.bind(id, agentId, now)
			.run();
	}

	async listLeads(
		filter: ListFilter & { stage?: LeadStage; openOnly?: boolean },
	): Promise<LeadRow[]> {
		const clauses: string[] = [];
		const params: unknown[] = [];
		if (filter.regionId) {
			params.push(filter.regionId);
			clauses.push(`region_id = ?${params.length}`);
		}
		if (filter.customerId) {
			params.push(filter.customerId);
			clauses.push(`customer_id = ?${params.length}`);
		}
		if (filter.stage) {
			params.push(filter.stage);
			clauses.push(`stage = ?${params.length}`);
		}
		if (filter.openOnly) clauses.push(`stage NOT IN ('won','lost')`);
		params.push(clampLimit(filter.limit));
		const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
		const { results } = await this.db
			.prepare(
				`SELECT * FROM leads ${where}
				 ORDER BY updated_at DESC LIMIT ?${params.length}`,
			)
			.bind(...params)
			.all<LeadRow>();
		return results;
	}

	/* ----------------------------------------------------------- quotations */

	async createQuotation(input: {
		id: string;
		ref: string;
		leadId?: string | null;
		customerId: string;
		regionId: string;
		origin: string;
		destination: string;
		mode: TransportMode;
		chargeableKg?: number | null;
		totalAmount: number;
		currency: string;
		validUntil?: string | null;
		now: string;
	}): Promise<void> {
		await this.db
			.prepare(
				`INSERT INTO quotations
				   (id, ref, lead_id, customer_id, region_id, origin, destination, mode,
				    chargeable_kg, total_amount, currency, status, valid_until,
				    created_at, updated_at)
				 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'draft', ?12, ?13, ?13)`,
			)
			.bind(
				input.id,
				input.ref,
				input.leadId ?? null,
				input.customerId,
				input.regionId,
				input.origin,
				input.destination,
				input.mode,
				input.chargeableKg ?? null,
				input.totalAmount,
				input.currency,
				input.validUntil ?? null,
				input.now,
			)
			.run();
	}

	async getQuotation(id: string): Promise<QuotationRow | null> {
		return this.db
			.prepare(`SELECT * FROM quotations WHERE id = ?1 OR ref = ?1`)
			.bind(id)
			.first<QuotationRow>();
	}

	async setQuotationStatus(
		id: string,
		status: QuotationStatus,
		now: string,
		sentChannel?: string | null,
	): Promise<void> {
		await this.db
			.prepare(
				`UPDATE quotations
				 SET status = ?2, sent_channel = COALESCE(?4, sent_channel), updated_at = ?3
				 WHERE id = ?1`,
			)
			.bind(id, status, now, sentChannel ?? null)
			.run();
	}

	async listQuotations(
		filter: ListFilter & { status?: QuotationStatus },
	): Promise<QuotationRow[]> {
		const clauses: string[] = [];
		const params: unknown[] = [];
		if (filter.regionId) {
			params.push(filter.regionId);
			clauses.push(`region_id = ?${params.length}`);
		}
		if (filter.customerId) {
			params.push(filter.customerId);
			clauses.push(`customer_id = ?${params.length}`);
		}
		if (filter.status) {
			params.push(filter.status);
			clauses.push(`status = ?${params.length}`);
		}
		params.push(clampLimit(filter.limit));
		const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
		const { results } = await this.db
			.prepare(
				`SELECT * FROM quotations ${where}
				 ORDER BY updated_at DESC LIMIT ?${params.length}`,
			)
			.bind(...params)
			.all<QuotationRow>();
		return results;
	}

	/* ------------------------------------------------------------- bookings */

	async createBooking(input: {
		id: string;
		ref: string;
		quotationId?: string | null;
		customerId: string;
		regionId: string;
		origin: string;
		destination: string;
		mode: TransportMode;
		pieces?: number | null;
		weightKg?: number | null;
		valueAmount?: number | null;
		currency?: string | null;
		now: string;
	}): Promise<void> {
		await this.db
			.prepare(
				`INSERT INTO bookings
				   (id, ref, quotation_id, customer_id, region_id, origin, destination,
				    mode, pieces, weight_kg, value_amount, currency, milestone,
				    milestone_at, created_at, updated_at)
				 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 'booked', ?13, ?13, ?13)`,
			)
			.bind(
				input.id,
				input.ref,
				input.quotationId ?? null,
				input.customerId,
				input.regionId,
				input.origin,
				input.destination,
				input.mode,
				input.pieces ?? null,
				input.weightKg ?? null,
				input.valueAmount ?? null,
				input.currency ?? null,
				input.now,
			)
			.run();
	}

	async getBooking(idOrRef: string): Promise<BookingRow | null> {
		return this.db
			.prepare(`SELECT * FROM bookings WHERE id = ?1 OR ref = ?1`)
			.bind(idOrRef)
			.first<BookingRow>();
	}

	async setBookingMilestone(
		id: string,
		milestone: Milestone,
		occurredAt: string,
		now: string,
	): Promise<void> {
		await this.db
			.prepare(
				`UPDATE bookings SET milestone = ?2, milestone_at = ?3, updated_at = ?4
				 WHERE id = ?1`,
			)
			.bind(id, milestone, occurredAt, now)
			.run();
	}

	/** Returns false when this milestone was already recorded. */
	async recordMilestoneEvent(input: {
		bookingId: string;
		milestone: Milestone;
		occurredAt: string;
		source: string;
		now: string;
	}): Promise<boolean> {
		const result = await this.db
			.prepare(
				`INSERT OR IGNORE INTO booking_milestones
				   (booking_id, milestone, occurred_at, source, created_at)
				 VALUES (?1, ?2, ?3, ?4, ?5)`,
			)
			.bind(
				input.bookingId,
				input.milestone,
				input.occurredAt,
				input.source,
				input.now,
			)
			.run();
		return (result.meta.changes ?? 0) > 0;
	}

	async listBookings(
		filter: ListFilter & { milestone?: Milestone; undelivered?: boolean },
	): Promise<BookingRow[]> {
		const clauses: string[] = [];
		const params: unknown[] = [];
		if (filter.regionId) {
			params.push(filter.regionId);
			clauses.push(`region_id = ?${params.length}`);
		}
		if (filter.customerId) {
			params.push(filter.customerId);
			clauses.push(`customer_id = ?${params.length}`);
		}
		if (filter.milestone) {
			params.push(filter.milestone);
			clauses.push(`milestone = ?${params.length}`);
		}
		if (filter.undelivered) clauses.push(`milestone <> 'delivered'`);
		params.push(clampLimit(filter.limit));
		const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
		const { results } = await this.db
			.prepare(
				`SELECT * FROM bookings ${where}
				 ORDER BY milestone_at ASC LIMIT ?${params.length}`,
			)
			.bind(...params)
			.all<BookingRow>();
		return results;
	}

	/* -------------------------------------------------------------- tickets */

	async createTicket(input: {
		id: string;
		ref: string;
		customerId: string;
		regionId: string;
		bookingId?: string | null;
		conversationId?: string | null;
		type: TicketType;
		subject: string;
		priority: TicketPriority;
		firstResponseDueAt: string;
		resolutionDueAt: string;
		ownerAgentId?: string | null;
		now: string;
	}): Promise<void> {
		await this.db
			.prepare(
				`INSERT INTO tickets
				   (id, ref, customer_id, region_id, booking_id, conversation_id, type,
				    subject, priority, status, owner_agent_id, first_response_due_at,
				    resolution_due_at, created_at, updated_at)
				 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'open', ?10, ?11, ?12, ?13, ?13)`,
			)
			.bind(
				input.id,
				input.ref,
				input.customerId,
				input.regionId,
				input.bookingId ?? null,
				input.conversationId ?? null,
				input.type,
				input.subject,
				input.priority,
				input.ownerAgentId ?? null,
				input.firstResponseDueAt,
				input.resolutionDueAt,
				input.now,
			)
			.run();
	}

	async getTicket(idOrRef: string): Promise<TicketRow | null> {
		return this.db
			.prepare(`SELECT * FROM tickets WHERE id = ?1 OR ref = ?1`)
			.bind(idOrRef)
			.first<TicketRow>();
	}

	async setTicketStatus(
		id: string,
		status: TicketStatus,
		now: string,
	): Promise<void> {
		const resolved = status === "resolved" || status === "closed";
		await this.db
			.prepare(
				`UPDATE tickets
				 SET status = ?2,
				     resolved_at = CASE WHEN ?4 = 1 THEN COALESCE(resolved_at, ?3) ELSE NULL END,
				     updated_at = ?3
				 WHERE id = ?1`,
			)
			.bind(id, status, now, resolved ? 1 : 0)
			.run();
	}

	/** Stamps the first agent response; later responses leave it unchanged. */
	async markTicketFirstResponse(id: string, now: string): Promise<void> {
		await this.db
			.prepare(
				`UPDATE tickets
				 SET first_response_at = COALESCE(first_response_at, ?2), updated_at = ?2
				 WHERE id = ?1`,
			)
			.bind(id, now)
			.run();
	}

	async assignTicket(
		id: string,
		agentId: string | null,
		now: string,
	): Promise<void> {
		await this.db
			.prepare(
				`UPDATE tickets SET owner_agent_id = ?2, updated_at = ?3 WHERE id = ?1`,
			)
			.bind(id, agentId, now)
			.run();
	}

	async listTickets(
		filter: ListFilter & {
			status?: TicketStatus;
			type?: TicketType;
			openOnly?: boolean;
		},
	): Promise<TicketRow[]> {
		const clauses: string[] = [];
		const params: unknown[] = [];
		if (filter.regionId) {
			params.push(filter.regionId);
			clauses.push(`region_id = ?${params.length}`);
		}
		if (filter.customerId) {
			params.push(filter.customerId);
			clauses.push(`customer_id = ?${params.length}`);
		}
		if (filter.status) {
			params.push(filter.status);
			clauses.push(`status = ?${params.length}`);
		}
		if (filter.type) {
			params.push(filter.type);
			clauses.push(`type = ?${params.length}`);
		}
		if (filter.openOnly) clauses.push(`status IN ('open','pending')`);
		params.push(clampLimit(filter.limit));
		const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
		// Soonest due first: the queue an agent should work top-down.
		const { results } = await this.db
			.prepare(
				`SELECT * FROM tickets ${where}
				 ORDER BY resolution_due_at ASC LIMIT ?${params.length}`,
			)
			.bind(...params)
			.all<TicketRow>();
		return results;
	}

	/* ---------------------------------------------------------------- calls */

	async recordCall(input: {
		id: string;
		customerId: string;
		regionId: string;
		direction: CallDirection;
		agentId?: string | null;
		startedAt: string;
		durationSeconds: number;
		outcome?: string | null;
		linkedType?: string | null;
		linkedId?: string | null;
		now: string;
	}): Promise<void> {
		await this.db
			.prepare(
				`INSERT INTO calls
				   (id, customer_id, region_id, direction, agent_id, started_at,
				    duration_seconds, outcome, linked_type, linked_id, created_at)
				 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
			)
			.bind(
				input.id,
				input.customerId,
				input.regionId,
				input.direction,
				input.agentId ?? null,
				input.startedAt,
				Math.max(0, Math.round(input.durationSeconds)),
				input.outcome ?? null,
				input.linkedType ?? null,
				input.linkedId ?? null,
				input.now,
			)
			.run();
	}

	async listCalls(filter: ListFilter): Promise<CallRow[]> {
		const clauses: string[] = [];
		const params: unknown[] = [];
		if (filter.regionId) {
			params.push(filter.regionId);
			clauses.push(`region_id = ?${params.length}`);
		}
		if (filter.customerId) {
			params.push(filter.customerId);
			clauses.push(`customer_id = ?${params.length}`);
		}
		params.push(clampLimit(filter.limit));
		const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
		const { results } = await this.db
			.prepare(
				`SELECT * FROM calls ${where}
				 ORDER BY started_at DESC LIMIT ?${params.length}`,
			)
			.bind(...params)
			.all<CallRow>();
		return results;
	}

	/* ----------------------------------------------------------- activities */

	async addActivity(input: {
		customerId: string;
		regionId: string;
		kind: ActivityKind;
		ref?: string | null;
		summary: string;
		detail?: string | null;
		actor?: string | null;
		occurredAt: string;
		now: string;
	}): Promise<void> {
		await this.db
			.prepare(
				`INSERT INTO activities
				   (customer_id, region_id, kind, ref, summary, detail, actor, occurred_at, created_at)
				 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
			)
			.bind(
				input.customerId,
				input.regionId,
				input.kind,
				input.ref ?? null,
				input.summary,
				input.detail ?? null,
				input.actor ?? null,
				input.occurredAt,
				input.now,
			)
			.run();
	}

	async listActivities(
		customerId: string,
		limit = 100,
	): Promise<ActivityRow[]> {
		const { results } = await this.db
			.prepare(
				`SELECT * FROM activities WHERE customer_id = ?1
				 ORDER BY occurred_at DESC, id DESC LIMIT ?2`,
			)
			.bind(customerId, clampLimit(limit, 100))
			.all<ActivityRow>();
		return results;
	}
}
