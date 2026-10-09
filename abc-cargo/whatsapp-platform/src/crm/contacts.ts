/**
 * The contacts directory and the lifecycle board.
 *
 * Both answer the same question — where does each customer stand — so both are
 * built from one place. The contact list is that answer as rows; the board is
 * the same answer grouped into columns.
 *
 * The thing worth being careful about is how the lifecycle gets computed for a
 * page of contacts. It is derived from a customer's leads, quotations and
 * bookings, so the obvious implementation fetches those per customer: three
 * queries each, a hundred and fifty for a page of fifty. Instead the page of
 * customers is fetched once, and their leads, quotations and bookings are
 * fetched once each for the whole page and grouped in memory. Four queries,
 * whatever the page size.
 */

import type {
	CustomerRow,
	LeadStage,
	Milestone,
	QuotationStatus,
} from "./types.ts";
import {
	CUSTOMER_STAGES,
	CUSTOMER_STAGE_LABELS,
	lifecycleFor,
	type CustomerStage,
	type LifecycleView,
} from "./customer-lifecycle.ts";

export interface Contact {
	customer: CustomerRow;
	lifecycle: LifecycleView;
	counts: { leads: number; quotations: number; bookings: number };
}

export interface ContactQuery {
	/** Regions the caller may see. Empty means nothing is returned. */
	regionIds: string[];
	/** Matches the display name, phone, WhatsApp id or email. */
	search?: string | null;
	/** Only contacts at this derived stage. */
	stage?: CustomerStage | null;
	limit?: number;
}

export interface ContactPage {
	contacts: Contact[];
	/** How many were examined before the stage filter was applied. */
	scanned: number;
}

export interface BoardColumn {
	stage: CustomerStage;
	label: string;
	total: number;
	/** The warmest few, for a column that shows cards rather than a count. */
	top: Contact[];
}

export interface Board {
	regionIds: string[];
	generatedAt: string;
	columns: BoardColumn[];
}

export function isCustomerStage(value: string): value is CustomerStage {
	return (CUSTOMER_STAGES as readonly string[]).includes(value);
}

/**
 * D1 binds parameters one at a time, so a very long `IN` list will be
 * refused. Pages are chunked rather than trusted to be small.
 */
const CHUNK = 80;

function chunked<T>(values: T[], size = CHUNK): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < values.length; i += size) {
		out.push(values.slice(i, i + size));
	}
	return out;
}

// Typed as the domain values the columns hold. The schema constrains them and
// the rest of the repository layer trusts the database the same way, rather
// than re-validating every row on every read.
interface LeadLite {
	customer_id: string;
	stage: LeadStage;
	updated_at: string;
}
interface QuotationLite {
	customer_id: string;
	status: QuotationStatus;
	updated_at: string;
}
interface BookingLite {
	customer_id: string;
	milestone: Milestone;
	created_at: string;
}

/** Groups rows by their customer, so each contact can be assembled in one pass. */
function groupBy<T extends { customer_id: string }>(
	rows: T[],
): Map<string, T[]> {
	const map = new Map<string, T[]>();
	for (const row of rows) {
		const existing = map.get(row.customer_id);
		if (existing) existing.push(row);
		else map.set(row.customer_id, [row]);
	}
	return map;
}

export class Contacts {
	private readonly db: D1Database;

	constructor(db: D1Database) {
		this.db = db;
	}

	/**
	 * A page of contacts with their derived lifecycle.
	 *
	 * The stage filter is applied after derivation rather than in SQL, because
	 * the stage is not stored anywhere to filter on. That is the price of
	 * deriving it, and it is worth paying: a stored stage would be filterable
	 * and wrong.
	 */
	async list(
		query: ContactQuery,
		now: Date = new Date(),
	): Promise<ContactPage> {
		const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
		if (query.regionIds.length === 0) return { contacts: [], scanned: 0 };

		const customers = await this.customersFor(query, limit);
		if (customers.length === 0) return { contacts: [], scanned: 0 };

		const ids = customers.map((customer) => customer.id);
		const [leads, quotations, bookings] = await Promise.all([
			this.leadsFor(ids),
			this.quotationsFor(ids),
			this.bookingsFor(ids),
		]);

		const byLead = groupBy(leads);
		const byQuote = groupBy(quotations);
		const byBooking = groupBy(bookings);

		const contacts: Contact[] = customers.map((customer) => {
			const theirLeads = byLead.get(customer.id) ?? [];
			const theirQuotes = byQuote.get(customer.id) ?? [];
			const theirBookings = byBooking.get(customer.id) ?? [];
			return {
				customer,
				lifecycle: lifecycleFor(
					{
						leads: theirLeads.map((lead) => ({
							stage: lead.stage,
							updatedAt: lead.updated_at,
						})),
						quotations: theirQuotes.map((quotation) => ({
							status: quotation.status,
							updatedAt: quotation.updated_at,
						})),
						bookings: theirBookings.map((booking) => ({
							milestone: booking.milestone,
							createdAt: booking.created_at,
						})),
						lastInboundAt: customer.updated_at,
					},
					now,
				),
				counts: {
					leads: theirLeads.length,
					quotations: theirQuotes.length,
					bookings: theirBookings.length,
				},
			};
		});

		const filtered = query.stage
			? contacts.filter((contact) => contact.lifecycle.stage === query.stage)
			: contacts;

		return { contacts: filtered, scanned: contacts.length };
	}

	/**
	 * The lifecycle board: every stage as a column, with a count and the
	 * warmest few in each.
	 *
	 * Every stage appears even when empty. A board that hides its empty
	 * columns changes shape as the data moves, and a column that is missing
	 * reads as a stage that does not exist rather than one nobody is in.
	 */
	async board(
		regionIds: string[],
		options: { perColumn?: number; scan?: number } = {},
		now: Date = new Date(),
	): Promise<Board> {
		const perColumn = Math.min(Math.max(options.perColumn ?? 5, 1), 50);
		const { contacts } = await this.list(
			{ regionIds, limit: options.scan ?? 200 },
			now,
		);

		const columns: BoardColumn[] = CUSTOMER_STAGES.map((stage) => {
			const inStage = contacts.filter((c) => c.lifecycle.stage === stage);
			// Warmest first: the board is a queue, and the point of the
			// temperature is to say who to look at before anyone else.
			inStage.sort((a, b) => b.lifecycle.temperature - a.lifecycle.temperature);
			return {
				stage,
				label: CUSTOMER_STAGE_LABELS[stage],
				total: inStage.length,
				top: inStage.slice(0, perColumn),
			};
		});

		return { regionIds, generatedAt: now.toISOString(), columns };
	}

	/* ------------------------------------------------------------ queries */

	private async customersFor(
		query: ContactQuery,
		limit: number,
	): Promise<CustomerRow[]> {
		const out: CustomerRow[] = [];
		// One query per region rather than one with an IN list, so the region
		// index is used and a caller with one region pays for one region.
		for (const regionId of query.regionIds) {
			const params: unknown[] = [regionId];
			let where = "WHERE region_id = ?1";
			if (query.search?.trim()) {
				const term = `%${query.search.trim().toLowerCase()}%`;
				params.push(term);
				const p = params.length;
				where +=
					` AND (LOWER(display_name) LIKE ?${p}` +
					` OR LOWER(COALESCE(phone, '')) LIKE ?${p}` +
					` OR LOWER(COALESCE(email, '')) LIKE ?${p}` +
					` OR LOWER(COALESCE(wa_id, '')) LIKE ?${p})`;
			}
			params.push(limit);
			const { results } = await this.db
				.prepare(
					`SELECT * FROM customers ${where}
					 ORDER BY updated_at DESC LIMIT ?${params.length}`,
				)
				.bind(...params)
				.all<CustomerRow>();
			out.push(...(results ?? []));
		}
		// Across several regions the per-region limit over-fetches; trim once.
		out.sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
		return out.slice(0, limit);
	}

	private async leadsFor(ids: string[]): Promise<LeadLite[]> {
		return this.fetchLite<LeadLite>(
			ids,
			"SELECT customer_id, stage, updated_at FROM leads",
		);
	}

	private async quotationsFor(ids: string[]): Promise<QuotationLite[]> {
		return this.fetchLite<QuotationLite>(
			ids,
			"SELECT customer_id, status, updated_at FROM quotations",
		);
	}

	private async bookingsFor(ids: string[]): Promise<BookingLite[]> {
		return this.fetchLite<BookingLite>(
			ids,
			"SELECT customer_id, milestone, created_at FROM bookings",
		);
	}

	private async fetchLite<T>(ids: string[], select: string): Promise<T[]> {
		const out: T[] = [];
		for (const batch of chunked(ids)) {
			const placeholders = batch.map((_, i) => `?${i + 1}`).join(", ");
			const { results } = await this.db
				.prepare(`${select} WHERE customer_id IN (${placeholders})`)
				.bind(...batch)
				.all<T>();
			out.push(...(results ?? []));
		}
		return out;
	}
}
