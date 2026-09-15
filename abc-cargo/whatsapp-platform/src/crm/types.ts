/**
 * Domain types for the commercial and service side of ABC Cargo Engage:
 * leads, quotations, bookings, tickets and calls, plus the activity stream
 * that gives a customer one history across every channel and record.
 */

export const LEAD_STAGES = [
	"new",
	"qualified",
	"quoted",
	"negotiating",
	"won",
	"lost",
] as const;
export type LeadStage = (typeof LEAD_STAGES)[number];

export const QUOTATION_STATUSES = [
	"draft",
	"sent",
	"negotiating",
	"accepted",
	"lost",
	"expired",
] as const;
export type QuotationStatus = (typeof QUOTATION_STATUSES)[number];

/**
 * Shipment milestones in the order they occur. The index is the progress,
 * so a milestone may never move backwards without an explicit correction.
 */
export const MILESTONES = [
	"booked",
	"collected",
	"departed",
	"in_transit",
	"arrived",
	"cleared",
	"delivered",
] as const;
export type Milestone = (typeof MILESTONES)[number];

export const TICKET_TYPES = [
	"claim",
	"delay",
	"billing",
	"documentation",
	"delivery",
	"general",
] as const;
export type TicketType = (typeof TICKET_TYPES)[number];

export const TICKET_STATUSES = [
	"open",
	"pending",
	"resolved",
	"closed",
] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const TICKET_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];

export const TRANSPORT_MODES = ["air", "sea_lcl", "sea_fcl", "road"] as const;
export type TransportMode = (typeof TRANSPORT_MODES)[number];

export const CALL_DIRECTIONS = ["in", "out"] as const;
export type CallDirection = (typeof CALL_DIRECTIONS)[number];

/** Every record kind that can appear on a customer's timeline. */
export const ACTIVITY_KINDS = [
	"whatsapp",
	"handover",
	"call",
	"lead",
	"quotation",
	"booking",
	"milestone",
	"ticket",
	"note",
] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

export interface CustomerRow {
	id: string;
	company_id: string | null;
	display_name: string;
	wa_id: string | null;
	phone: string | null;
	email: string | null;
	region_id: string;
	account_type: string | null;
	opt_in_marketing: number;
	created_at: string;
	updated_at: string;
}

export interface LeadRow {
	id: string;
	ref: string;
	customer_id: string;
	region_id: string;
	conversation_id: string | null;
	source: string;
	origin: string | null;
	destination: string | null;
	mode: TransportMode | null;
	stage: LeadStage;
	est_value: number | null;
	currency: string | null;
	owner_agent_id: string | null;
	lost_reason: string | null;
	closed_at: string | null;
	created_at: string;
	updated_at: string;
}

export interface QuotationRow {
	id: string;
	ref: string;
	lead_id: string | null;
	customer_id: string;
	region_id: string;
	origin: string;
	destination: string;
	mode: TransportMode;
	chargeable_kg: number | null;
	total_amount: number;
	currency: string;
	status: QuotationStatus;
	valid_until: string | null;
	sent_channel: string | null;
	created_at: string;
	updated_at: string;
}

export interface BookingRow {
	id: string;
	ref: string;
	quotation_id: string | null;
	customer_id: string;
	region_id: string;
	origin: string;
	destination: string;
	mode: TransportMode;
	pieces: number | null;
	weight_kg: number | null;
	value_amount: number | null;
	currency: string | null;
	milestone: Milestone;
	milestone_at: string;
	created_at: string;
	updated_at: string;
}

export interface TicketRow {
	id: string;
	ref: string;
	customer_id: string;
	region_id: string;
	booking_id: string | null;
	conversation_id: string | null;
	type: TicketType;
	subject: string;
	priority: TicketPriority;
	status: TicketStatus;
	owner_agent_id: string | null;
	first_response_due_at: string;
	resolution_due_at: string;
	first_response_at: string | null;
	resolved_at: string | null;
	created_at: string;
	updated_at: string;
}

export interface CallRow {
	id: string;
	customer_id: string;
	region_id: string;
	direction: CallDirection;
	agent_id: string | null;
	started_at: string;
	duration_seconds: number;
	outcome: string | null;
	linked_type: string | null;
	linked_id: string | null;
	created_at: string;
}

export interface ActivityRow {
	id: number;
	customer_id: string;
	region_id: string;
	kind: ActivityKind;
	ref: string | null;
	summary: string;
	detail: string | null;
	actor: string | null;
	occurred_at: string;
	created_at: string;
}
